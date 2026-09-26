#!/usr/bin/env python3
"""Generate ScanLint's synthetic single-file DICOM fixture and its manifest.

Writes, relative to the repository root:
  public/samples/single.dcm            a synthetic single-slice MR Image Storage file
  fixtures/single.manifest.json        exactly what was planted in it (the test oracle)
  fixtures/single-implicit.dcm         the same study, Implicit VR Little Endian
  fixtures/single-rle.dcm              the same study, RLE Lossless pixel data (undefined length)

The two variants are test data, not samples offered to a visitor, so they live in fixtures/.
They are built from the same PLANTED list, and each is checked against the explicit file
before the script finishes. The manifest describes the explicit file only.

Everything the file contains comes from ONE declarative list, PLANTED, below. The
same list writes the dataset and produces the manifest, so the two cannot drift.
Output is deterministic: running the script twice yields byte-identical files.

Run (Python 3.9+), ideally inside a virtual environment kept outside the repo:
  python3 -m pip install -r scripts/requirements.txt
  python3 scripts/make-sample-study.py [--root DIR]

Annex E actions were taken from DICOM PS3.15 2026d, Table E.1-1, "Basic Prof." column.
All patient, person and organisation values are fictional.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np
import pydicom
from pydicom.dataelem import DataElement
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.datadict import dictionary_VR, keyword_for_tag, tag_for_keyword
from pydicom.multival import MultiValue
from pydicom.sequence import Sequence
from pydicom.tag import BaseTag, Tag
from pydicom.uid import RLELossless

REPO_ROOT = Path(__file__).resolve().parent.parent
DCM_REL = "public/samples/single.dcm"
MANIFEST_REL = "fixtures/single.manifest.json"

# --- Fixed constants: nothing here depends on time, randomness or the machine ---

MR_IMAGE_STORAGE = "1.2.840.10008.5.1.4.1.1.4"
EXPLICIT_VR_LITTLE_ENDIAN = "1.2.840.10008.1.2.1"

SOP_INSTANCE_UID = "2.25.314159265358979323846264338327950288"
STUDY_INSTANCE_UID = "2.25.271828182845904523536028747135266249"
SERIES_INSTANCE_UID = "2.25.161803398874989484820458683436563811"
FRAME_OF_REFERENCE_UID = "2.25.141421356237309504880168872420969807"
IMPLEMENTATION_CLASS_UID = "2.25.173205080756887729352744634150587236"

PHANTOM_SEED = 20240501
ROWS = 256
COLUMNS = 256
BITS_ALLOCATED = 16
BITS_STORED = 12
HIGH_BIT = BITS_STORED - 1
DISC_RADIUS = 80

PRIVATE_GROUP = 0x0029
PRIVATE_CREATOR = "SCANLINT TEST"

ROLE_FINDING = "finding"
ROLE_KEPT = "kept"
ROLE_UNLISTED = "unlisted"

KIND_ANNEX_E = "annex-e"
KIND_PRIVATE = "private"
KIND_BURNED_IN = "burned-in"

PATH_FORMAT = (
    "tag segments are 8 lowercase hex chars; sequence item segments are "
    "zero-based indices; segments joined by /"
)

Segment = Union[str, int]

# Variants of the same study. Only the transfer syntax (and, for RLE, the pixel data) differs.
IMPLICIT_VR_LITTLE_ENDIAN = "1.2.840.10008.1.2"
RLE_LOSSLESS = "1.2.840.10008.1.2.5"
IMPLICIT_REL = "fixtures/single-implicit.dcm"
RLE_REL = "fixtures/single-rle.dcm"


@dataclass(frozen=True)
class Planted:
    """One standard element. `path` alternates keyword, item index, keyword, ...

    A sequence (value None) is created empty and filled by deeper entries.
    `undefined_length` applies to sequences only.
    """

    path: Tuple[Segment, ...]
    value: Any = None
    role: str = ROLE_UNLISTED
    kind: Optional[str] = None
    action: Optional[str] = None
    file_meta: bool = False
    undefined_length: bool = False


@dataclass(frozen=True)
class PlantedPrivate:
    """One private element. `offset` None means the private creator element itself.

    The real tag is decided by pydicom when the block is reserved, and is read back
    from the dataset rather than assumed.
    """

    offset: Optional[int]
    vr: str
    value: str
    role: str = ROLE_FINDING
    kind: str = KIND_PRIVATE


def annex_e(path: Tuple[Segment, ...], value: Any, action: str) -> Planted:
    return Planted(path, value, ROLE_FINDING, KIND_ANNEX_E, action)


def kept(keyword: str, value: Any) -> Planted:
    return Planted((keyword,), value, ROLE_KEPT)


def unlisted(keyword: str, value: Any, file_meta: bool = False) -> Planted:
    return Planted((keyword,), value, ROLE_UNLISTED, file_meta=file_meta)


NESTED = ("OriginalAttributesSequence", 0, "ModifiedAttributesSequence", 0)

PLANTED: List[Union[Planted, PlantedPrivate]] = [
    # File meta header
    unlisted("FileMetaInformationVersion", b"\x00\x01", file_meta=True),
    unlisted("MediaStorageSOPClassUID", MR_IMAGE_STORAGE, file_meta=True),
    Planted(
        ("MediaStorageSOPInstanceUID",), SOP_INSTANCE_UID,
        ROLE_FINDING, KIND_ANNEX_E, "U", file_meta=True,
    ),
    unlisted("TransferSyntaxUID", EXPLICIT_VR_LITTLE_ENDIAN, file_meta=True),
    unlisted("ImplementationClassUID", IMPLEMENTATION_CLASS_UID, file_meta=True),
    unlisted("ImplementationVersionName", "SCANLINT_FIX_1", file_meta=True),
    # Required by the MR Image IOD, not flagged by the profile (or flagged U)
    unlisted("SOPClassUID", MR_IMAGE_STORAGE),
    annex_e(("SOPInstanceUID",), SOP_INSTANCE_UID, "U"),
    annex_e(("StudyInstanceUID",), STUDY_INSTANCE_UID, "U"),
    annex_e(("SeriesInstanceUID",), SERIES_INSTANCE_UID, "U"),
    annex_e(("FrameOfReferenceUID",), FRAME_OF_REFERENCE_UID, "U"),
    unlisted("SeriesNumber", "1"),
    unlisted("InstanceNumber", "1"),
    # Top-level identifying elements
    annex_e(("PatientName",), "TESTPATIENT^SCANLINT", "Z"),
    annex_e(("PatientID",), "SCANLINT-TEST-0001", "Z/D"),
    annex_e(("PatientBirthDate",), "19700101", "Z"),
    annex_e(("PatientSex",), "O", "Z"),
    annex_e(("OtherPatientIDs",), "SCANLINT-OTHER-0002", "X"),
    annex_e(("PatientAddress",), "1 SYNTHETIC STREET, TESTVILLE", "X"),
    annex_e(("PatientTelephoneNumbers",), "000-000-0000", "X"),
    annex_e(("ReferringPhysicianName",), "REFERRER^SYNTHETIC", "Z"),
    annex_e(("PerformingPhysicianName",), "PERFORMER^SYNTHETIC", "X"),
    annex_e(("OperatorsName",), "OPERATOR^SYNTHETIC", "X/Z/D"),
    annex_e(("InstitutionName",), "SCANLINT TEST FACILITY", "X/Z/D"),
    annex_e(("InstitutionAddress",), "2 SYNTHETIC ROAD, TESTVILLE", "X"),
    annex_e(("StudyDate",), "20000101", "Z"),
    annex_e(("StudyTime",), "120000", "Z"),
    annex_e(("AccessionNumber",), "SCANLINTACC01", "Z"),
    annex_e(("StudyID",), "SCANLINT1", "Z"),
    annex_e(("StudyDescription",), "SYNTHETIC PHANTOM STUDY", "X"),
    # Identifying data nested two sequences deep. The outer sequence is undefined
    # length and the inner one defined, so this one file exercises both encodings.
    Planted(NESTED[:1], None, ROLE_FINDING, KIND_ANNEX_E, "X", undefined_length=True),
    annex_e(NESTED[:3], None, "X"),
    annex_e(NESTED + ("ReferringPhysicianName",), "NESTED^REFERRER", "Z"),
    # Private block: creator element first, then data elements
    PlantedPrivate(None, "LO", PRIVATE_CREATOR),
    PlantedPrivate(0x01, "LO", "PRIVATE-NOTE-ONE"),
    PlantedPrivate(0x02, "LO", "PRIVATE-NOTE-TWO"),
    # Burned-in annotation flag
    Planted(("BurnedInAnnotation",), "YES", ROLE_FINDING, KIND_BURNED_IN),
    # Technical elements the profile does not flag
    kept("Modality", "MR"),
    kept("Rows", ROWS),
    kept("Columns", COLUMNS),
    kept("BitsAllocated", BITS_ALLOCATED),
    kept("BitsStored", BITS_STORED),
    kept("HighBit", HIGH_BIT),
    kept("PixelRepresentation", 0),
    kept("PhotometricInterpretation", "MONOCHROME2"),
    kept("SamplesPerPixel", 1),
    kept("PixelSpacing", ["1.0", "1.0"]),
    kept("SliceThickness", "5.0"),
    kept("MagneticFieldStrength", "3.0"),
    kept("RepetitionTime", "500.0"),
    kept("EchoTime", "20.0"),
    kept("ImageOrientationPatient", ["1.0", "0.0", "0.0", "0.0", "1.0", "0.0"]),
    kept("ImagePositionPatient", ["-128.0", "-128.0", "0.0"]),
]


# --- Building the dataset from PLANTED ---


@dataclass
class Placed:
    item: Union[Planted, PlantedPrivate]
    segments: Tuple[Segment, ...]  # keyword/int for standard, (tag int,) for private
    tag_path: str


def _tag_of(keyword: str) -> BaseTag:
    tag = tag_for_keyword(keyword)
    if tag is None:
        raise SystemExit(f"Unknown DICOM keyword: {keyword}")
    return Tag(tag)


def _path_string(parts: List[Segment]) -> str:
    return "/".join(f"{p:08x}" if isinstance(p, BaseTag) else str(p) for p in parts)


def _descend(root: Dataset, segments: Tuple[Segment, ...]) -> Tuple[Dataset, List[Segment]]:
    """Walk to the dataset that should hold the final element, creating sequences."""
    container = root
    parts: List[Segment] = []
    for i in range(0, len(segments), 2):
        tag = _tag_of(str(segments[i]))
        index = int(segments[i + 1])
        if tag not in container:
            container.add(DataElement(tag, "SQ", Sequence()))
        sequence = container[tag].value
        while len(sequence) <= index:
            sequence.append(Dataset())
        container = sequence[index]
        parts.extend([tag, index])
    return container, parts


def _place_standard(ds: Dataset, meta: Dataset, item: Planted) -> Placed:
    container, parts = _descend(meta if item.file_meta else ds, item.path[:-1])
    tag = _tag_of(str(item.path[-1]))
    vr = dictionary_VR(tag)
    if " or " in vr:
        raise SystemExit(f"Ambiguous VR for {item.path[-1]}: {vr}")
    if vr == "SQ":
        if tag not in container:
            container.add(DataElement(tag, "SQ", Sequence()))
        if item.undefined_length:
            container[tag].is_undefined_length = True
    else:
        container.add(DataElement(tag, vr, item.value))
    return Placed(item, tuple(item.path), _path_string(parts + [tag]))


def _place_private(ds: Dataset, item: PlantedPrivate) -> Placed:
    block = ds.private_block(PRIVATE_GROUP, PRIVATE_CREATOR, create=True)
    if item.offset is None:
        found = [
            e.tag for e in ds
            if e.tag.group == PRIVATE_GROUP
            and 0x0010 <= e.tag.element <= 0x00FF
            and e.value == PRIVATE_CREATOR
        ]
        if len(found) != 1:
            raise SystemExit(f"Expected one private creator element, found {found}")
        tag = found[0]
    else:
        block.add_new(item.offset, item.vr, item.value)
        tag = block.get_tag(item.offset)
        if tag not in ds or ds[tag].value != item.value:
            raise SystemExit(f"Private element {tag} did not land as planted")
    return Placed(item, (int(tag),), _path_string([tag]))


def make_phantom() -> np.ndarray:
    """A disc on a diagonal gradient with light noise. Integer maths, fixed seed."""
    rng = np.random.default_rng(PHANTOM_SEED)
    yy, xx = np.mgrid[0:ROWS, 0:COLUMNS]
    background = 200 + (xx + yy) * 800 // (ROWS + COLUMNS - 2)
    disc = (xx - COLUMNS // 2) ** 2 + (yy - ROWS // 2) ** 2 <= DISC_RADIUS ** 2
    image = np.where(disc, 3000, background) + rng.integers(0, 25, size=(ROWS, COLUMNS))
    if int(image.max()) >= 1 << BITS_STORED:
        raise SystemExit("Phantom exceeds the stored bit depth")
    return image.astype("<u2")


def build_dataset(transfer_syntax: str = EXPLICIT_VR_LITTLE_ENDIAN) -> Tuple[Dataset, List[Placed]]:
    ds = Dataset()
    meta = FileMetaDataset()
    placed: List[Placed] = []
    for item in PLANTED:
        if isinstance(item, PlantedPrivate):
            placed.append(_place_private(ds, item))
        else:
            placed.append(_place_standard(ds, meta, item))
    ds.file_meta = meta
    ds.preamble = b"\x00" * 128
    ds.is_little_endian = True
    ds.is_implicit_VR = transfer_syntax == IMPLICIT_VR_LITTLE_ENDIAN
    ds.add(DataElement(Tag(0x7FE00010), "OW", make_phantom().tobytes()))
    if transfer_syntax == IMPLICIT_VR_LITTLE_ENDIAN:
        meta.TransferSyntaxUID = IMPLICIT_VR_LITTLE_ENDIAN
    elif transfer_syntax == RLE_LOSSLESS:
        ds.compress(RLELossless)  # sets the transfer syntax, and writes Pixel Data as OB, undefined length
    elif transfer_syntax != EXPLICIT_VR_LITTLE_ENDIAN:
        raise SystemExit(f"Unsupported transfer syntax: {transfer_syntax}")
    return ds, placed


# --- Reading back what was actually written ---


def _norm(value: Any) -> Any:
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)
    if isinstance(value, (list, tuple, MultiValue)):
        return [str(v) for v in value]
    return str(value)


def _lookup(ds: Dataset, placed: Placed) -> DataElement:
    item = placed.item
    if isinstance(item, PlantedPrivate):
        return ds[Tag(placed.segments[0])]
    if isinstance(item, Planted) and item.file_meta:
        ds = ds.file_meta
    container = ds
    segments = placed.segments
    for i in range(0, len(segments) - 1, 2):
        container = container[_tag_of(str(segments[i]))].value[int(segments[i + 1])]
    return container[_tag_of(str(segments[-1]))]


def _private_paths(ds: Dataset, prefix: List[Segment]) -> List[str]:
    """Every private element in a dataset, recursively, as canonical paths."""
    found: List[str] = []
    for elem in ds:
        here = prefix + [elem.tag]
        if elem.tag.is_private:
            found.append(_path_string(here))
        if elem.VR == "SQ":
            for index, sub in enumerate(elem.value):
                found.extend(_private_paths(sub, here + [index]))
    return found


def build_manifest_entries(dcm_path: Path, placed: List[Placed]) -> Tuple[List[dict], List[dict]]:
    ds = pydicom.dcmread(str(dcm_path))
    findings: List[dict] = []
    kept_entries: List[dict] = []
    for p in placed:
        item = p.item
        if item.role == ROLE_UNLISTED:
            continue
        elem = _lookup(ds, p)
        if elem.VR != "SQ" and _norm(elem.value) != _norm(item.value):
            raise SystemExit(f"{p.tag_path}: file holds {elem.value!r}, planted {item.value!r}")
        entry: Dict[str, Any] = {"path": p.tag_path, "tag": f"{int(elem.tag):08x}"}
        if not isinstance(item, PlantedPrivate):
            entry["keyword"] = keyword_for_tag(elem.tag)
        entry["vr"] = elem.VR
        if item.role == ROLE_KEPT:
            kept_entries.append(entry)
            continue
        entry["kind"] = item.kind
        if item.kind == KIND_ANNEX_E:
            entry["action"] = item.action
        if elem.VR == "SQ":
            entry["lengthEncoding"] = "undefined" if elem.is_undefined_length else "defined"
            if elem.is_undefined_length != item.undefined_length:
                raise SystemExit(f"{p.tag_path}: planted undefined_length={item.undefined_length}, file has {entry['lengthEncoding']}")
        else:
            entry["value"] = str(elem.value)
        findings.append(entry)

    findings.sort(key=lambda e: e["path"])
    kept_entries.sort(key=lambda e: e["path"])

    paths = [e["path"] for e in findings + kept_entries]
    if len(paths) != len(set(paths)):
        raise SystemExit("Duplicate paths in manifest")
    declared_private = sorted(e["path"] for e in findings if e["kind"] == KIND_PRIVATE)
    if declared_private != sorted(_private_paths(ds, [])):
        raise SystemExit("Private elements in the file do not match the manifest")
    return findings, kept_entries


def verify_length_encoding(dcm_path: Path, findings: List[dict]) -> None:
    """Check the written bytes agree with each sequence's recorded lengthEncoding.

    Reads raw bytes, not pydicom's flag. Assumes each sequence tag occurs once in the
    header, which holds for this fixture and fails loudly if it stops holding.
    """
    data = dcm_path.read_bytes()
    pixel_data_at = data.find(struct.pack("<HH", 0x7FE0, 0x0010) + b"OW")
    if pixel_data_at == -1:
        raise SystemExit("Pixel data element not found in the written file")
    header = data[:pixel_data_at]

    undefined_count = 0
    for finding in findings:
        if finding["vr"] != "SQ":
            continue
        tag = finding["tag"]
        header_bytes = struct.pack("<HH", int(tag[:4], 16), int(tag[4:], 16)) + b"SQ\x00\x00"
        if header.count(header_bytes) != 1:
            raise SystemExit(f"{tag}: expected one explicit-VR SQ header, found {header.count(header_bytes)}")
        length_at = header.find(header_bytes) + 8
        length_field = header[length_at:length_at + 4]
        raw = "undefined" if length_field == b"\xff\xff\xff\xff" else "defined"
        if raw != finding["lengthEncoding"]:
            raise SystemExit(f"{tag}: file bytes say {raw}, manifest says {finding['lengthEncoding']}")
        undefined_count += raw == "undefined"
        print(f"  {finding['path']}: length field at offset {length_at} = {length_field.hex(' ')} ({raw})")

    delimiter = struct.pack("<HH", 0xFFFE, 0xE0DD)
    offsets = [i for i in range(len(data)) if data.startswith(delimiter, i)]
    if len(offsets) != undefined_count:
        raise SystemExit(f"Expected {undefined_count} sequence delimitation item(s), found at {offsets}")
    for offset in offsets:
        if data[offset + 4:offset + 8] != b"\x00\x00\x00\x00":
            raise SystemExit(f"Sequence delimitation item at {offset} has a non-zero length")
        print(f"  sequence delimitation item (FFFE,E0DD) at offset {offset}: {data[offset:offset + 8].hex(' ')}")


def _plain(value: Any) -> Any:
    """A value in a form that compares equal however the transfer syntax typed it."""
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).decode("ascii").rstrip(" \x00")
    if isinstance(value, (list, tuple, MultiValue)):
        return [str(v) for v in value]
    return str(value)


def _flatten(ds: Dataset, prefix: List[Segment]) -> Dict[str, Any]:
    """Every element except Pixel Data, by canonical path. Sequences record their item count."""
    out: Dict[str, Any] = {}
    for elem in ds:
        if elem.tag == Tag(0x7FE00010):
            continue
        here = prefix + [elem.tag]
        if elem.VR == "SQ":
            out[_path_string(here)] = f"SQ with {len(elem.value)} item(s)"
            for index, sub in enumerate(elem.value):
                out.update(_flatten(sub, here + [index]))
        else:
            out[_path_string(here)] = _plain(elem.value)
    return out


def verify_variant(path: Path, reference: Path, transfer_syntax: str, phantom: bytes) -> None:
    """The variant must say the same thing as the explicit file, in its own encoding."""
    ref = pydicom.dcmread(str(reference))
    got = pydicom.dcmread(str(path))
    if str(got.file_meta.TransferSyntaxUID) != transfer_syntax:
        raise SystemExit(f"{path.name}: transfer syntax {got.file_meta.TransferSyntaxUID}, expected {transfer_syntax}")

    want = _flatten(ref, [])
    want.update(_flatten(ref.file_meta, []))
    have = _flatten(got, [])
    have.update(_flatten(got.file_meta, []))
    # The transfer syntax must differ, and the group length follows the length of its UID.
    for tag in (Tag(0x00020000), Tag(0x00020010)):
        want.pop(_path_string([tag]))
        have.pop(_path_string([tag]))
    if want != have:
        diff = sorted(k for k in set(want) | set(have) if want.get(k) != have.get(k))
        raise SystemExit(f"{path.name}: elements differ from the explicit file: {diff}")

    data = path.read_bytes()
    if transfer_syntax == IMPLICIT_VR_LITTLE_ENDIAN:
        # No VR in the stream: tag, then a 4-byte length, then the value.
        name = b"TESTPATIENT^SCANLINT"
        wanted = struct.pack("<HHI", 0x0010, 0x0010, len(name)) + name
        if data.count(wanted) != 1:
            raise SystemExit(f"{path.name}: Patient's Name is not encoded as an implicit-VR element")
        if got.PixelData != ref.PixelData:
            raise SystemExit(f"{path.name}: pixel data differs from the explicit file")
        print(f"  {path.name}: Patient's Name as tag + 4-byte length: {wanted[:12].hex(' ')} ...")
    else:
        # The standard says OB for encapsulated pixel data; pydicom 2.4.4 writes OW. Either is
        # read the same way, so accept both and print which one this file holds.
        candidates = [
            struct.pack("<HH", 0x7FE0, 0x0010) + vr + b"\x00\x00\xff\xff\xff\xff" for vr in (b"OB", b"OW")
        ]
        found = [(header, data.find(header)) for header in candidates if data.count(header) == 1]
        if len(found) != 1:
            raise SystemExit(f"{path.name}: Pixel Data is not an element of undefined length")
        header, at = found[0]
        if got.pixel_array.astype("<u2").tobytes() != phantom:
            raise SystemExit(f"{path.name}: RLE pixel data does not decode to the planted image")
        print(f"  {path.name}: Pixel Data header at offset {at}: {data[at:at + 12].hex(' ')}")


def main(argv: Optional[List[str]] = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--root", type=Path, default=REPO_ROOT,
        help="directory that public/ and fixtures/ are written under (default: repo root)",
    )
    root = parser.parse_args(argv).root.resolve()

    ds, placed = build_dataset()
    dcm_path = root / DCM_REL
    manifest_path = root / MANIFEST_REL
    dcm_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)

    ds.save_as(str(dcm_path), write_like_original=False)
    sha256 = hashlib.sha256(dcm_path.read_bytes()).hexdigest()
    findings, kept_entries = build_manifest_entries(dcm_path, placed)
    print("raw-byte length encoding check:")
    verify_length_encoding(dcm_path, findings)

    manifest = {
        "manifestVersion": 1,
        "generator": "scripts/make-sample-study.py",
        "pathFormat": PATH_FORMAT,
        "files": [
            {
                "file": DCM_REL,
                "sha256": sha256,
                "sopInstanceUid": SOP_INSTANCE_UID,
                "transferSyntaxUid": EXPLICIT_VR_LITTLE_ENDIAN,
                "expectedFindings": findings,
                "expectedKept": kept_entries,
            }
        ],
    }
    manifest_path.write_bytes((json.dumps(manifest, indent=2) + "\n").encode("utf-8"))
    print(f"wrote {dcm_path} ({dcm_path.stat().st_size} bytes, sha256 {sha256})")
    print(f"wrote {manifest_path} ({len(findings)} findings, {len(kept_entries)} kept)")

    phantom = make_phantom().tobytes()
    print("variants (checked against the explicit file):")
    for rel, syntax in ((IMPLICIT_REL, IMPLICIT_VR_LITTLE_ENDIAN), (RLE_REL, RLE_LOSSLESS)):
        variant_path = root / rel
        variant_path.parent.mkdir(parents=True, exist_ok=True)
        variant_ds, _ = build_dataset(syntax)
        variant_ds.save_as(str(variant_path), write_like_original=False)
        verify_variant(variant_path, dcm_path, syntax, phantom)
        digest = hashlib.sha256(variant_path.read_bytes()).hexdigest()
        print(f"wrote {variant_path} ({variant_path.stat().st_size} bytes, sha256 {digest})")


if __name__ == "__main__":
    main()
