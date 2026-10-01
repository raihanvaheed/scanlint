#!/usr/bin/env python3
"""Extract the DICOM data dictionary (PS3.6 Tables 6-1, 7-1 and 8-1), and the transfer syntax
registry (PS3.6 Annex A, Table A-1), from the standard's published DocBook XML into three files:

  src/model/dictionary.json          shipped: tag -> { name, vr? }, plus repeating-group patterns
  fixtures/dictionary-keywords.json  test-only: tag -> keyword, kept out of the build graph
  src/pixels/transfer-syntaxes.json  shipped: every Table A-1 UID whose type is Transfer Syntax

Run by hand; CI does not run it. Python 3.9+, standard library only:
  python3 scripts/extract-dictionary.py [--out PATH] [--keywords-out PATH] [--transfer-syntaxes-out PATH] [--url URL]

Structure is checked strictly and the script exits non-zero on any surprise, so a changed
layout in a future edition fails here rather than writing bad data. Every row it cannot use
is reported, grouped by reason.

The edition is read from the document and compared with src/model/annex-e.json's. Two tables
from different editions can disagree silently, so a mismatch stops the script. Table A-1 comes
from the same fetched document and so is always the same edition as the dictionary tables by
construction; its own output file records that edition too, the same precedent 1.2 set for
src/model/annex-e.json.
"""

from __future__ import annotations

import argparse
import collections
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, List, NoReturn, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "src" / "model" / "dictionary.json"
DEFAULT_KEYWORDS_OUT = REPO_ROOT / "fixtures" / "dictionary-keywords.json"
DEFAULT_TRANSFER_SYNTAXES_OUT = REPO_ROOT / "src" / "pixels" / "transfer-syntaxes.json"
ANNEX_E_PATH = REPO_ROOT / "src" / "model" / "annex-e.json"
DEFAULT_URL = "https://dicom.nema.org/medical/dicom/current/source/docbook/part06/part06.xml"

TABLE_IDS = ["table_6-1", "table_7-1", "table_8-1"]
SOURCE_LABEL = "PS3.6 Tables 6-1, 7-1, 8-1"
SHIPPED_LIMIT = 500 * 1024

UID_TABLE_ID = "table_A-1"
UID_TRANSFER_SYNTAX_LIMIT = 50 * 1024

DB = "{http://docbook.org/ns/docbook}"
XML_ID = "{http://www.w3.org/XML/1998/namespace}id"
ZERO_WIDTH_SPACE = "\u200b"

CONCRETE_TAG = re.compile(r"^\(([0-9A-Fa-f]{4}),([0-9A-Fa-f]{4})\)$")
PATTERN_TAG = re.compile(r"^\(([0-9A-Fa-fx]{4}),([0-9A-Fa-fx]{4})\)$")
CONCRETE_UID = re.compile(r"^\d+(\.\d+)+$")
# The VR column holds this instead of a VR on a few rows whose VR depends on context.
NOT_A_VR = {"See Note"}

# Part 6 uses U+200B for two different things. Usually it marks where a space belongs, and the
# default is to replace it with one. Sometimes it only offers a line break inside a single
# compound word, and then it is stripped instead. No mechanical rule tells them apart (the
# keyword is joined either way), so each such name is decided by hand. The test: would the
# standard's own text write these fragments as one word? Add a tag here only with that reason.
JOINED_NAMES = {
    "0072000a",  # Hanging Protocol Creation DateTime: the VR is DT, and DateTime is one word
}

Skipped = Dict[str, List[str]]


def fail(message: str) -> NoReturn:
    raise SystemExit(f"extract-dictionary: {message}")


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "scanlint-extract-dictionary"})
    with urllib.request.urlopen(request, timeout=300) as response:
        return response.read()


def cell_text(cell: ET.Element) -> str:
    return re.sub(r"\s+", " ", "".join(cell.itertext())).strip()


