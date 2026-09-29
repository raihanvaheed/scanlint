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

  fixtures/series/                     a two-series study: 15 DICOM slices and four other files
  fixtures/series.manifest.json        grouping, spatial order, and every expected series-level finding

Every slice is PLANTED with a small, named set of changes (see SERIES and FAULTS), so the series
and the single file share one declarative source. The series manifest is computed from the same
structures that write the files and is then checked against the bytes on disk.

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
import dataclasses
import hashlib
import json
import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np
import pydicom
import pydicom.fileset
import pydicom.misc
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

SERIES_DIR_REL = "fixtures/series"
SERIES_MANIFEST_REL = "fixtures/series.manifest.json"
CT_IMAGE_STORAGE = "1.2.840.10008.5.1.4.1.1.2"
MEDIA_STORAGE_DIRECTORY = "1.2.840.10008.1.3.10"


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


def make_phantom(
    rows: int = ROWS, columns: int = COLUMNS, radius: int = DISC_RADIUS, seed: int = PHANTOM_SEED
) -> np.ndarray:
    """A disc on a diagonal gradient with light noise. Integer maths, fixed seed.

    The defaults are the single sample's image: changing them changes single.dcm."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:rows, 0:columns]
    background = 200 + (xx + yy) * 800 // (rows + columns - 2)
    disc = (xx - columns // 2) ** 2 + (yy - rows // 2) ** 2 <= radius ** 2
    image = np.where(disc, 3000, background) + rng.integers(0, 25, size=(rows, columns))
    if int(image.max()) >= 1 << BITS_STORED:
        raise SystemExit("Phantom exceeds the stored bit depth")
    return image.astype("<u2")


def build_dataset(
    transfer_syntax: str = EXPLICIT_VR_LITTLE_ENDIAN,
    planted: Optional[List[Union[Planted, PlantedPrivate]]] = None,
    phantom: Optional[np.ndarray] = None,
) -> Tuple[Dataset, List[Placed]]:
    ds = Dataset()
    meta = FileMetaDataset()
    placed: List[Placed] = []
    for item in PLANTED if planted is None else planted:
        if isinstance(item, PlantedPrivate):
            placed.append(_place_private(ds, item))
        else:
            placed.append(_place_standard(ds, meta, item))
    ds.file_meta = meta
    ds.preamble = b"\x00" * 128
    ds.is_little_endian = True
    ds.is_implicit_VR = transfer_syntax == IMPLICIT_VR_LITTLE_ENDIAN
    ds.add(DataElement(Tag(0x7FE00010), "OW", (make_phantom() if phantom is None else phantom).tobytes()))
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


# --- The series: one study, two series, six faults ---------------------------------------------
#
# Every slice is PLANTED with a few named changes, applied by `derive`. Nothing about a slice is
# typed a second time: the manifest is computed from these tables and then checked against the bytes.

SERIES_SIZE = 64
SERIES_SEED = 20240502
SERIES_RADIUS = 20
SLICE_UID_BASE = 271828182845904523536028747135
SERIES_UIDS = {
    "A": "2.25.577215664901532860606512090082402431",
    "B": "2.25.693147180559945309417232121458176568",
}
DICOMDIR_INSTANCE_UID = "2.25.141592653589793238462643383279502884"
NORMAL_PATIENT_ID = "SCANLINT-TEST-0001"  # the value PLANTED gives every slice that is not A-5


@dataclass(frozen=True)
class SeriesDef:
    label: str
    modality: str
    number: str
    description: str
    sop_class: str
    planned: int  # slice positions, 1-based
    step_mm: float
    pixel_spacing: Tuple[float, float]


SERIES: Dict[str, SeriesDef] = {
    "A": SeriesDef("A", "MR", "1", "SYNTHETIC AXIAL MR SERIES", MR_IMAGE_STORAGE, 12, 3.0, (0.5, 0.5)),
    "B": SeriesDef("B", "CT", "2", "SYNTHETIC AXIAL CT SERIES", CT_IMAGE_STORAGE, 4, 5.0, (0.7, 0.7)),
}

# Planned positions that are never written.
MISSING: List[Tuple[str, int]] = [("A", 7)]


@dataclass(frozen=True)
class SliceFault:
    """What is different about one slice. Every field left at its default means 'nothing'."""

    id: str
    note: str
    keep_referring_physician: bool = False
    patient_id: Optional[str] = None
    pixel_spacing: Optional[Tuple[float, float]] = None
    series_uid_of: Optional[str] = None
    instance_number: Optional[str] = None


FAULTS: Dict[Tuple[str, int], SliceFault] = {
    ("A", 3): SliceFault("A-3", "the only slice with ReferringPhysicianName", keep_referring_physician=True),
    ("A", 5): SliceFault("A-5", "PatientID differs from every other slice", patient_id="SCANLINT-MISFILED-0005"),
    ("A", 8): SliceFault("A-8", "PixelSpacing 0.6 where the rest have 0.5", pixel_spacing=(0.6, 0.6)),
    ("A", 9): SliceFault("A-9", "carries series B's SeriesInstanceUID", series_uid_of="B"),
    ("A", 11): SliceFault("A-11", "InstanceNumber is 2, and is wrong", instance_number="2"),
}

# Filename order is a fixed shuffle: alphabetical order must not equal spatial order, in either series
# or overall. Slice numbers are the planned positions (1-based) within each series.
FILE_ORDER: List[Tuple[str, int]] = [
    ("A", 9), ("B", 3), ("A", 2), ("A", 12), ("B", 1), ("A", 5), ("A", 8), ("B", 4),
    ("A", 1), ("A", 11), ("A", 3), ("B", 2), ("A", 10), ("A", 6), ("A", 4),
]

NON_DICOM_FILES = [".DS_Store", "thumbnail.jpg", "README.txt", "DICOMDIR"]

ORIENTATION = ["1", "0", "0", "0", "1", "0"]  # axial; the normal is +z


def slice_z(label: str, index: int) -> float:
    return (index - 1) * SERIES[label].step_mm


def slice_sop_uid(label: str, index: int) -> str:
    return f"2.25.{SLICE_UID_BASE + (1000 if label == 'B' else 0) + index}"


def derive(
    base: List[Union[Planted, PlantedPrivate]],
    replace: Dict[Tuple[Segment, ...], Any],
    drop: set,
    add: List[Planted],
) -> List[Union[Planted, PlantedPrivate]]:
    """PLANTED with named values replaced, named elements dropped and new ones appended."""
    out: List[Union[Planted, PlantedPrivate]] = []
    replaced: set = set()
    for item in base:
        if isinstance(item, Planted):
            if item.path in drop:
                continue
            if item.path in replace:
                item = dataclasses.replace(item, value=replace[item.path])
                replaced.add(item.path)
        out.append(item)
    unknown = (set(replace) | drop) - replaced - {p.path for p in base if isinstance(p, Planted)}
    if unknown:
        raise SystemExit(f"derive: PLANTED has no element at {sorted(map(str, unknown))}")
    return out + add


def slice_planted(label: str, index: int) -> List[Union[Planted, PlantedPrivate]]:
    d = SERIES[label]
    fault = FAULTS.get((label, index), SliceFault("", ""))
    spacing = fault.pixel_spacing or d.pixel_spacing
    sop = slice_sop_uid(label, index)
    replace: Dict[Tuple[Segment, ...], Any] = {
        ("MediaStorageSOPClassUID",): d.sop_class,
        ("SOPClassUID",): d.sop_class,
        ("MediaStorageSOPInstanceUID",): sop,
        ("SOPInstanceUID",): sop,
        ("SeriesInstanceUID",): SERIES_UIDS[fault.series_uid_of or label],
        ("SeriesNumber",): d.number,
        ("InstanceNumber",): fault.instance_number or str(index),
        ("Modality",): d.modality,
        ("Rows",): SERIES_SIZE,
        ("Columns",): SERIES_SIZE,
        ("PixelSpacing",): [f"{v:.1f}" for v in spacing],
        ("SliceThickness",): f"{d.step_mm:.1f}",
        ("ImageOrientationPatient",): ORIENTATION,
        ("ImagePositionPatient",): ["-100.0", "-100.0", f"{slice_z(label, index):.1f}"],
    }
    if fault.patient_id:
        replace[("PatientID",)] = fault.patient_id
    drop: set = set()
    if not fault.keep_referring_physician:
        drop |= {("ReferringPhysicianName",), NESTED + ("ReferringPhysicianName",)}
    if d.modality != "MR":
        drop |= {("MagneticFieldStrength",), ("RepetitionTime",), ("EchoTime",)}
    add = [
        unlisted("SeriesDescription", d.description),
        unlisted("SpacingBetweenSlices", f"{d.step_mm:.1f}"),
        unlisted("SliceLocation", f"{slice_z(label, index):.1f}"),
    ]
    return derive(PLANTED, replace, drop, add)


def written_slices() -> List[Tuple[str, str, int]]:
    """(filename, series label, planned index) in filename order."""
    if len(FILE_ORDER) != len(set(FILE_ORDER)):
        raise SystemExit("FILE_ORDER repeats a slice")
    expected = {(l, i) for l, d in SERIES.items() for i in range(1, d.planned + 1)} - set(MISSING)
    if set(FILE_ORDER) != expected:
        raise SystemExit(f"FILE_ORDER does not list exactly the written slices: {sorted(set(FILE_ORDER) ^ expected)}")
    return [(f"IM_{n:04d}", label, index) for n, (label, index) in enumerate(FILE_ORDER, start=1)]


def _jpeg_1x1_grey() -> bytes:
    """A valid baseline JPEG, 8x8 mid-grey: one DC code, one EOB code, no coefficients."""
    def seg(marker: int, body: bytes) -> bytes:
        return struct.pack(">HH", marker, len(body) + 2) + body

    dht_dc = seg(0xFFC4, bytes([0x00]) + bytes([1] + [0] * 15) + bytes([0x00]))
    dht_ac = seg(0xFFC4, bytes([0x10]) + bytes([1] + [0] * 15) + bytes([0x00]))
    return (
        b"\xff\xd8"
        + seg(0xFFDB, bytes([0x00]) + bytes([1] * 64))
        + seg(0xFFC0, bytes([8]) + struct.pack(">HH", 8, 8) + bytes([1, 1, 0x11, 0]))
        + dht_dc + dht_ac
        + seg(0xFFDA, bytes([1, 1, 0x00, 0, 63, 0]))
        + bytes([0x3F])  # DC category 0 = '0', AC end-of-block = '0', padded with ones
        + b"\xff\xd9"
    )


def build_dicomdir() -> Dataset:
    """A minimal Media Storage Directory: a real DICOM file that is not an image, with no records."""
    ds = Dataset()
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = MEDIA_STORAGE_DIRECTORY
    meta.MediaStorageSOPInstanceUID = DICOMDIR_INSTANCE_UID
    meta.TransferSyntaxUID = EXPLICIT_VR_LITTLE_ENDIAN
    meta.ImplementationClassUID = IMPLEMENTATION_CLASS_UID
    ds.file_meta = meta
    ds.preamble = b"\x00" * 128
    ds.is_little_endian = True
    ds.is_implicit_VR = False
    ds.FileSetID = "SCANLINT"
    ds.OffsetOfTheFirstDirectoryRecordOfTheRootDirectoryEntity = 0
    ds.OffsetOfTheLastDirectoryRecordOfTheRootDirectoryEntity = 0
    ds.FileSetConsistencyFlag = 0
    ds.DirectoryRecordSequence = Sequence()
    return ds


def non_dicom_bytes() -> Dict[str, bytes]:
    return {
        ".DS_Store": b"\x00\x00\x00\x01Bud1" + bytes(range(1, 9)),
        "thumbnail.jpg": _jpeg_1x1_grey(),
        "README.txt": b"Synthetic ScanLint test series. No real patient data.\n",
    }


# --- Reading the written files back ---


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _flat_tags(ds: Dataset) -> List[str]:
    tags: List[str] = []
    for elem in ds:
        tags.append(f"{int(elem.tag):08x}")
        if elem.VR == "SQ":
            for sub in elem.value:
                tags.extend(_flat_tags(sub))
    return tags


def _identifying_tags(ds: Dataset, table: dict) -> List[str]:
    """Tags the confidentiality profile names, plus private ones. The burned-in flag is not counted."""
    exact = {e["tag"] for e in table["attributes"]}
    masks = [p["mask"] for p in table["patterns"] if p["match"] == "nibbleMask"]
    found = []
    for tag in set(_flat_tags(ds) + _flat_tags(ds.file_meta)):
        if int(tag[:4], 16) % 2 == 1 or tag in exact or any(all(m == "x" or m == t for m, t in zip(mask, tag)) for mask in masks):
            found.append(tag)
    return found


def _plain_values(ds: Dataset) -> Dict[str, str]:
    """Every element outside Pixel Data by canonical path, as comparable text."""
    out: Dict[str, str] = {}

    def walk(d: Dataset, prefix: List[Segment]) -> None:
        for elem in d:
            if elem.tag == Tag(0x7FE00010):
                continue
            here = prefix + [elem.tag]
            if elem.VR == "SQ":
                out[_path_string(here)] = f"SQ with {len(elem.value)} item(s)"
                for i, sub in enumerate(elem.value):
                    walk(sub, here + [i])
            else:
                out[_path_string(here)] = _plain(elem.value)

    walk(ds, [])
    walk(ds.file_meta, [])
    return out


def _normal(orientation: List[float]) -> Tuple[float, float, float]:
    r, c = orientation[:3], orientation[3:]
    return (r[1] * c[2] - r[2] * c[1], r[2] * c[0] - r[0] * c[2], r[0] * c[1] - r[1] * c[0])


def _distance(position: List[float], orientation: List[float]) -> float:
    n = _normal(orientation)
    return round(sum(p * q for p, q in zip(position, n)), 6)


def build_series(root: Path) -> None:
    directory = root / SERIES_DIR_REL
    directory.mkdir(parents=True, exist_ok=True)
    slices = written_slices()

    for name, label, index in slices:
        serial = int(name[3:])
        ds, _ = build_dataset(
            planted=slice_planted(label, index),
            phantom=make_phantom(SERIES_SIZE, SERIES_SIZE, SERIES_RADIUS, SERIES_SEED + serial),
        )
        ds.save_as(str(directory / name), write_like_original=False)

    for name, content in non_dicom_bytes().items():
        (directory / name).write_bytes(content)
    build_dicomdir().save_as(str(directory / "DICOMDIR"), write_like_original=False)

    manifest = build_series_manifest(root, slices)
    verify_series(root, slices, manifest)
    path = root / SERIES_MANIFEST_REL
    path.write_bytes((json.dumps(manifest, indent=2) + "\n").encode("utf-8"))
    print(f"wrote {directory} ({len(slices)} slices + {len(NON_DICOM_FILES)} other files)")
    for name in sorted(p.name for p in directory.iterdir()):
        print(f"  {name:<14} {(directory / name).stat().st_size:>7} bytes  sha256 {_sha(directory / name)}")
    print(f"wrote {path} ({path.stat().st_size} bytes, sha256 {_sha(path)})")


def build_series_manifest(root: Path, slices: List[Tuple[str, str, int]]) -> dict:
    """Everything expected of the folder, computed from SERIES, FAULTS and MISSING, and from the bytes."""
    directory = root / SERIES_DIR_REL
    table = json.loads((REPO_ROOT / "src" / "model" / "annex-e.json").read_text(encoding="utf-8"))
    label_of_uid = {uid: label for label, uid in SERIES_UIDS.items()}

    files: List[dict] = []
    read: Dict[str, Dataset] = {}
    for name, label, index in slices:
        ds = pydicom.dcmread(str(directory / name))
        read[name] = ds
        fault = FAULTS.get((label, index))
        position = [float(v) for v in ds.ImagePositionPatient]
        entry: Dict[str, Any] = {
            "file": name,
            "sha256": _sha(directory / name),
            "plannedSeries": label,
            "plannedSlice": index,
            "seriesInstanceUid": str(ds.SeriesInstanceUID),
            "sopInstanceUid": str(ds.SOPInstanceUID),
            "modality": str(ds.Modality),
            "instanceNumber": str(ds.InstanceNumber),
            "imagePositionPatient": position,
            "pixelSpacing": [float(v) for v in ds.PixelSpacing],
        }
        if fault:
            entry["fault"] = {"id": fault.id, "note": fault.note}
        files.append(entry)
    by_name = {f["file"]: f for f in files}

    def distance(name: str) -> float:
        ds = read[name]
        return _distance([float(v) for v in ds.ImagePositionPatient], [float(v) for v in ds.ImageOrientationPatient])

    # Grouping is by the SeriesInstanceUID in the file, not by what was planned.
    series: List[dict] = []
    for label, uid in SERIES_UIDS.items():
        members = sorted(n for n, f in by_name.items() if f["seriesInstanceUid"] == uid)
        ordered = sorted(members, key=distance)
        series.append({
            "label": label,
            "seriesInstanceUid": uid,
            "modality": SERIES[label].modality,
            "expectedSpacingMm": SERIES[label].step_mm,
            "files": members,
            "spatialOrder": [{"file": n, "distanceAlongNormalMm": distance(n)} for n in ordered],
        })
    by_label = {s["label"]: s for s in series}

    def planned_file(label: str, index: int) -> str:
        return next(n for n, l, i in slices if (l, i) == (label, index))

    def neighbours_across(label: str, index: int) -> Tuple[str, str]:
        order = [o["file"] for o in by_label[label]["spatialOrder"]]
        z = slice_z(label, index)
        below = max((n for n in order if distance(n) < z), key=distance)
        above = min((n for n in order if distance(n) > z), key=distance)
        return below, above

    findings: List[dict] = []
    for label, index in MISSING:
        lo, hi = neighbours_across(label, index)
        findings.append({
            "kind": "position-gap",
            "series": SERIES_UIDS[label],
            "files": [lo, hi],
            "expectedMm": SERIES[label].step_mm,
            "actualMm": round(distance(hi) - distance(lo), 6),
            "cause": f"slice {label}-{index} is not written",
        })
    for (label, index), fault in sorted(FAULTS.items()):
        name = planned_file(label, index)
        if fault.pixel_spacing:
            findings.append({
                "kind": "inconsistent-pixel-spacing",
                "series": SERIES_UIDS[label],
                "files": [name],
                "values": {name: list(fault.pixel_spacing)},
                "expected": list(SERIES[label].pixel_spacing),
            })
        if fault.patient_id:
            findings.append({
                "kind": "varying-value",
                "series": SERIES_UIDS[label],
                "tag": "00100020",
                "files": [name],
                "values": {name: fault.patient_id},
                "otherFiles": NORMAL_PATIENT_ID,
            })
        if fault.keep_referring_physician:
            findings.append({
                "kind": "extra-field",
                "series": SERIES_UIDS[label],
                "tag": "00080090",
                "path": "00080090",
                "files": [name],
                "note": "no other file has this tag at the top level",
            })
            # The same fault also keeps ReferringPhysicianName nested inside the
            # OriginalAttributesSequence/ModifiedAttributesSequence block (dropped from every other
            # slice alongside the top-level one). A finding compared by tag number alone would merge
            # this with the entry above; compared by canonical path, as every other check in this
            # project is, it is a second, distinct extra-field finding.
            nested_path = _path_string(
                [_tag_of("OriginalAttributesSequence"), 0, _tag_of("ModifiedAttributesSequence"), 0, _tag_of("ReferringPhysicianName")]
            )
            findings.append({
                "kind": "extra-field",
                "series": SERIES_UIDS[label],
                "tag": "00080090",
                "path": nested_path,
                "files": [name],
                "note": "no other file has ReferringPhysicianName nested here either",
            })
    modalities: Dict[str, dict] = {}
    for name, f in sorted(by_name.items()):
        entry = modalities.setdefault(f["modality"], {"series": SERIES_UIDS[next(l for l, d in SERIES.items() if d.modality == f["modality"])], "files": []})
        entry["files"].append(name)
    findings.append({"kind": "mixed-modality", "level": "folder", "modalities": modalities})

    # A-9 carries B's SeriesInstanceUID and nothing else of B's, so grouped by UID it lands in series B
    # with A's geometry and A's modality. These follow from the plan; they are not further faults.
    consequences: List[dict] = []
    for (label, index), fault in sorted(FAULTS.items()):
        if not fault.series_uid_of:
            continue
        misfiled = planned_file(label, index)
        home, other = label, fault.series_uid_of
        lo, hi = neighbours_across(home, index)
        consequences.append({
            "kind": "position-gap", "series": SERIES_UIDS[home], "files": [lo, hi],
            "expectedMm": SERIES[home].step_mm, "actualMm": round(distance(hi) - distance(lo), 6),
            "cause": f"{fault.id} left this series",
        })
        ordered = [o["file"] for o in by_label[other]["spatialOrder"]]
        at = ordered.index(misfiled)
        consequences.append({
            "kind": "position-gap", "series": SERIES_UIDS[other], "files": [ordered[at - 1], misfiled],
            "expectedMm": SERIES[other].step_mm, "actualMm": round(distance(misfiled) - distance(ordered[at - 1]), 6),
            "cause": f"{fault.id} joined this series",
        })
        consequences.append({
            "kind": "inconsistent-pixel-spacing", "series": SERIES_UIDS[other], "files": [misfiled],
            "values": {misfiled: by_name[misfiled]["pixelSpacing"]}, "expected": list(SERIES[other].pixel_spacing),
        })
        consequences.append({
            "kind": "mixed-modality", "level": "series", "series": SERIES_UIDS[other],
            "modalities": {SERIES[other].modality: [n for n in ordered if n != misfiled], by_name[misfiled]["modality"]: [misfiled]},
        })
        reference = next(n for n in ordered if n != misfiled)
        legit = {"00020003", "00080018", "00200013", "00200032", "00201041", "00020000"}
        a, b = _plain_values(read[misfiled]), _plain_values(read[reference])
        differing = sorted({p.split("/")[-1] for p in set(a) | set(b) if a.get(p) != b.get(p)} - legit)
        identifying = set(_identifying_tags(read[misfiled], table)) | set(_identifying_tags(read[reference], table))
        consequences.append({
            "kind": "varying-value", "series": SERIES_UIDS[other], "files": [misfiled],
            "identifyingTags": [t for t in differing if t in identifying],
            "otherTags": [t for t in differing if t not in identifying],
            "note": "tags whose value differs, or that are present in only one, between this file and the rest of the series, "
                    "less those that vary legitimately (instance UIDs, InstanceNumber, position, slice location)",
        })

    union = sorted({t for ds in read.values() for t in _identifying_tags(ds, table)})

    return {
        "manifestVersion": 1,
        "generator": "scripts/make-sample-study.py",
        "pathFormat": PATH_FORMAT,
        "directory": SERIES_DIR_REL,
        "studyInstanceUid": STUDY_INSTANCE_UID,
        "note": "Grouping is by the SeriesInstanceUID written in each file. Series A has 10 files and B has 5, "
                "because A-9 carries B's UID. Per-file findings are not listed: every slice is built from the same "
                "source as public/samples/single.dcm, whose manifest covers classification.",
        "series": series,
        "files": files,
        "seriesFindings": findings,
        "consequencesOfMisfiledSlice": consequences,
        "findingsUnion": {"tags": union},
        "skipped": [
            {"file": ".DS_Store", "kind": "macos-metadata", "dicom": False},
            {"file": "thumbnail.jpg", "kind": "jpeg-image", "dicom": False},
            {"file": "README.txt", "kind": "text", "dicom": False},
            {
                "file": "DICOMDIR",
                "kind": "media-storage-directory",
                "dicom": True,
                "sopClassUid": MEDIA_STORAGE_DIRECTORY,
                "note": "a valid DICOM Part 10 file with no image and no directory records: skipped by SOP Class, not by name, "
                        "would be the check that generalises",
            },
        ],
    }


def verify_series(root: Path, slices: List[Tuple[str, str, int]], manifest: dict) -> None:
    """Read the written bytes back with pydicom and confirm every planted fault is really there."""
    directory = root / SERIES_DIR_REL
    read = {name: pydicom.dcmread(str(directory / name)) for name, _, _ in slices}
    name_of = {(l, i): n for n, l, i in slices}
    print("series checks:")

    def ok(message: str, condition: bool) -> None:
        if not condition:
            raise SystemExit(f"series check FAILED: {message}")
        print(f"  ok  {message}")

    ok("15 slices written, none with an extension", len(slices) == 15 and all("." not in n for n, _, _ in slices))
    ok("slice A-7 is absent", ("A", 7) not in name_of and len([1 for l, _ in name_of if l == "A"]) == 11)
    zs = sorted(float(read[n].ImagePositionPatient[2]) for n, l, _ in slices if l == "A")
    ok("series A z positions are 0,3,6,9,12,15,21,24,27,30,33", zs == [0.0, 3.0, 6.0, 9.0, 12.0, 15.0, 21.0, 24.0, 27.0, 30.0, 33.0])
    ok("the gap is 6.0 mm between z = 15.0 and z = 21.0", 21.0 - 15.0 == 6.0 and (15.0 in zs) and (21.0 in zs) and 18.0 not in zs)
    zb = sorted(float(read[n].ImagePositionPatient[2]) for n, l, _ in slices if l == "B")
    ok("series B z positions are 0,5,10,15", zb == [0.0, 5.0, 10.0, 15.0])

    ok("A-3 is the only slice with ReferringPhysicianName at the top level", [n for n, ds in read.items() if "ReferringPhysicianName" in ds] == [name_of[("A", 3)]])
    ok("no other tag 0008,0090 exists at any depth outside A-3", all(("00080090" not in _flat_tags(ds)) for n, ds in read.items() if n != name_of[("A", 3)]) and "00080090" in _flat_tags(read[name_of[("A", 3)]]))
    ids = {n: str(ds.PatientID) for n, ds in read.items()}
    ok("A-5 alone has a different PatientID", [n for n, v in ids.items() if v != NORMAL_PATIENT_ID] == [name_of[("A", 5)]])
    ok("A-8 alone has PixelSpacing 0.6", [n for n, ds in read.items() if [float(v) for v in ds.PixelSpacing] == [0.6, 0.6]] == [name_of[("A", 8)]])
    ok("every other series A slice has PixelSpacing 0.5", all([float(v) for v in ds.PixelSpacing] == [0.5, 0.5] for (l, i), n in name_of.items() if l == "A" and i != 8 for ds in [read[n]]))
    ok("A-9 carries series B's SeriesInstanceUID", str(read[name_of[("A", 9)]].SeriesInstanceUID) == SERIES_UIDS["B"] and read[name_of[("A", 9)]].Modality == "MR")
    ok("grouping by SeriesInstanceUID gives 10 in A and 5 in B", [len(s["files"]) for s in manifest["series"]] == [10, 5])
    ok("A-11 has InstanceNumber 2, the same as A-2", str(read[name_of[("A", 11)]].InstanceNumber) == "2" and str(read[name_of[("A", 2)]].InstanceNumber) == "2")

    for s in manifest["series"]:
        alphabetical = sorted(s["files"])
        spatial = [o["file"] for o in s["spatialOrder"]]
        ok(f"series {s['label']}: alphabetical order differs from spatial order", alphabetical != spatial)
    planned_ok = all(
        [n for n, l, i in sorted(slices) if l == lab] != [n for n, l, i in sorted(slices, key=lambda t: t[2]) if l == lab]
        for lab in "AB"
    )
    ok("by planned slice, alphabetical order differs from spatial order in both series", planned_ok)

    mismatched = [s for s in manifest["series"] for o in s["spatialOrder"] if o["distanceAlongNormalMm"] != float(read[o["file"]].ImagePositionPatient[2])]
    ok("the manifest's distances are the z values in the files", not mismatched)

    for name in read:
        pydicom.dcmread(str(directory / name))  # a full parse
        text = str(read[name])                  # pydicom's own dump, an independent reader
        if "(7fe0, 0010)" not in text.lower():
            raise SystemExit(f"{name}: pydicom's dump shows no pixel data")
    ok("all 15 slices are valid DICOM to pydicom, and its dump shows their pixel data", True)
    ok("64 x 64, 16-bit, in every slice", all(int(ds.Rows) == 64 and int(ds.Columns) == 64 and int(ds.BitsAllocated) == 16 and len(ds.PixelData) == 64 * 64 * 2 for ds in read.values()))

    ok(".DS_Store, thumbnail.jpg and README.txt are not DICOM", not any(pydicom.misc.is_dicom(str(directory / n)) for n in (".DS_Store", "thumbnail.jpg", "README.txt")))
    dicomdir = pydicom.dcmread(str(directory / "DICOMDIR"))
    ok("DICOMDIR is DICOM, with SOP Class 1.2.840.10008.1.3.10", pydicom.misc.is_dicom(str(directory / "DICOMDIR")) and str(dicomdir.file_meta.MediaStorageSOPClassUID) == MEDIA_STORAGE_DIRECTORY)
    ok("DICOMDIR has no image and reads as a file set to pydicom", "PixelData" not in dicomdir and len(pydicom.fileset.FileSet(dicomdir)) == 0)
    jpeg = (directory / "thumbnail.jpg").read_bytes()
    ok("thumbnail.jpg starts FFD8 and ends FFD9", jpeg[:2] == b"\xff\xd8" and jpeg[-2:] == b"\xff\xd9")


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

    build_series(root)


if __name__ == "__main__":
    main()
