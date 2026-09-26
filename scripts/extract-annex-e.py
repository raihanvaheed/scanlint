#!/usr/bin/env python3
"""Extract DICOM PS3.15 Table E.1-1 (Application Level Confidentiality Profile
Attributes) from the standard's published DocBook XML into src/model/annex-e.json.

Run by hand; CI does not run it. Python 3.9+, standard library only:
  python3 scripts/extract-annex-e.py [--out PATH] [--url URL] [--retrieved-at YYYY-MM-DD]

The output records which edition it came from. The DocBook source is published only
under /current/, so re-running later pulls a newer edition and may change actions.

Structure is checked strictly and the script exits non-zero on any surprise, so a
changed layout in a future edition fails here rather than writing bad data.
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, List, NoReturn, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "src" / "model" / "annex-e.json"
DEFAULT_URL = "https://dicom.nema.org/medical/dicom/current/source/docbook/part15/part15.xml"
TABLE_ID = "table_E.1-1"

DB = "{http://docbook.org/ns/docbook}"
XML_ID = "{http://www.w3.org/XML/1998/namespace}id"

SOURCE_NOTE = (
    "The DocBook source is published only under /current/. An edition-pinned URL "
    "returns 404, so this file cannot be reproduced from the URL alone; edition and "
    "retrievedAt record which revision it came from."
)

# Rows whose tag cell is not a concrete tag. How each is matched is fixed by the
# project, not inferred: the masks deliberately ignore DICOM's group-range limits.
PATTERN_ROWS: Dict[str, Tuple[str, Optional[str]]] = {
    "(50xx,xxxx)": ("nibbleMask", "50xxxxxx"),
    "(60xx,3000)": ("nibbleMask", "60xx3000"),
    "(60xx,4000)": ("nibbleMask", "60xx4000"),
    "(gggg,eeee) where gggg is odd": ("oddGroup", None),
}

CONCRETE_TAG = re.compile(r"^\(([0-9A-Fa-f]{4}),([0-9A-Fa-f]{4})\)$")
ACTION = re.compile(r"^[XZDKCU](/[XZDKCU])*\*?$")
ZERO_WIDTH_SPACE = "\u200b"
EXPECTED_OPTION_COLUMNS = 10


def fail(message: str) -> NoReturn:
    raise SystemExit(f"extract-annex-e: {message}")


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "scanlint-extract-annex-e"})
    with urllib.request.urlopen(request, timeout=180) as response:
        return response.read()


def cell_text(cell: ET.Element) -> str:
    return re.sub(r"\s+", " ", "".join(cell.itertext())).strip()


def option_key(header: str) -> str:
    """'Rtn. Safe Priv. Opt.' -> 'rtnSafePrivOpt'."""
    words = re.findall(r"[A-Za-z0-9]+", header)
    if not words:
        fail(f"cannot derive a column key from header {header!r}")
    return words[0].lower() + "".join(w[0].upper() + w[1:].lower() for w in words[1:])


def parse_columns(table: ET.Element) -> Tuple[List[str], List[str]]:
    thead = table.find(f"{DB}thead")
    if thead is None or len(thead.findall(f"{DB}tr")) != 1:
        fail("expected exactly one header row")
    headers = [cell_text(th) for th in thead.iter(f"{DB}th")]
    if len(headers) != 5 + EXPECTED_OPTION_COLUMNS:
        fail(f"expected {5 + EXPECTED_OPTION_COLUMNS} header cells, found {len(headers)}: {headers}")
    expected_start = ["Attribute Name", "Tag", "Retd.", "In Std. Comp. IOD", "Basic Prof."]
    for header, expected in zip(headers, expected_start):
        if not header.startswith(expected):
            fail(f"header {header!r} does not start with {expected!r}")
    options = headers[5:]
    for header in options:
        if not header.endswith("Opt."):
            fail(f"option column header does not end in 'Opt.': {header!r}")
    keys = [option_key(h) for h in options]
    if len(set(keys)) != len(keys) or "basic" in keys:
        fail(f"derived option keys are not unique: {keys}")
    return headers, keys


def yes_no(value: str, column: str, tag: str, allow_empty: bool) -> Optional[bool]:
    if value == "Y":
        return True
    if value == "N":
        return False
    if value == "" and allow_empty:
        return None
    fail(f"{tag}: unexpected value {value!r} in column {column!r}")


def parse_actions(cells: List[str], keys: List[str], tag: str) -> Dict[str, Optional[str]]:
    actions: Dict[str, Optional[str]] = {}
    for key, value in zip(["basic"] + keys, cells):
        if value == "":
            actions[key] = None
        elif ACTION.match(value):
            actions[key] = value
        else:
            fail(f"{tag}: unexpected action {value!r} in column {key!r}")
    return actions


def parse(xml_bytes: bytes) -> Dict[str, Any]:
    root = ET.fromstring(xml_bytes)

    subtitle = root.find(f"{DB}subtitle")
    match = re.search(r"PS3\.15\s+(\S+)\s+-", "".join(subtitle.itertext()) if subtitle is not None else "")
    if not match:
        fail("cannot read the edition from the document subtitle")
    edition = match.group(1)

    tables = [t for t in root.iter(f"{DB}table") if t.get(XML_ID) == TABLE_ID]
    if len(tables) != 1:
        fail(f"expected one table with xml:id {TABLE_ID!r}, found {len(tables)}")
    table = tables[0]

    _headers, keys = parse_columns(table)
    tbody = table.find(f"{DB}tbody")
    if tbody is None:
        fail("table has no tbody")

    attributes: List[Dict[str, Any]] = []
    patterns: List[Dict[str, Any]] = []
    seen_tags: set = set()
    seen_patterns: set = set()
    zwsp_names = 0

    for row in tbody.findall(f"{DB}tr"):
        raw = [cell_text(td) for td in row.findall(f"{DB}td")]
        if len(raw) != 5 + EXPECTED_OPTION_COLUMNS:
            fail(f"row {raw[:2]} has {len(raw)} cells, expected {5 + EXPECTED_OPTION_COLUMNS}")
        name_raw, tag_cell = "".join(row.findall(f"{DB}td")[0].itertext()), raw[1]
        if ZERO_WIDTH_SPACE in name_raw:
            zwsp_names += 1
        name = re.sub(r"\s+", " ", name_raw.replace(ZERO_WIDTH_SPACE, "")).strip()
        if not name:
            fail(f"row with tag {tag_cell!r} has an empty name")

        entry_common = {
            "name": name,
            "retired": yes_no(raw[2], "Retd.", tag_cell, allow_empty=False),
            "inStandardCompositeIod": yes_no(raw[3], "In Std. Comp. IOD", tag_cell, allow_empty=True),
            "actions": parse_actions(raw[4:], keys, tag_cell),
        }

        concrete = CONCRETE_TAG.match(tag_cell)
        if concrete:
            tag = (concrete.group(1) + concrete.group(2)).lower()
            if tag in seen_tags:
                fail(f"duplicate tag {tag}")
            seen_tags.add(tag)
            attributes.append({"tag": tag, **entry_common})
        elif tag_cell in PATTERN_ROWS:
            kind, mask = PATTERN_ROWS[tag_cell]
            if tag_cell in seen_patterns:
                fail(f"duplicate pattern row {tag_cell!r}")
            seen_patterns.add(tag_cell)
            pattern: Dict[str, Any] = {"tagPattern": tag_cell, "match": kind}
            if mask is not None:
                pattern["mask"] = mask
            patterns.append({**pattern, **entry_common})
        else:
            fail(f"tag cell {tag_cell!r} is neither a concrete tag nor a known pattern row")

    missing = set(PATTERN_ROWS) - seen_patterns
    if missing:
        fail(f"known pattern rows not found in the table: {sorted(missing)}")

    attributes.sort(key=lambda a: a["tag"])
    patterns.sort(key=lambda p: p["tagPattern"])
    return {
        "edition": edition,
        "table": "Table " + TABLE_ID.split("_", 1)[1],
        "columns": ["basic"] + keys,
        "attributes": attributes,
        "patterns": patterns,
        "zwsp_names": zwsp_names,
    }


def main(argv: Optional[List[str]] = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output path (default: src/model/annex-e.json)")
    parser.add_argument("--url", default=DEFAULT_URL, help="DocBook source URL")
    parser.add_argument("--retrieved-at", help="YYYY-MM-DD (default: today, UTC)")
    args = parser.parse_args(argv)

    retrieved_at = args.retrieved_at or datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", retrieved_at):
        fail(f"--retrieved-at must be YYYY-MM-DD, got {args.retrieved_at!r}")

    parsed = parse(fetch(args.url))
    output = {
        "source": {
            "edition": parsed["edition"],
            "url": args.url,
            "table": parsed["table"],
            "retrievedAt": retrieved_at,
            "attributeCount": len(parsed["attributes"]),
            "patternCount": len(parsed["patterns"]),
            "note": SOURCE_NOTE,
        },
        "columns": parsed["columns"],
        "attributes": parsed["attributes"],
        "patterns": parsed["patterns"],
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes((json.dumps(output, indent=2) + "\n").encode("utf-8"))

    with_basic = sum(1 for a in parsed["attributes"] if a["actions"]["basic"] is not None)
    print(f"edition {parsed['edition']}, {parsed['table']} from {args.url}")
    print(f"{len(parsed['attributes'])} attributes ({with_basic} with a basic action), {len(parsed['patterns'])} patterns")
    print(f"option columns ({len(parsed['columns']) - 1}): {', '.join(parsed['columns'][1:])}")
    print(f"names with U+200B stripped: {parsed['zwsp_names']}")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    sys.exit(main())