def clean_name(text: str, tag: Optional[str] = None, *, join: Optional[bool] = None) -> str:
    """Names: U+200B is a line-break hint for the printed standard. By default it sits where a
    space belongs, so 'Generation<ZW>Mode' becomes two words. A tag in JOINED_NAMES is one word
    ('Date<ZW>Time'), so the hint is stripped. Whitespace is then collapsed and trimmed."""
    joined = (tag in JOINED_NAMES) if join is None else join
    return re.sub(r"\s+", " ", text.replace(ZERO_WIDTH_SPACE, "" if joined else " ")).strip()


def clean_keyword(text: str) -> str:
    """Keywords are identifiers, so the hint is dropped, never replaced with a space."""
    return text.replace(ZERO_WIDTH_SPACE, "").strip()


def read_table(root: ET.Element, table_id: str) -> List[List[str]]:
    tables = [t for t in root.iter(f"{DB}table") if t.get(XML_ID) == table_id]
    if len(tables) != 1:
        fail(f"expected one table with xml:id {table_id!r}, found {len(tables)}")
    table = tables[0]

    thead = table.find(f"{DB}thead")
    tbody = table.find(f"{DB}tbody")
    if thead is None or tbody is None or len(thead.findall(f"{DB}tr")) != 1:
        fail(f"{table_id}: expected one header row and a body")
    headers = [cell_text(th) for th in thead.iter(f"{DB}th")]
    if headers[:5] != ["Tag", "Name", "Keyword", "VR", "VM"] or len(headers) != 6:
        fail(f"{table_id}: unexpected header cells {headers}")

    rows: List[List[str]] = []
    for tr in tbody.findall(f"{DB}tr"):
        cells = tr.findall(f"{DB}td")
        if len(cells) != 6:
            fail(f"{table_id}: row with {len(cells)} cells: {[cell_text(c) for c in cells]}")
        rows.append([cell_text(c) for c in cells])
    return rows


def parse(root: ET.Element) -> Dict[str, Any]:
    subtitle = root.find(f"{DB}subtitle")
    match = re.search(r"PS3\.6\s+(\S+)\s+-", "".join(subtitle.itertext()) if subtitle is not None else "")
    if not match:
        fail("cannot read the edition from the document subtitle")

    attributes: Dict[str, Dict[str, str]] = {}
    patterns: List[Dict[str, str]] = []
    keywords_by_tag: Dict[str, str] = {}
    keywords_by_mask: Dict[str, str] = {}
    name_changes: List[Tuple[str, str, str, bool]] = []
    seen_masks: set = set()
    used_joined: set = set()
    skipped: Skipped = collections.defaultdict(list)
    counts: Dict[str, int] = {}
    notes: Dict[str, List[str]] = collections.defaultdict(list)

    for table_id in TABLE_IDS:
        rows = read_table(root, table_id)
        counts[table_id] = len(rows)
        for tag_cell, name_cell, keyword_cell, vr_cell, _vm, _marker in rows:
            concrete = CONCRETE_TAG.match(tag_cell)
            pattern = None if concrete else PATTERN_TAG.match(tag_cell)
            if not concrete and not (pattern and "x" in tag_cell[1:-1]):
                skipped["no parseable tag"].append(f"{table_id} {tag_cell!r} {clean_name(name_cell)!r}")
                continue
            tag_key = (concrete.group(1) + concrete.group(2)).lower() if concrete else None
            name = clean_name(name_cell, tag_key)
            if not name:
                skipped["no name"].append(f"{table_id} {tag_cell} (keyword {clean_keyword(keyword_cell)!r}, VR {vr_cell!r})")
                continue
            if ZERO_WIDTH_SPACE in name_cell:
                differs = clean_name(name_cell, join=False) != clean_name(name_cell, join=True)
                name_changes.append((tag_cell, name_cell.replace(ZERO_WIDTH_SPACE, "<ZW>"), name, differs))
                if tag_key in JOINED_NAMES:
                    used_joined.add(tag_key)

            entry: Dict[str, str] = {"name": name}
            keyword = clean_keyword(keyword_cell)
            if vr_cell in NOT_A_VR:
                notes["VR column holds 'See Note', so vr is omitted"].append(f"{table_id} {tag_cell} {name!r}")
            elif vr_cell:
                entry["vr"] = vr_cell
                if " or " in vr_cell:
                    notes["compound VR, stored as printed"].append(f"{tag_cell} {vr_cell!r}")
            if not keyword:
                notes["row supplies no keyword, so keyword is omitted"].append(f"{table_id} {tag_cell} {name!r}")
            if not vr_cell:
                notes["row supplies no VR, so vr is omitted"].append(f"{table_id} {tag_cell} {name!r}")

            if concrete:
                tag = (concrete.group(1) + concrete.group(2)).lower()
                if tag in attributes:
                    fail(f"duplicate tag {tag}")
                attributes[tag] = entry
                if keyword:
                    keywords_by_tag[tag] = keyword
            else:
                mask = (pattern.group(1) + pattern.group(2)).lower()
                if mask in seen_masks:
                    fail(f"duplicate pattern {tag_cell}")
                seen_masks.add(mask)
                patterns.append({"tagPattern": tag_cell, "match": "nibbleMask", "mask": mask, **entry})
                if keyword:
                    keywords_by_mask[mask] = keyword

    unused = JOINED_NAMES - used_joined
    if unused:
        fail(f"JOINED_NAMES lists tags whose names contain no U+200B (stale entry?): {sorted(unused)}")

    return {
        "edition": match.group(1),
        "attributes": {tag: attributes[tag] for tag in sorted(attributes)},
        "patterns": patterns,
        "keywordsByTag": {tag: keywords_by_tag[tag] for tag in sorted(keywords_by_tag)},
        "keywordsByMask": keywords_by_mask,
        "nameChanges": name_changes,
        "counts": counts,
        "skipped": skipped,
        "notes": notes,
    }


def clean_uid_field(text: str) -> str:
    """UID values and keywords in Table A-1 use U+200B purely as a line-break hint inside a dotted
    number or a run-together identifier - never standing in for a space a reader would type - so it
    is always stripped, never replaced. Unlike the attribute names in clean_name, there is no
    per-row judgement call here."""
    return text.replace(ZERO_WIDTH_SPACE, "").strip()


def parse_transfer_syntaxes(root: ET.Element, edition: str) -> Dict[str, Any]:
    """PS3.6 Annex A, Table A-1: the UID registry. Pulls out every row whose UID Type is
    'Transfer Syntax'. Checked as strictly as the dictionary tables - a changed column layout in a
    future edition must fail here, not silently produce a table with the wrong UIDs in it."""
    tables = [t for t in root.iter(f"{DB}table") if t.get(XML_ID) == UID_TABLE_ID]
    if len(tables) != 1:
        fail(f"expected one table with xml:id {UID_TABLE_ID!r}, found {len(tables)}")
    table = tables[0]

    thead = table.find(f"{DB}thead")
    tbody = table.find(f"{DB}tbody")
    if thead is None or tbody is None or len(thead.findall(f"{DB}tr")) != 1:
        fail(f"{UID_TABLE_ID}: expected one header row and a body")
    headers = [clean_uid_field(cell_text(th)) for th in thead.iter(f"{DB}th")]
    if headers != ["UID Value", "UID Name", "UID Keyword", "UID Type", "Part"]:
        fail(f"{UID_TABLE_ID}: unexpected header cells {headers}")

    transfer_syntaxes: Dict[str, Dict[str, str]] = {}
    total_rows = 0
    for tr in tbody.findall(f"{DB}tr"):
        cells = tr.findall(f"{DB}td")
        if len(cells) != 5:
            fail(f"{UID_TABLE_ID}: row with {len(cells)} cells: {[cell_text(c) for c in cells]}")
        total_rows += 1
        uid_cell, name_cell, _keyword_cell, type_cell, _part_cell = (cell_text(c) for c in cells)
        if clean_uid_field(type_cell) != "Transfer Syntax":
            continue

        uid = clean_uid_field(uid_cell)
        if not CONCRETE_UID.match(uid):
            fail(f"{UID_TABLE_ID}: Transfer Syntax row has an unparseable UID {uid_cell!r}")
        name = clean_name(name_cell, join=False)
        if ZERO_WIDTH_SPACE in name_cell:
            fail(f"{UID_TABLE_ID}: Transfer Syntax row {uid!r} has U+200B in its name {name_cell!r} - " "this table has never needed JOINED_NAMES-style handling; decide by hand before adding it.")
        if not name:
            fail(f"{UID_TABLE_ID}: Transfer Syntax row {uid!r} has no name")
        if uid in transfer_syntaxes:
            fail(f"{UID_TABLE_ID}: duplicate Transfer Syntax UID {uid}")
        transfer_syntaxes[uid] = {"name": name}

    return {
        "edition": edition,
        "totalRows": total_rows,
        "transferSyntaxes": {uid: transfer_syntaxes[uid] for uid in sorted(transfer_syntaxes)},
    }


def shape_of(mask: str) -> str:
    return re.sub(r"[0-9a-f]", "h", mask[:4]) + "," + re.sub(r"[0-9a-f]", "h", mask[4:])


def show(label: str, groups: Dict[str, List[str]]) -> None:
    for reason, items in groups.items():
        print(f"  {reason}: {len(items)}")
        for example in items[:3]:
            print(f"      e.g. {example}")
    if not groups:
        print(f"  {label}: none")


def main(argv: Optional[List[str]] = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output path (default: src/model/dictionary.json)")
    parser.add_argument("--keywords-out", type=Path, default=DEFAULT_KEYWORDS_OUT, help="test-only keywords path (default: fixtures/dictionary-keywords.json)")
    parser.add_argument(
        "--transfer-syntaxes-out", type=Path, default=DEFAULT_TRANSFER_SYNTAXES_OUT, help="transfer syntax registry path (default: src/pixels/transfer-syntaxes.json)"
    )
    parser.add_argument("--url", default=DEFAULT_URL, help="DocBook source URL")
    args = parser.parse_args(argv)

    root = ET.fromstring(fetch(args.url))
    parsed = parse(root)
    ts_parsed = parse_transfer_syntaxes(root, parsed["edition"])

    if ANNEX_E_PATH.exists():
        annex_edition = json.loads(ANNEX_E_PATH.read_text(encoding="utf-8"))["source"]["edition"]
        if annex_edition != parsed["edition"]:
            fail(
                f"edition mismatch: PS3.6 is {parsed['edition']!r} but annex-e.json is {annex_edition!r}. "
                "Not writing anything; two tables from different editions can disagree silently."
            )
    else:
        annex_edition = None

    output = {
        "edition": parsed["edition"],
        "source": SOURCE_LABEL,
        "attributes": parsed["attributes"],
        "patterns": parsed["patterns"],
    }
    keywords = {
        "edition": parsed["edition"],
        "byTag": parsed["keywordsByTag"],
        "byMask": parsed["keywordsByMask"],
    }
    transfer_syntaxes_output = {
        "source": {
            "edition": ts_parsed["edition"],
            "url": args.url,
            "table": "PS3.6 Annex A, Table A-1 (rows where UID Type is \"Transfer Syntax\")",
        },
        "transferSyntaxes": ts_parsed["transferSyntaxes"],
    }

    text = json.dumps(output, indent=2) + "\n"
    keywords_text = json.dumps(keywords, indent=2) + "\n"
    transfer_syntaxes_text = json.dumps(transfer_syntaxes_output, indent=2) + "\n"
    shipped = len(json.dumps(output, separators=(",", ":")).encode("utf-8"))
    ts_shipped = len(json.dumps(transfer_syntaxes_output, separators=(",", ":")).encode("utf-8"))
    for path, content in ((args.out, text), (args.keywords_out, keywords_text), (args.transfer_syntaxes_out, transfer_syntaxes_text)):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content.encode("utf-8"))

    print(f"edition {parsed['edition']} (annex-e.json: {annex_edition}); {SOURCE_LABEL}; {args.url}")
    print("rows per table: " + ", ".join(f"{t} {n}" for t, n in parsed["counts"].items()) + f" (total {sum(parsed['counts'].values())})")
    print(f"attributes: {len(parsed['attributes'])} | patterns: {len(parsed['patterns'])}")
    shapes = collections.Counter(shape_of(p["mask"]) for p in parsed["patterns"])
    print("pattern shapes:")
    for shape, n in shapes.most_common():
        examples = [p["tagPattern"] for p in parsed["patterns"] if shape_of(p["mask"]) == shape][:3]
        print(f"  ({shape}) x{n}  e.g. {examples}")
    print("skipped rows:")
    show("skipped", parsed["skipped"])
    print("rows kept with a field omitted, or stored unusually:")
    show("notes", parsed["notes"])
    changed = parsed["nameChanges"]
    differing = [c for c in changed if c[3]]
    print(f"names that contained U+200B: {len(changed)}; of those, replace-with-space and strip give different names for {len(differing)} (the rest differ by nothing once whitespace is collapsed)")
    print("all names that contained U+200B (tag, printed form, final name, J = in JOINED_NAMES, D = space and strip differ):")
    for tag, before, after, differs in changed:
        joined = re.sub(r"[()\s,]", "", tag).lower() in JOINED_NAMES
        print(f"      {'J' if joined else '-'}{'D' if differs else '-'} {tag}  {before!r}  ->  {after!r}")
    unexpected = [c for c in differing if not re.search(r"[A-Za-z0-9]<ZW>[A-Za-z0-9]", c[1])]
    print(f"names where the two transforms differ but U+200B is NOT between two letters or digits: {len(unexpected)}")
    for tag, before, after, _ in unexpected:
        print(f"      {tag}  {before!r}  ->  {after!r}")
    see_note = [t for t, a in parsed["attributes"].items() if re.search(r"\(see Note \d+\)", a["name"])]
    print(f"names carrying a trailing '(see Note N)': {len(see_note)}")
    print(f"wrote {args.out}: {len(text.encode('utf-8'))} bytes on disk (pretty-printed), {shipped} bytes minified ({shipped / 1024:.1f} KB shipped)")
    print(f"wrote {args.keywords_out}: {len(keywords_text.encode('utf-8'))} bytes ({len(parsed['keywordsByTag'])} by tag, {len(parsed['keywordsByMask'])} by mask), test-only")
    if shipped > SHIPPED_LIMIT:
        print(f"WARNING: the shipped size exceeds {SHIPPED_LIMIT // 1024} KB; stop and report before going further.")

    print(f"{UID_TABLE_ID}: {ts_parsed['totalRows']} total rows, {len(ts_parsed['transferSyntaxes'])} with UID Type 'Transfer Syntax'")
    print(
        f"wrote {args.transfer_syntaxes_out}: {len(transfer_syntaxes_text.encode('utf-8'))} bytes on disk "
        f"(pretty-printed), {ts_shipped} bytes minified ({ts_shipped / 1024:.1f} KB shipped)"
    )
    if ts_shipped > UID_TRANSFER_SYNTAX_LIMIT:
        print(f"WARNING: the shipped transfer syntax table exceeds {UID_TRANSFER_SYNTAX_LIMIT // 1024} KB; stop and report before going further.")


if __name__ == "__main__":
    sys.exit(main())
