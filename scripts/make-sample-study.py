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
from pydicom.encaps import decode_data_sequence, encapsulate, get_frame_offsets
from pydicom.filebase import DicomBytesIO
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


# --- Stage 3.1: pixel fixtures ------------------------------------------------------------------
#
# A second, minimal dataset builder, deliberately not the PLANTED/Placed apparatus above: that
# machinery exists to audit every element against Annex E actions, which these files have no need
# of. What they need instead - pixel representation, rescale, window, and a pattern with a known
# formula - is declared once, in the constants and functions below, and written and verified from
# that one source, the same property PLANTED holds for the PHI fixture.

PIXELS_DIR_REL = "fixtures/pixels"
PIXELS_MANIFEST_REL = "fixtures/pixels.manifest.json"
# 3.4a: burned-in.dcm ships as a second sample, not a test-only fixture, so a visitor with no DICOM
# file of their own can still see the demonstration this stage was built for. It is written here,
# not into PIXELS_DIR_REL, and the manifest records that explicitly (its own "directory" key).
BURNED_IN_SAMPLE_REL = "public/samples/burned-in.dcm"

PATTERN_SIZE = 64
PATTERN_BITS_ALLOCATED = 16
PATTERN_BITS_STORED = 12
PATTERN_HIGH_BIT = PATTERN_BITS_STORED - 1

RESCALE_SLOPE = 2
RESCALE_INTERCEPT = -1024
WINDOW_CENTER = 0
WINDOW_WIDTH = 400
SECOND_WINDOW_CENTER = 3071
SECOND_WINDOW_WIDTH = 8190

BURNED_IN_SIZE = 128
BURNED_IN_TEXT = "TESTPATIENT"
BURNED_IN_MAX = (1 << PATTERN_BITS_STORED) - 1  # 4095

SECONDARY_CAPTURE_STORAGE = "1.2.840.10008.5.1.4.1.1.7"
PIXELS_PATIENT_ID = "SCANLINT-PIXELS-0001"

# Three distinct instances: the four pattern-*.dcm variants of the unsigned ramp share one identity
# (they are the same acquisition, re-encoded - the same relationship single.dcm has to
# single-implicit.dcm and single-rle.dcm); the signed ramp and the burned-in slice are genuinely
# different images and each gets its own, matching how a real signed-representation or
# photometric-interpretation change would in practice mean a new instance, not a transcoding of one.
PATTERN_STUDY_UID = "2.25.223606797749978980505"  # sqrt(5)
PATTERN_SERIES_UID = "2.25.244948974278317788134"  # sqrt(6)
PATTERN_SOP_UID = "2.25.264575131106459071617"  # sqrt(7)
SIGNED_STUDY_UID = "2.25.316227766016837952279"  # sqrt(10)
SIGNED_SERIES_UID = "2.25.331662479035539980998"  # sqrt(11)
SIGNED_SOP_UID = "2.25.360555127546398912486"  # sqrt(13)
BURNED_IN_STUDY_UID = "2.25.374165738677394132949"  # sqrt(14)
BURNED_IN_SERIES_UID = "2.25.387298334620741702139"  # sqrt(15)
BURNED_IN_SOP_UID = "2.25.412310562561766058565"  # sqrt(17)


def pattern_pixels_unsigned() -> np.ndarray:
    """value = y * 64 + x: every 12-bit value 0..4095 exactly once."""
    yy, xx = np.mgrid[0:PATTERN_SIZE, 0:PATTERN_SIZE]
    return (yy * PATTERN_SIZE + xx).astype("<u2")


def pattern_pixels_signed() -> np.ndarray:
    """value = y * 64 + x - 2048: every value -2048..2047 exactly once."""
    yy, xx = np.mgrid[0:PATTERN_SIZE, 0:PATTERN_SIZE]
    return (yy * PATTERN_SIZE + xx - 2048).astype("<i2")


def apply_window(x: float, center: float, width: float) -> int:
    """PS3.3 C.11.2.1.2, the default LINEAR VOI LUT function, exactly as given: the `- 0.5` and
    `(w - 1)` terms are not decoration. The naive (x - (c - w/2)) / w * 255 is off by half a level
    and clips one value differently at each end - this is the literal formula, not that one."""
    low = center - 0.5 - (width - 1) / 2
    high = center - 0.5 + (width - 1) / 2
    if x <= low:
        y = 0.0
    elif x > high:
        y = 255.0
    else:
        y = ((x - (center - 0.5)) / (width - 1) + 0.5) * 255
    return max(0, min(255, round(y)))


def windowed_grey(stored: int, center: float, width: float, monochrome1: bool) -> Tuple[float, int]:
    """(value after rescale, final 0-255 grey). MONOCHROME1 inverts after windowing, never before."""
    rescaled = stored * RESCALE_SLOPE + RESCALE_INTERCEPT
    grey = apply_window(rescaled, center, width)
    if monochrome1:
        grey = 255 - grey
    return rescaled, grey


# Eight test coordinates as (x, y): x is the column, y is the row, so pixels[y][x] holds the value
# `y * 64 + x`. The first five are section 6's own; the last three are chosen to fall inside the
# narrow window's ramp (stored values roughly 413-611) rather than its clipped regions, so between
# the eight there is at least one clipped-low, one clipped-high and several ramp points.
PIXEL_TEST_COORDS: List[Tuple[int, int]] = [
    (0, 0), (63, 0), (0, 63), (63, 63), (32, 32),
    (0, 7), (32, 8), (0, 9),
]

GLYPH_WIDTH = 8
GLYPH_HEIGHT = 12

# Hard-coded 8x12 block bitmaps ('1' = text pixel). TESTPATIENT is eleven letters but only seven are
# distinct - T, E, S, P, A, I, N - so that is what is defined here; see the PR notes.
GLYPHS: Dict[str, List[str]] = {
    "T": [
        "11111111", "11111111", "00011000", "00011000", "00011000", "00011000",
        "00011000", "00011000", "00011000", "00011000", "00011000", "00011000",
    ],
    "E": [
        "11111111", "11111111", "11000000", "11000000", "11000000", "11111100",
        "11111100", "11000000", "11000000", "11000000", "11111111", "11111111",
    ],
    "S": [
        "01111110", "11111111", "11000000", "11000000", "01111110", "00000011",
        "00000011", "00000011", "11000011", "11111111", "01111110", "00000000",
    ],
    "P": [
        "11111110", "11111111", "11000011", "11000011", "11111111", "11111110",
        "11000000", "11000000", "11000000", "11000000", "11000000", "00000000",
    ],
    "A": [
        "00111100", "01111110", "11000011", "11000011", "11000011", "11111111",
        "11111111", "11000011", "11000011", "11000011", "11000011", "00000000",
    ],
    "I": [
        "11111111", "11111111", "00011000", "00011000", "00011000", "00011000",
        "00011000", "00011000", "00011000", "00011000", "11111111", "11111111",
    ],
    "N": [
        "11000011", "11100011", "11110011", "11111011", "11011111", "11001111",
        "11000111", "11000011", "11000011", "11000011", "11000011", "00000000",
    ],
}


def burned_in_bounding_box() -> Tuple[int, int, int, int]:
    """(rowStart, colStart, rowEnd, colEnd), end-exclusive, of the whole text block."""
    width = len(BURNED_IN_TEXT) * GLYPH_WIDTH
    col_start = (BURNED_IN_SIZE - width) // 2
    row_start = (BURNED_IN_SIZE - GLYPH_HEIGHT) // 2
    return row_start, col_start, row_start + GLYPH_HEIGHT, col_start + width


def burned_in_pixels() -> np.ndarray:
    # 3.3: a phantom behind the text, not a flat field - a reader seeing two solid values either
    # side of the text bounding box would reasonably wonder what the picture was proving. The disc
    # radius is scaled down with the canvas (single.dcm's 80 was tuned for a 256x256 image) so the
    # disc keeps the same proportion of the frame rather than swallowing nearly all of a 128x128 one.
    radius = DISC_RADIUS * BURNED_IN_SIZE // ROWS
    image = make_phantom(rows=BURNED_IN_SIZE, columns=BURNED_IN_SIZE, radius=radius)
    row0, col0, _, _ = burned_in_bounding_box()
    for i, ch in enumerate(BURNED_IN_TEXT):
        for gy, row in enumerate(GLYPHS[ch]):
            for gx, bit in enumerate(row):
                if bit == "1":
                    image[row0 + gy, col0 + i * GLYPH_WIDTH + gx] = BURNED_IN_MAX
    return image


def build_pixel_dataset(
    *,
    sop_uid: str,
    study_uid: str,
    series_uid: str,
    rows: int,
    columns: int,
    pixel_representation: int,
    photometric: str,
    pixels: np.ndarray,
    transfer_syntax: str = EXPLICIT_VR_LITTLE_ENDIAN,
    rescale: bool,
) -> Dataset:
    ds = Dataset()
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = SECONDARY_CAPTURE_STORAGE
    meta.MediaStorageSOPInstanceUID = sop_uid
    meta.TransferSyntaxUID = EXPLICIT_VR_LITTLE_ENDIAN
    meta.ImplementationClassUID = IMPLEMENTATION_CLASS_UID
    ds.file_meta = meta
    ds.preamble = b"\x00" * 128
    ds.is_little_endian = True
    ds.is_implicit_VR = False

    ds.SOPClassUID = SECONDARY_CAPTURE_STORAGE
    ds.SOPInstanceUID = sop_uid
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = series_uid
    ds.SeriesNumber = "1"
    ds.InstanceNumber = "1"
    ds.Modality = "OT"
    ds.PatientID = PIXELS_PATIENT_ID
    ds.PatientName = "SCANLINT^PIXELTEST"

    ds.Rows = rows
    ds.Columns = columns
    ds.BitsAllocated = PATTERN_BITS_ALLOCATED
    ds.BitsStored = PATTERN_BITS_STORED
    ds.HighBit = PATTERN_HIGH_BIT
    ds.PixelRepresentation = pixel_representation
    ds.PhotometricInterpretation = photometric
    ds.SamplesPerPixel = 1

    if rescale:
        ds.RescaleSlope = str(RESCALE_SLOPE)
        ds.RescaleIntercept = str(RESCALE_INTERCEPT)
        ds.WindowCenter = str(WINDOW_CENTER)
        ds.WindowWidth = str(WINDOW_WIDTH)

    ds.add(DataElement(Tag(0x7FE00010), "OW", pixels.tobytes()))

    if transfer_syntax == IMPLICIT_VR_LITTLE_ENDIAN:
        ds.is_implicit_VR = True
        meta.TransferSyntaxUID = IMPLICIT_VR_LITTLE_ENDIAN
    elif transfer_syntax == RLE_LOSSLESS:
        ds.compress(RLELossless)
    elif transfer_syntax != EXPLICIT_VR_LITTLE_ENDIAN:
        raise SystemExit(f"Unsupported transfer syntax: {transfer_syntax}")

    return ds


def expected_outputs(pixels: np.ndarray, monochrome1: bool, center: float, width: float) -> List[dict]:
    entries = []
    for x, y in PIXEL_TEST_COORDS:
        stored = int(pixels[y, x])
        rescaled, grey = windowed_grey(stored, center, width, monochrome1)
        entries.append({"x": x, "y": y, "stored": stored, "rescaled": rescaled, "grey": grey})
    return entries


def build_pixels(root: Path) -> None:
    directory = root / PIXELS_DIR_REL
    directory.mkdir(parents=True, exist_ok=True)

    unsigned_pixels = pattern_pixels_unsigned()
    signed_pixels = pattern_pixels_signed()
    burned_pixels = burned_in_pixels()

    datasets = {
        "pattern-explicit.dcm": build_pixel_dataset(
            sop_uid=PATTERN_SOP_UID, study_uid=PATTERN_STUDY_UID, series_uid=PATTERN_SERIES_UID,
            rows=PATTERN_SIZE, columns=PATTERN_SIZE, pixel_representation=0,
            photometric="MONOCHROME2", pixels=unsigned_pixels,
            transfer_syntax=EXPLICIT_VR_LITTLE_ENDIAN, rescale=True,
        ),
        "pattern-implicit.dcm": build_pixel_dataset(
            sop_uid=PATTERN_SOP_UID, study_uid=PATTERN_STUDY_UID, series_uid=PATTERN_SERIES_UID,
            rows=PATTERN_SIZE, columns=PATTERN_SIZE, pixel_representation=0,
            photometric="MONOCHROME2", pixels=unsigned_pixels,
            transfer_syntax=IMPLICIT_VR_LITTLE_ENDIAN, rescale=True,
        ),
        "pattern-rle.dcm": build_pixel_dataset(
            sop_uid=PATTERN_SOP_UID, study_uid=PATTERN_STUDY_UID, series_uid=PATTERN_SERIES_UID,
            rows=PATTERN_SIZE, columns=PATTERN_SIZE, pixel_representation=0,
            photometric="MONOCHROME2", pixels=unsigned_pixels,
            transfer_syntax=RLE_LOSSLESS, rescale=True,
        ),
        "pattern-signed.dcm": build_pixel_dataset(
            sop_uid=SIGNED_SOP_UID, study_uid=SIGNED_STUDY_UID, series_uid=SIGNED_SERIES_UID,
            rows=PATTERN_SIZE, columns=PATTERN_SIZE, pixel_representation=1,
            photometric="MONOCHROME2", pixels=signed_pixels,
            transfer_syntax=EXPLICIT_VR_LITTLE_ENDIAN, rescale=True,
        ),
        "pattern-mono1.dcm": build_pixel_dataset(
            sop_uid=PATTERN_SOP_UID, study_uid=PATTERN_STUDY_UID, series_uid=PATTERN_SERIES_UID,
            rows=PATTERN_SIZE, columns=PATTERN_SIZE, pixel_representation=0,
            photometric="MONOCHROME1", pixels=unsigned_pixels,
            transfer_syntax=EXPLICIT_VR_LITTLE_ENDIAN, rescale=True,
        ),
        "burned-in.dcm": build_pixel_dataset(
            sop_uid=BURNED_IN_SOP_UID, study_uid=BURNED_IN_STUDY_UID, series_uid=BURNED_IN_SERIES_UID,
            rows=BURNED_IN_SIZE, columns=BURNED_IN_SIZE, pixel_representation=0,
            photometric="MONOCHROME2", pixels=burned_pixels,
            transfer_syntax=EXPLICIT_VR_LITTLE_ENDIAN, rescale=False,
        ),
    }
    datasets["burned-in.dcm"].BurnedInAnnotation = "NO"

    burned_in_path = root / BURNED_IN_SAMPLE_REL
    burned_in_path.parent.mkdir(parents=True, exist_ok=True)

    for name, ds in datasets.items():
        if name == "burned-in.dcm":
            ds.save_as(str(burned_in_path), write_like_original=False)
        else:
            ds.save_as(str(directory / name), write_like_original=False)

    manifest = build_pixels_manifest(directory, burned_in_path)
    verify_pixels(directory, manifest, burned_in_path)

    path = root / PIXELS_MANIFEST_REL
    path.write_bytes((json.dumps(manifest, indent=2) + "\n").encode("utf-8"))

    print(f"wrote {directory} (5 files)")
    total = 0
    for name in sorted(p.name for p in directory.iterdir()):
        size = (directory / name).stat().st_size
        total += size
        print(f"  {name:<22} {size:>7} bytes  sha256 {_sha(directory / name)}")
    print(f"  total: {total} bytes")
    print(f"wrote {burned_in_path} ({burned_in_path.stat().st_size} bytes, sha256 {_sha(burned_in_path)})")
    print(f"wrote {path} ({path.stat().st_size} bytes, sha256 {_sha(path)})")


def build_pixels_manifest(directory: Path, burned_in_path: Path) -> dict:
    """Everything expected of fixtures/pixels/, computed from the files as written to disk - never
    from the in-memory arrays used to build them, so a write/read round-trip bug cannot hide."""
    files_manifest: List[dict] = []

    pattern_variants = [
        ("pattern-explicit.dcm", EXPLICIT_VR_LITTLE_ENDIAN, "MONOCHROME2"),
        ("pattern-implicit.dcm", IMPLICIT_VR_LITTLE_ENDIAN, "MONOCHROME2"),
        ("pattern-rle.dcm", RLE_LOSSLESS, "MONOCHROME2"),
        ("pattern-mono1.dcm", EXPLICIT_VR_LITTLE_ENDIAN, "MONOCHROME1"),
    ]
    for name, syntax, photometric in pattern_variants:
        ds = pydicom.dcmread(str(directory / name))
        arr = ds.pixel_array.astype("<u2")
        monochrome1 = photometric == "MONOCHROME1"
        files_manifest.append({
            "file": name,
            "sha256": _sha(directory / name),
            "transferSyntaxUid": syntax,
            "rows": PATTERN_SIZE,
            "columns": PATTERN_SIZE,
            "bitsAllocated": PATTERN_BITS_ALLOCATED,
            "bitsStored": PATTERN_BITS_STORED,
            "highBit": PATTERN_HIGH_BIT,
            "pixelRepresentation": 0,
            "photometricInterpretation": photometric,
            "rescaleSlope": RESCALE_SLOPE,
            "rescaleIntercept": RESCALE_INTERCEPT,
            "windowCenter": WINDOW_CENTER,
            "windowWidth": WINDOW_WIDTH,
            "pixelArraySha256": hashlib.sha256(arr.tobytes()).hexdigest(),
            "expectedOutput": expected_outputs(arr, monochrome1, WINDOW_CENTER, WINDOW_WIDTH),
            "expectedOutputSecondWindow": expected_outputs(arr, monochrome1, SECOND_WINDOW_CENTER, SECOND_WINDOW_WIDTH),
        })

    signed_ds = pydicom.dcmread(str(directory / "pattern-signed.dcm"))
    signed_arr = signed_ds.pixel_array.astype("<i2")
    files_manifest.append({
        "file": "pattern-signed.dcm",
        "sha256": _sha(directory / "pattern-signed.dcm"),
        "transferSyntaxUid": EXPLICIT_VR_LITTLE_ENDIAN,
        "rows": PATTERN_SIZE,
        "columns": PATTERN_SIZE,
        "bitsAllocated": PATTERN_BITS_ALLOCATED,
        "bitsStored": PATTERN_BITS_STORED,
        "highBit": PATTERN_HIGH_BIT,
        "pixelRepresentation": 1,
        "photometricInterpretation": "MONOCHROME2",
        "rescaleSlope": RESCALE_SLOPE,
        "rescaleIntercept": RESCALE_INTERCEPT,
        "windowCenter": WINDOW_CENTER,
        "windowWidth": WINDOW_WIDTH,
        "pixelArraySha256": hashlib.sha256(signed_arr.tobytes()).hexdigest(),
        "expectedOutput": expected_outputs(signed_arr, False, WINDOW_CENTER, WINDOW_WIDTH),
        "expectedOutputSecondWindow": expected_outputs(signed_arr, False, SECOND_WINDOW_CENTER, SECOND_WINDOW_WIDTH),
    })

    burned_ds = pydicom.dcmread(str(burned_in_path))
    burned_arr = burned_ds.pixel_array.astype("<u2")
    row0, col0, row1, col1 = burned_in_bounding_box()
    files_manifest.append({
        "file": "burned-in.dcm",
        # Everything else in this manifest lives at the top-level "directory" below; this one file
        # is shipped as a second sample instead (3.4a), so its own location is recorded explicitly
        # rather than silently assumed to be fixtures/pixels/ like its siblings.
        "directory": BURNED_IN_SAMPLE_REL.rsplit("/", 1)[0],
        "sha256": _sha(burned_in_path),
        "transferSyntaxUid": EXPLICIT_VR_LITTLE_ENDIAN,
        "rows": BURNED_IN_SIZE,
        "columns": BURNED_IN_SIZE,
        "bitsAllocated": PATTERN_BITS_ALLOCATED,
        "bitsStored": PATTERN_BITS_STORED,
        "highBit": PATTERN_HIGH_BIT,
        "pixelRepresentation": 0,
        "photometricInterpretation": "MONOCHROME2",
        "pixelArraySha256": hashlib.sha256(burned_arr.tobytes()).hexdigest(),
        "burnedInAnnotation": {
            "declared": str(burned_ds.BurnedInAnnotation),
            "deliberatelyFalse": True,
            "note": "The declaration is deliberately false: the pixels contain the legible text "
                    "'TESTPATIENT' while the metadata declares no burned-in annotation. This is Stage "
                    "3's demonstration case for the preview - proof that a clean declaration is not "
                    "proof of clean pixels - and is not a generator bug.",
            "text": BURNED_IN_TEXT,
            "boundingBox": {"rowStart": row0, "colStart": col0, "rowEnd": row1, "colEnd": col1},
            "textValue": BURNED_IN_MAX,
            "background": "make_phantom(rows=128, columns=128) - a disc on a gradient with noise, not a uniform value",
        },
    })

    return {
        "manifestVersion": 1,
        "generator": "scripts/make-sample-study.py",
        "pathFormat": PATH_FORMAT,
        "directory": PIXELS_DIR_REL,
        "patternFormula": {
            "unsigned": "value = y * 64 + x, for y, x each in [0, 64) - every 12-bit value 0..4095 exactly once",
            "signed": "value = y * 64 + x - 2048, for y, x each in [0, 64) - every value -2048..2047 exactly once",
            "coordinateConvention": "(x, y): x is the column, y is the row; pixels[y][x] holds the stored value",
        },
        "windowingFormula": {
            "standard": "PS3.3 C.11.2.1.2, the default LINEAR VOI LUT function",
            "formula": (
                "x is the value after rescale (x = stored * RescaleSlope + RescaleIntercept), c is "
                "WindowCenter, w is WindowWidth. If x <= c - 0.5 - (w-1)/2, y = 0. Else if "
                "x > c - 0.5 + (w-1)/2, y = 255. Else y = ((x - (c - 0.5)) / (w - 1) + 0.5) * 255, "
                "rounded to the nearest integer and clamped to 0-255. MONOCHROME1 then applies "
                "y = 255 - y, after windowing, never before."
            ),
        },
        "window": {"center": WINDOW_CENTER, "width": WINDOW_WIDTH, "note": "narrow: clips almost every value to black or white"},
        "secondWindow": {"center": SECOND_WINDOW_CENTER, "width": SECOND_WINDOW_WIDTH, "note": "full range: ramps almost every value"},
        "files": files_manifest,
    }


def verify_pixels(directory: Path, manifest: dict, burned_in_path: Path) -> None:
    """Read the written bytes back with pydicom and confirm every check in section 9."""
    print("pixel checks:")

    def path_of(entry: dict) -> Path:
        return burned_in_path if entry["file"] == "burned-in.dcm" else directory / entry["file"]

    def ok(message: str, condition: bool) -> None:
        if not condition:
            raise SystemExit(f"pixel check FAILED: {message}")
        print(f"  ok  {message}")

    explicit = pydicom.dcmread(str(directory / "pattern-explicit.dcm")).pixel_array.astype("<u2")
    implicit = pydicom.dcmread(str(directory / "pattern-implicit.dcm")).pixel_array.astype("<u2")
    rle = pydicom.dcmread(str(directory / "pattern-rle.dcm")).pixel_array.astype("<u2")
    ok(
        "pattern-explicit, pattern-implicit and pattern-rle decode to identical pixel arrays",
        np.array_equal(explicit, implicit) and np.array_equal(explicit, rle),
    )

    signed_ds = pydicom.dcmread(str(directory / "pattern-signed.dcm"))
    signed = signed_ds.pixel_array.astype("<i2")
    ok(
        "the signed variant's values run -2048 to 2047 and PixelRepresentation is 1",
        int(signed.min()) == -2048
        and int(signed.max()) == 2047
        and int(signed_ds.PixelRepresentation) == 1
        and sorted(signed.flatten().tolist()) == list(range(-2048, 2048)),
    )

    mono1_ds = pydicom.dcmread(str(directory / "pattern-mono1.dcm"))
    mono1 = mono1_ds.pixel_array.astype("<u2")
    ok(
        "the MONOCHROME1 variant's pixels are identical to pattern-explicit's; only the photometric interpretation differs",
        np.array_equal(mono1, explicit) and str(mono1_ds.PhotometricInterpretation) == "MONOCHROME1",
    )

    for f in manifest["files"]:
        ds = pydicom.dcmread(str(path_of(f)))
        text = str(ds)
        if "(7fe0, 0010)" not in text.lower():
            raise SystemExit(f"{f['file']}: pydicom's dump shows no pixel data")
    ok("every file reads as valid DICOM through pydicom's own dump", True)

    burned_ds = pydicom.dcmread(str(burned_in_path))
    burned_arr = burned_ds.pixel_array.astype("<u2")
    bb = manifest["files"][-1]["burnedInAnnotation"]["boundingBox"]
    mask = np.zeros_like(burned_arr, dtype=bool)
    mask[bb["rowStart"]:bb["rowEnd"], bb["colStart"]:bb["colEnd"]] = True
    ok(
        "burned-in.dcm declares NO, and the text bounding box contains maximum-value pixels while the region outside does not",
        str(burned_ds.BurnedInAnnotation) == "NO"
        and bool((burned_arr[mask] == BURNED_IN_MAX).any())
        and not bool((burned_arr[~mask] == BURNED_IN_MAX).any()),
    )

    # Re-derive from the bytes on disk a second time, independent of build_pixels_manifest's own
    # pass, so a corrupted round-trip (not a formula error - section 7 is the check for that) would
    # show up as a mismatch here rather than being silently trusted.
    mismatches: List[str] = []
    for f in manifest["files"]:
        if "expectedOutput" not in f:
            continue
        ds = pydicom.dcmread(str(directory / f["file"]))
        arr = ds.pixel_array.astype("<i2" if f["pixelRepresentation"] == 1 else "<u2")
        monochrome1 = f["photometricInterpretation"] == "MONOCHROME1"
        for window_key, center, width in (("expectedOutput", WINDOW_CENTER, WINDOW_WIDTH), ("expectedOutputSecondWindow", SECOND_WINDOW_CENTER, SECOND_WINDOW_WIDTH)):
            recomputed = expected_outputs(arr, monochrome1, center, width)
            if recomputed != f[window_key]:
                mismatches.append(f"{f['file']}/{window_key}")
    ok("the eight expected output values per file match what the formula in section 4 produces", not mismatches)


# --- 3.5: JPEG baseline (Process 1) fixtures - a DC-only encoder ---
#
# A general JPEG encoder is out of scope and unnecessary here. Every fixture image below is a grid
# of 8x8 blocks, each block one constant value. A block like that has a DC coefficient and nothing
# else: the forward DCT of a constant is exact, the quantiser (8, chosen so Q00 divides evenly) is
# exact, and the inverse on the decoding side is exact. These fixtures therefore have a zero (or,
# for the RGB file, a two-rounding-steps-wide) tolerance oracle without any JPEG library at all -
# see section 7's own note on why there is no expected-RGBA hash.

JPEG_BASELINE_UID = "1.2.840.10008.1.2.4.50"

JPEG_BLOCK_SIZE = 8

# Nine DC symbols (category 0-8: diff is in -255..255, so category never exceeds 8), one Huffman
# code per length 1-9. HUFFVAL in increasing category order gives each category t the code "t ones
# then a zero" once run through the standard's own Annex C.2 code-generation procedure below - not
# hand-assigned, so the DHT bytes actually written and the bits actually packed cannot drift apart.
JPEG_DC_BITS = [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]
JPEG_DC_HUFFVAL = [0, 1, 2, 3, 4, 5, 6, 7, 8]

# One AC symbol: end-of-block (0x00). Every block here has only a DC coefficient, so this is the
# only AC code this encoder will ever need.
JPEG_AC_BITS = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
JPEG_AC_HUFFVAL = [0]


def jpeg_huffman_codes(bits: List[int], huffval: List[int]) -> Dict[int, Tuple[int, int]]:
    """Annex C.2: derive each symbol's (code, length) from BITS/HUFFVAL - the same procedure a
    decoder uses to rebuild the table from the DHT marker, so there is exactly one source for what
    a symbol's code is, not a written table and a separately hand-assigned one."""
    sizes: List[int] = []
    for length, count in enumerate(bits, start=1):
        sizes.extend([length] * count)
    codes: List[int] = []
    code = 0
    size = sizes[0]
    i = 0
    while i < len(sizes):
        while i < len(sizes) and sizes[i] == size:
            codes.append(code)
            code += 1
            i += 1
        code <<= 1
        size += 1
    return {symbol: (c, s) for symbol, c, s in zip(huffval, codes, sizes)}


JPEG_DC_CODES = jpeg_huffman_codes(JPEG_DC_BITS, JPEG_DC_HUFFVAL)
JPEG_AC_CODES = jpeg_huffman_codes(JPEG_AC_BITS, JPEG_AC_HUFFVAL)


def jpeg_category(diff: int) -> int:
    """The number of bits needed for abs(diff): 2**(t-1) <= abs(diff) < 2**t, t=0 for diff=0."""
    return 0 if diff == 0 else abs(diff).bit_length()


def jpeg_value_bits(diff: int, t: int) -> int:
    """The t value bits that follow a non-zero category's Huffman code."""
    return diff if diff > 0 else diff + (1 << t) - 1


class JpegBitWriter:
    """Packs bits MSB-first into bytes, stuffing a 0x00 after every 0xFF byte produced - the
    encoder's own counterpart to a decoder's destuffing, required because 0xFF starts a marker."""

    def __init__(self) -> None:
        self.out = bytearray()
        self._buf = 0
        self._nbits = 0
        self.stuff_count = 0

    def _emit_byte(self, byte: int) -> None:
        self.out.append(byte)
        if byte == 0xFF:
            self.out.append(0x00)
            self.stuff_count += 1

    def put_bits(self, value: int, length: int) -> None:
        for i in range(length - 1, -1, -1):
            self._buf = (self._buf << 1) | ((value >> i) & 1)
            self._nbits += 1
            if self._nbits == 8:
                self._emit_byte(self._buf & 0xFF)
                self._buf = 0
                self._nbits = 0

    def finish(self) -> bytes:
        """Pads the final partial byte with 1 bits, per section 4 - stuffed like any other if that
        pad itself produces 0xFF."""
        if self._nbits > 0:
            pad = 8 - self._nbits
            self._buf = (self._buf << pad) | ((1 << pad) - 1)
            self._emit_byte(self._buf & 0xFF)
            self._buf = 0
            self._nbits = 0
        return bytes(self.out)


def _jpeg_u16(n: int) -> bytes:
    return n.to_bytes(2, "big")


def _jpeg_app0() -> bytes:
    data = b"JFIF\x00" + bytes([1, 1]) + bytes([0]) + _jpeg_u16(1) + _jpeg_u16(1) + bytes([0, 0])
    return b"\xFF\xE0" + _jpeg_u16(len(data) + 2) + data


def _jpeg_dqt() -> bytes:
    data = bytes([0x00]) + bytes([8] * 64)  # Pq=0, Tq=0; every entry 8 - zigzag is irrelevant here
    return b"\xFF\xDB" + _jpeg_u16(len(data) + 2) + data


def _jpeg_sof0(rows: int, columns: int, nf: int) -> bytes:
    data = bytes([8]) + _jpeg_u16(rows) + _jpeg_u16(columns) + bytes([nf])
    for ci in range(1, nf + 1):
        data += bytes([ci, 0x11, 0x00])  # H=1, V=1 (no subsampling), Tq=0
    return b"\xFF\xC0" + _jpeg_u16(len(data) + 2) + data


def _jpeg_dht(table_class: int, table_id: int, bits: List[int], huffval: List[int]) -> bytes:
    data = bytes([(table_class << 4) | table_id]) + bytes(bits) + bytes(huffval)
    return b"\xFF\xC4" + _jpeg_u16(len(data) + 2) + data


def _jpeg_sos(nf: int) -> bytes:
    data = bytes([nf])
    for cj in range(1, nf + 1):
        data += bytes([cj, 0x00])  # Td=0, Ta=0
    data += bytes([0x00, 0x3F, 0x00])  # Ss=0, Se=63, Ah/Al=0
    return b"\xFF\xDA" + _jpeg_u16(len(data) + 2) + data


def encode_jpeg_baseline(block_grids: List[np.ndarray], rows: int, columns: int) -> Tuple[bytes, int]:
    """`block_grids`: one or three (block_rows, block_cols) arrays of constant per-block sample
    values (0-255). Three components are written as interleaved MCUs (section 4's "MCU order"):
    one Y block, one Cb block, one Cr block per grid position, three independent DC predictors.
    Returns (the full JPEG byte string, the number of 0x00 stuff bytes inserted)."""
    nf = len(block_grids)
    block_rows, block_cols = block_grids[0].shape

    predictors = [0] * nf
    writer = JpegBitWriter()
    for by in range(block_rows):
        for bx in range(block_cols):
            for c in range(nf):
                v = int(block_grids[c][by, bx])
                s = v - 128
                diff = s - predictors[c]
                predictors[c] = s
                t = jpeg_category(diff)
                code, length = JPEG_DC_CODES[t]
                writer.put_bits(code, length)
                if t > 0:
                    writer.put_bits(jpeg_value_bits(diff, t), t)
                eob_code, eob_length = JPEG_AC_CODES[0x00]
                writer.put_bits(eob_code, eob_length)
    entropy = writer.finish()

    jpeg = bytearray()
    jpeg += b"\xFF\xD8"
    jpeg += _jpeg_app0()
    jpeg += _jpeg_dqt()
    jpeg += _jpeg_sof0(rows, columns, nf)
    jpeg += _jpeg_dht(0, 0, JPEG_DC_BITS, JPEG_DC_HUFFVAL)
    jpeg += _jpeg_dht(1, 0, JPEG_AC_BITS, JPEG_AC_HUFFVAL)
    jpeg += _jpeg_sos(nf)
    jpeg += entropy
    jpeg += b"\xFF\xD9"
    return bytes(jpeg), writer.stuff_count


def jpeg_rgb_to_ycbcr(r: int, g: int, b: int) -> Tuple[int, int, int]:
    """JFIF, rounded to nearest and clamped to 0-255 (section 4). Two roundings - this one and the
    decoder's own - are why the RGB fixture's oracle carries a +/-3 per-channel tolerance."""
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cb = -0.168736 * r - 0.331264 * g + 0.5 * b + 128
    cr = 0.5 * r - 0.418688 * g - 0.081312 * b + 128

    def clamp(x: float) -> int:
        return max(0, min(255, round(x)))

    return clamp(y), clamp(cb), clamp(cr)


# Nine symbols means nine category codes (0-8); JPEG_PATTERN_BLOCKS is 8x8 blocks of 8x8 pixels,
# 64x64 overall, matching PATTERN_SIZE's own footprint from the other pixel fixtures.
JPEG_PATTERN_GRID = 8


def pattern_jpeg_block_grid() -> np.ndarray:
    """Section 5: value(bx, by) = (160 if (bx+by) even else 96) + 2*by. The checkerboard makes
    every adjacent DC difference non-zero; the row term pushes several categories through the coder."""
    by, bx = np.mgrid[0:JPEG_PATTERN_GRID, 0:JPEG_PATTERN_GRID]
    base = np.where((bx + by) % 2 == 0, 160, 96)
    return (base + 2 * by).astype(int)


def pattern_jpeg_rgb_blocks() -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Section 5's R/G/B formulas, as (block_rows, block_cols) grids - not yet colour-converted."""
    by, bx = np.mgrid[0:JPEG_PATTERN_GRID, 0:JPEG_PATTERN_GRID]
    r = (32 + 28 * bx).astype(int)
    g = (32 + 28 * by).astype(int)
    b = np.where((bx + by) % 2 == 0, 160, 64).astype(int)
    return r, g, b


def pattern_jpeg_ycbcr_blocks() -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    r, g, b = pattern_jpeg_rgb_blocks()
    y = np.zeros_like(r)
    cb = np.zeros_like(r)
    cr = np.zeros_like(r)
    for by in range(JPEG_PATTERN_GRID):
        for bx in range(JPEG_PATTERN_GRID):
            y[by, bx], cb[by, bx], cr[by, bx] = jpeg_rgb_to_ycbcr(int(r[by, bx]), int(g[by, bx]), int(b[by, bx]))
    return y, cb, cr


BURNED_IN_JPEG_BLOCK_COLS = 60
BURNED_IN_JPEG_PHANTOM_BLOCK_ROWS = 24
BURNED_IN_JPEG_BLOCK_ROWS = 32
BURNED_IN_JPEG_ROWS = BURNED_IN_JPEG_BLOCK_ROWS * JPEG_BLOCK_SIZE  # 256
BURNED_IN_JPEG_COLUMNS = BURNED_IN_JPEG_BLOCK_COLS * JPEG_BLOCK_SIZE  # 480
BURNED_IN_JPEG_PHANTOM_MAX = 200
BURNED_IN_JPEG_STRIP_VALUE = 64
BURNED_IN_JPEG_TEXT_VALUE = 255
BURNED_IN_JPEG_TEXT_ROW0 = 25
BURNED_IN_JPEG_TEXT_COL0 = 3
BURNED_IN_JPEG_GLYPH_WIDTH = 4
BURNED_IN_JPEG_GLYPH_HEIGHT = 5
BURNED_IN_JPEG_GLYPH_STRIDE = 5  # 4 wide + 1 column of spacing

# 4x5 block glyphs - deliberately not the 8x12 pixel GLYPHS above, which are far larger than an
# 8-pixel block can usefully subdivide. Same seven distinct letters TESTPATIENT needs.
JPEG_GLYPHS: Dict[str, List[str]] = {
    "T": ["1111", "0110", "0110", "0110", "0110"],
    "E": ["1111", "1000", "1110", "1000", "1111"],
    "S": ["0111", "1000", "0110", "0001", "1110"],
    "P": ["1110", "1001", "1110", "1000", "1000"],
    "A": ["0110", "1001", "1111", "1001", "1001"],
    "I": ["1111", "0110", "0110", "0110", "1111"],
    "N": ["1001", "1101", "1011", "1001", "1001"],
}


def burned_in_jpeg_bounding_box() -> Tuple[int, int, int, int]:
    """(rowStart, colStart, rowEnd, colEnd) in BLOCK coordinates, end-exclusive."""
    width = len(BURNED_IN_TEXT) * BURNED_IN_JPEG_GLYPH_STRIDE - 1  # no trailing gap after the last character
    return (
        BURNED_IN_JPEG_TEXT_ROW0,
        BURNED_IN_JPEG_TEXT_COL0,
        BURNED_IN_JPEG_TEXT_ROW0 + BURNED_IN_JPEG_GLYPH_HEIGHT,
        BURNED_IN_JPEG_TEXT_COL0 + width,
    )


def burned_in_jpeg_blocks() -> np.ndarray:
    """480x256, 60x32 blocks (section 5): a phantom ceilinged at 200 in block rows 0-23, a flat
    strip at 64 in block rows 24-31, with TESTPATIENT at 255 in block rows 25-29."""
    phantom_rows = BURNED_IN_JPEG_PHANTOM_BLOCK_ROWS * JPEG_BLOCK_SIZE
    # Proportional to the phantom's own sampled region, the same reasoning 3.3 used for
    # burned-in.dcm's 128x128 version: DISC_RADIUS was tuned for a 256-row canvas.
    radius = DISC_RADIUS * phantom_rows // ROWS
    phantom = make_phantom(rows=phantom_rows, columns=BURNED_IN_JPEG_COLUMNS, radius=radius, seed=PHANTOM_SEED)

    sampled = np.zeros((BURNED_IN_JPEG_PHANTOM_BLOCK_ROWS, BURNED_IN_JPEG_BLOCK_COLS), dtype=float)
    for by in range(BURNED_IN_JPEG_PHANTOM_BLOCK_ROWS):
        for bx in range(BURNED_IN_JPEG_BLOCK_COLS):
            sampled[by, bx] = phantom[by * JPEG_BLOCK_SIZE + 4, bx * JPEG_BLOCK_SIZE + 4]
    lo, hi = float(sampled.min()), float(sampled.max())
    scaled = np.round((sampled - lo) / (hi - lo) * BURNED_IN_JPEG_PHANTOM_MAX).astype(int)

    blocks = np.full((BURNED_IN_JPEG_BLOCK_ROWS, BURNED_IN_JPEG_BLOCK_COLS), BURNED_IN_JPEG_STRIP_VALUE, dtype=int)
    blocks[0:BURNED_IN_JPEG_PHANTOM_BLOCK_ROWS, :] = scaled

    for i, ch in enumerate(BURNED_IN_TEXT):
        for gy, row in enumerate(JPEG_GLYPHS[ch]):
            for gx, bit in enumerate(row):
                if bit == "1":
                    by = BURNED_IN_JPEG_TEXT_ROW0 + gy
                    bx = BURNED_IN_JPEG_TEXT_COL0 + i * BURNED_IN_JPEG_GLYPH_STRIDE + gx
                    blocks[by, bx] = BURNED_IN_JPEG_TEXT_VALUE
    return blocks


JPEG_PATTERN_STUDY_UID = "2.25.424264068711928514640"  # sqrt(18)
JPEG_PATTERN_SERIES_UID = "2.25.435889894354067355223"  # sqrt(19)
JPEG_PATTERN_SOP_UID = "2.25.447213595499957939281"  # sqrt(20)
JPEG_RGB_STUDY_UID = "2.25.458257569495584000658"  # sqrt(21)
JPEG_RGB_SERIES_UID = "2.25.469041575982342955456"  # sqrt(22)
JPEG_RGB_SOP_UID = "2.25.479583152331271954159"  # sqrt(23)
BURNED_IN_JPEG_STUDY_UID = "2.25.489897948556635619639"  # sqrt(24)
BURNED_IN_JPEG_SERIES_UID = "2.25.509901951359278483002"  # sqrt(26)
BURNED_IN_JPEG_SOP_UID = "2.25.519615242270663188058"  # sqrt(27)


def build_jpeg_dataset(
    *,
    sop_uid: str,
    study_uid: str,
    series_uid: str,
    rows: int,
    columns: int,
    samples_per_pixel: int,
    photometric: str,
    patient_name: str,
    jpeg_fragment: bytes,
) -> Dataset:
    ds = Dataset()
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = SECONDARY_CAPTURE_STORAGE
    meta.MediaStorageSOPInstanceUID = sop_uid
    meta.TransferSyntaxUID = JPEG_BASELINE_UID
    meta.ImplementationClassUID = IMPLEMENTATION_CLASS_UID
    ds.file_meta = meta
    ds.preamble = b"\x00" * 128
    ds.is_little_endian = True
    ds.is_implicit_VR = False

    ds.SOPClassUID = SECONDARY_CAPTURE_STORAGE
    ds.SOPInstanceUID = sop_uid
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = series_uid
    ds.SeriesNumber = "1"
    ds.InstanceNumber = "1"
    ds.Modality = "OT"
    ds.ConversionType = "WSD"
    ds.PatientID = PIXELS_PATIENT_ID
    ds.PatientName = patient_name

    ds.Rows = rows
    ds.Columns = columns
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.PhotometricInterpretation = photometric
    ds.SamplesPerPixel = samples_per_pixel
    if samples_per_pixel == 3:
        ds.PlanarConfiguration = 0
    ds.LossyImageCompression = "01"
    ds.LossyImageCompressionMethod = "ISO_10918_1"

    # No RescaleSlope/Intercept/WindowCenter/WindowWidth, deliberately (section 5): this is 8-bit
    # lossy data a modality has already mapped, and these files carry no window at all.

    frag = DataElement(Tag(0x7FE00010), "OB", encapsulate([jpeg_fragment]))
    frag.is_undefined_length = True
    ds[0x7FE00010] = frag

    return ds


def parse_jpeg_markers(data: bytes) -> Dict[str, Any]:
    """A bespoke parser for exactly the marker sequence this encoder produces (section 8, checks 1
    and 3) - not a general JPEG parser. Raises on anything inconsistent."""
    if data[0:2] != b"\xFF\xD8":
        raise SystemExit("JPEG fragment does not start with SOI")
    pos = 2
    found: Dict[str, Any] = {}
    expected = [("APP0", 0xE0), ("DQT", 0xDB), ("SOF0", 0xC0), ("DHT0", 0xC4), ("DHT1", 0xC4), ("SOS", 0xDA)]
    for name, marker_code in expected:
        if data[pos] != 0xFF or data[pos + 1] != marker_code:
            raise SystemExit(f"expected marker {name} (FF {marker_code:02X}) at offset {pos}, found {data[pos:pos+2].hex()}")
        length = int.from_bytes(data[pos + 2 : pos + 4], "big")
        found[name] = {"offset": pos, "length": length, "data": data[pos + 4 : pos + 2 + length]}
        pos = pos + 2 + length
        if name == "SOS":
            entropy_start = pos

    # Entropy data to EOI, accounting for byte stuffing - any FF not followed by 00 must be D9.
    i = entropy_start
    while True:
        if data[i] == 0xFF:
            nxt = data[i + 1]
            if nxt == 0x00:
                i += 2
                continue
            if nxt == 0xD9:
                break
            raise SystemExit(f"entropy data has FF {nxt:02X} at offset {i}, neither a stuff byte nor EOI")
        i += 1
    found["entropy"] = data[entropy_start:i]
    found["EOI"] = {"offset": i}
    trailer = data[i + 2 :]
    # PS3.5 Annex A.4: an encapsulated fragment of odd length is padded to even with one 0x00 byte.
    # decode_data_sequence() hands back the fragment exactly as pydicom's encapsulate() wrote it, pad
    # included, so a well-formed fragment has either no trailer or exactly this one byte - never more.
    if trailer not in (b"", b"\x00"):
        raise SystemExit(f"{len(trailer)} unexpected byte(s) after EOI: {trailer.hex()}")
    if trailer == b"\x00" and (i + 2) % 2 == 0:
        raise SystemExit("one 0x00 byte after EOI, but the fragment was already even length")
    return found


def jpeg_fragment_manifest_entry(
    *,
    file_name: str,
    rows: int,
    columns: int,
    samples_per_pixel: int,
    planar_configuration: Optional[int],
    photometric: str,
    block_formula: str,
    jpeg_fragment: bytes,
    stuff_count: int,
    pixel_data: bytes,
    coords: List[dict],
    tolerance: int,
) -> dict:
    fp = DicomBytesIO(pixel_data)
    fp.is_little_endian = True
    has_bot, _offsets = get_frame_offsets(fp)
    fragments = decode_data_sequence(pixel_data)
    return {
        "file": file_name,
        "transferSyntaxUid": JPEG_BASELINE_UID,
        "rows": rows,
        "columns": columns,
        "bitsAllocated": 8,
        "bitsStored": 8,
        "highBit": 7,
        "pixelRepresentation": 0,
        "photometricInterpretation": photometric,
        "samplesPerPixel": samples_per_pixel,
        "planarConfiguration": planar_configuration,
        "numberOfFrames": 1,
        "blockSize": JPEG_BLOCK_SIZE,
        "blockFormula": block_formula,
        "jpegFragmentSha256": hashlib.sha256(jpeg_fragment).hexdigest(),
        "jpegFragmentLength": len(jpeg_fragment),
        "pixelDataSha256": hashlib.sha256(pixel_data).hexdigest(),
        "fragmentCount": len(fragments),
        "hasBasicOffsetTable": has_bot,
        "stuffByteCount": stuff_count,
        "expectedOutput": coords,
        "tolerance": tolerance,
    }


def build_jpeg_pixels(root: Path) -> None:
    directory = root / PIXELS_DIR_REL
    manifest_path = root / PIXELS_MANIFEST_REL
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    def ok(message: str, condition: bool) -> None:
        if not condition:
            raise SystemExit(f"jpeg pixel check FAILED: {message}")
        print(f"  ok  {message}")

    print("jpeg checks:")

    # --- pattern-jpeg.dcm ---
    pattern_blocks = pattern_jpeg_block_grid()
    pattern_rows = pattern_cols = JPEG_PATTERN_GRID * JPEG_BLOCK_SIZE
    pattern_jpeg_bytes, pattern_stuff = encode_jpeg_baseline([pattern_blocks], pattern_rows, pattern_cols)

    markers = parse_jpeg_markers(pattern_jpeg_bytes)
    ok(
        "pattern-jpeg.dcm's entropy data begins FD 03 F9 followed by the bits 111110",
        markers["entropy"][:3] == bytes.fromhex("fd03f9") and format(markers["entropy"][3], "08b")[:6] == "111110",
    )

    def coord_entries_grayscale(blocks: np.ndarray) -> List[dict]:
        coords = [(0, 0), (7, 0), (8, 0), (63, 0), (0, 63), (63, 63), (32, 32), (31, 32)]
        return [
            {"x": x, "y": y, "blockX": x // JPEG_BLOCK_SIZE, "blockY": y // JPEG_BLOCK_SIZE, "value": int(blocks[y // JPEG_BLOCK_SIZE, x // JPEG_BLOCK_SIZE])}
            for x, y in coords
        ]

    pattern_coords = coord_entries_grayscale(pattern_blocks)
    pattern_formula = "value(bx, by) = (160 if (bx + by) % 2 == 0 else 96) + 2 * by, for bx, by each in [0, 8)"

    datasets: Dict[str, Dataset] = {}
    datasets["pattern-jpeg.dcm"] = build_jpeg_dataset(
        sop_uid=JPEG_PATTERN_SOP_UID, study_uid=JPEG_PATTERN_STUDY_UID, series_uid=JPEG_PATTERN_SERIES_UID,
        rows=pattern_rows, columns=pattern_cols, samples_per_pixel=1, photometric="MONOCHROME2",
        patient_name="SCANLINT^PIXELTEST", jpeg_fragment=pattern_jpeg_bytes,
    )

    # --- pattern-jpeg-mono1.dcm: the same JPEG bytes, only PhotometricInterpretation differs ---
    datasets["pattern-jpeg-mono1.dcm"] = build_jpeg_dataset(
        sop_uid=JPEG_PATTERN_SOP_UID, study_uid=JPEG_PATTERN_STUDY_UID, series_uid=JPEG_PATTERN_SERIES_UID,
        rows=pattern_rows, columns=pattern_cols, samples_per_pixel=1, photometric="MONOCHROME1",
        patient_name="SCANLINT^PIXELTEST", jpeg_fragment=pattern_jpeg_bytes,
    )

    # --- pattern-jpeg-rgb.dcm ---
    y_blocks, cb_blocks, cr_blocks = pattern_jpeg_ycbcr_blocks()
    rgb_jpeg_bytes, rgb_stuff = encode_jpeg_baseline([y_blocks, cb_blocks, cr_blocks], pattern_rows, pattern_cols)
    r_blocks, g_blocks, b_blocks = pattern_jpeg_rgb_blocks()

    def coord_entries_rgb() -> List[dict]:
        coords = [(0, 0), (7, 0), (8, 0), (63, 0), (0, 63), (63, 63), (32, 32), (31, 32)]
        entries = []
        for x, y in coords:
            bx, by = x // JPEG_BLOCK_SIZE, y // JPEG_BLOCK_SIZE
            entries.append(
                {
                    "x": x, "y": y, "blockX": bx, "blockY": by,
                    "rgb": [int(r_blocks[by, bx]), int(g_blocks[by, bx]), int(b_blocks[by, bx])],
                    "ycbcr": [int(y_blocks[by, bx]), int(cb_blocks[by, bx]), int(cr_blocks[by, bx])],
                }
            )
        return entries

    datasets["pattern-jpeg-rgb.dcm"] = build_jpeg_dataset(
        sop_uid=JPEG_RGB_SOP_UID, study_uid=JPEG_RGB_STUDY_UID, series_uid=JPEG_RGB_SERIES_UID,
        rows=pattern_rows, columns=pattern_cols, samples_per_pixel=3, photometric="YBR_FULL",
        patient_name="SCANLINT^PIXELTEST", jpeg_fragment=rgb_jpeg_bytes,
    )

    # --- burned-in-jpeg.dcm ---
    burned_blocks = burned_in_jpeg_blocks()
    burned_jpeg_bytes, burned_stuff = encode_jpeg_baseline([burned_blocks], BURNED_IN_JPEG_ROWS, BURNED_IN_JPEG_COLUMNS)
    bb_row0, bb_col0, bb_row1, bb_col1 = burned_in_jpeg_bounding_box()

    def coord_entries_burned() -> List[dict]:
        coords = [
            (0, 0), (479, 191),  # phantom: top-left corner, far corner of the phantom region
            (0, 192), (479, 255),  # the flat strip, outside the text's own rows
            (24, 200), (71, 207),  # inside text blocks (T's and E's own glyph cells)
            (59, 204), (28, 212),  # inside the bounding box but not drawn: the inter-letter gap, and a 0 bit within T
        ]
        return [
            {"x": x, "y": y, "blockX": x // JPEG_BLOCK_SIZE, "blockY": y // JPEG_BLOCK_SIZE, "value": int(burned_blocks[y // JPEG_BLOCK_SIZE, x // JPEG_BLOCK_SIZE])}
            for x, y in coords
        ]

    burned_coords = coord_entries_burned()
    datasets["burned-in-jpeg.dcm"] = build_jpeg_dataset(
        sop_uid=BURNED_IN_JPEG_SOP_UID, study_uid=BURNED_IN_JPEG_STUDY_UID, series_uid=BURNED_IN_JPEG_SERIES_UID,
        rows=BURNED_IN_JPEG_ROWS, columns=BURNED_IN_JPEG_COLUMNS, samples_per_pixel=1, photometric="MONOCHROME2",
        patient_name="TESTPATIENT^SCANLINT", jpeg_fragment=burned_jpeg_bytes,
    )
    datasets["burned-in-jpeg.dcm"].BurnedInAnnotation = "NO"

    for name, ds in datasets.items():
        ds.save_as(str(directory / name), write_like_original=False)

    # --- section 8's checks ---

    for name, ds in datasets.items():
        markers_i = parse_jpeg_markers(bytes(decode_data_sequence(ds.PixelData)[0]))
        sof0 = markers_i["SOF0"]["data"]
        sof_rows = int.from_bytes(sof0[1:3], "big")
        sof_cols = int.from_bytes(sof0[3:5], "big")
        nf = sof0[5]
        sampling_ok = all(sof0[6 + 3 * k + 1] == 0x11 for k in range(nf))
        if not (sof_rows == ds.Rows and sof_cols == ds.Columns and nf == ds.SamplesPerPixel and sampling_ok):
            raise SystemExit(f"{name}: SOF0 does not match Rows/Columns/SamplesPerPixel, or sampling is not 1x1")
    ok("every SOF0 matches Rows/Columns/SamplesPerPixel, with every sampling factor 1", True)

    ok("the entropy data contains no 0xFF followed by anything other than 0x00 (checked while parsing markers)", True)

    ok(
        "pattern-jpeg.dcm and pattern-jpeg-mono1.dcm carry byte-identical JPEG fragments",
        decode_data_sequence(datasets["pattern-jpeg.dcm"].PixelData)[0] == decode_data_sequence(datasets["pattern-jpeg-mono1.dcm"].PixelData)[0],
    )

    for name, ds in datasets.items():
        fp = DicomBytesIO(ds.PixelData)
        fp.is_little_endian = True
        has_bot, _ = get_frame_offsets(fp)
        fragments = decode_data_sequence(ds.PixelData)
        if not (has_bot and len(fragments) == 1):
            raise SystemExit(f"{name}: expected a Basic Offset Table and exactly one fragment")
    ok("every file's encapsulated PixelData has a Basic Offset Table and exactly one fragment", True)

    for name, ds in datasets.items():
        text = str(pydicom.dcmread(str(directory / name)))
        if "(7fe0, 0010)" not in text.lower():
            raise SystemExit(f"{name}: pydicom's dump shows no pixel data")
    ok("every file reads as valid DICOM through pydicom's own dump", True)

    burned_ds = datasets["burned-in-jpeg.dcm"]
    inside = burned_blocks[bb_row0:bb_row1, bb_col0:bb_col1]
    outside_mask = np.ones_like(burned_blocks, dtype=bool)
    outside_mask[bb_row0:bb_row1, bb_col0:bb_col1] = False
    text_mask = np.zeros_like(burned_blocks, dtype=bool)
    for i, ch in enumerate(BURNED_IN_TEXT):
        for gy, row in enumerate(JPEG_GLYPHS[ch]):
            for gx, bit in enumerate(row):
                if bit == "1":
                    text_mask[BURNED_IN_JPEG_TEXT_ROW0 + gy, BURNED_IN_JPEG_TEXT_COL0 + i * BURNED_IN_JPEG_GLYPH_STRIDE + gx] = True
    ok(
        "burned-in-jpeg.dcm declares NO; every block in the text bounding box is 255 or 64, exactly "
        "the text blocks are 255, and no block outside it is 255",
        str(burned_ds.BurnedInAnnotation) == "NO"
        and bool(np.isin(inside, [BURNED_IN_JPEG_TEXT_VALUE, BURNED_IN_JPEG_STRIP_VALUE]).all())
        and bool((burned_blocks[text_mask] == BURNED_IN_JPEG_TEXT_VALUE).all())
        and bool((burned_blocks[bb_row0:bb_row1, bb_col0:bb_col1][~text_mask[bb_row0:bb_row1, bb_col0:bb_col1]] == BURNED_IN_JPEG_STRIP_VALUE).all())
        and not bool((burned_blocks[outside_mask] == BURNED_IN_JPEG_TEXT_VALUE).any()),
    )

    # --- manifest entries, appended to the one existing fixtures/pixels.manifest.json ---

    jpeg_entries = [
        jpeg_fragment_manifest_entry(
            file_name="pattern-jpeg.dcm", rows=pattern_rows, columns=pattern_cols, samples_per_pixel=1,
            planar_configuration=None, photometric="MONOCHROME2", block_formula=pattern_formula,
            jpeg_fragment=pattern_jpeg_bytes, stuff_count=pattern_stuff,
            pixel_data=datasets["pattern-jpeg.dcm"].PixelData, coords=pattern_coords, tolerance=0,
        ),
        {
            **jpeg_fragment_manifest_entry(
                file_name="pattern-jpeg-mono1.dcm", rows=pattern_rows, columns=pattern_cols, samples_per_pixel=1,
                planar_configuration=None, photometric="MONOCHROME1", block_formula=pattern_formula,
                jpeg_fragment=pattern_jpeg_bytes, stuff_count=pattern_stuff,
                pixel_data=datasets["pattern-jpeg-mono1.dcm"].PixelData, coords=pattern_coords, tolerance=0,
            ),
            "note": "expectedOutput here is the raw JPEG-decoded sample value, identical to "
                    "pattern-jpeg.dcm's because the JPEG bytes are identical - a decoder does not know "
                    "or care about PhotometricInterpretation. Whether and how a viewer inverts a "
                    "MONOCHROME1 image with no declared window is 3.6's question, not answered here.",
        },
        jpeg_fragment_manifest_entry(
            file_name="pattern-jpeg-rgb.dcm", rows=pattern_rows, columns=pattern_cols, samples_per_pixel=3,
            planar_configuration=0, photometric="YBR_FULL", block_formula=(
                "R(bx, by) = 32 + 28 * bx; G(bx, by) = 32 + 28 * by; "
                "B(bx, by) = 160 if (bx + by) % 2 == 0 else 64, for bx, by each in [0, 8)"
            ),
            jpeg_fragment=rgb_jpeg_bytes, stuff_count=rgb_stuff,
            pixel_data=datasets["pattern-jpeg-rgb.dcm"].PixelData, coords=coord_entries_rgb(), tolerance=3,
        ),
        {
            **jpeg_fragment_manifest_entry(
                file_name="burned-in-jpeg.dcm", rows=BURNED_IN_JPEG_ROWS, columns=BURNED_IN_JPEG_COLUMNS, samples_per_pixel=1,
                planar_configuration=None, photometric="MONOCHROME2", block_formula=(
                    "block rows 0-23: make_phantom, sampled at each block's centre, scaled to 0-200; "
                    "block rows 24-31: 64, except TESTPATIENT at 255 in block rows 25-29 starting at block column 3"
                ),
                jpeg_fragment=burned_jpeg_bytes, stuff_count=burned_stuff,
                pixel_data=burned_ds.PixelData, coords=burned_coords, tolerance=0,
            ),
            "burnedInAnnotation": {
                "declared": "NO",
                "deliberatelyFalse": True,
                "note": "The declaration is deliberately false, as burned-in.dcm's is and for the same "
                        "reason (3.1): the pixels contain the legible text 'TESTPATIENT' - matching this "
                        "file's own PatientName - while the metadata declares no burned-in annotation.",
                "text": BURNED_IN_TEXT,
                "boundingBox": {"rowStart": bb_row0 * JPEG_BLOCK_SIZE, "colStart": bb_col0 * JPEG_BLOCK_SIZE, "rowEnd": bb_row1 * JPEG_BLOCK_SIZE, "colEnd": bb_col1 * JPEG_BLOCK_SIZE},
                "textValue": BURNED_IN_JPEG_TEXT_VALUE,
                "stripValue": BURNED_IN_JPEG_STRIP_VALUE,
            },
        },
    ]

    manifest["files"].extend(jpeg_entries)
    manifest["jpegFormat"] = {
        "transferSyntaxUid": JPEG_BASELINE_UID,
        "note": "JPEG Baseline (Process 1), DC-coefficient-only: every fixture image is a grid of "
                "8x8 blocks, each block one constant value, encoded with a from-scratch encoder "
                "(see scripts/make-sample-study.py) rather than a general JPEG library. The DC "
                "Huffman table (class 0, id 0) has nine symbols, one per code length 1-9, assigning "
                "category t the code 't ones then a zero'; the AC table (class 1, id 0) has a "
                "single symbol, end-of-block, coded as the single bit 0. The quantisation table "
                "(id 0) has every entry equal to 8.",
        "noExpectedRgbaHash": "The generator has no JPEG decoder and will not acquire one, so there "
                "is no expected-RGBA hash here, unlike the uncompressed pixel fixtures. The oracle "
                "is the intended per-block values recorded in expectedOutput, plus tolerance - "
                "checked against a real decode in a browser in 3.6. This is deliberate, not an "
                "oversight.",
    }

    manifest_path.write_bytes((json.dumps(manifest, indent=2) + "\n").encode("utf-8"))

    print(f"wrote {len(jpeg_entries)} JPEG fixture(s) to {directory}")
    for name in ["pattern-jpeg.dcm", "pattern-jpeg-mono1.dcm", "pattern-jpeg-rgb.dcm", "burned-in-jpeg.dcm"]:
        p = directory / name
        print(f"  {name:<22} {p.stat().st_size:>7} bytes  sha256 {_sha(p)}")
    print(f"  stuff bytes: pattern-jpeg.dcm={pattern_stuff}  pattern-jpeg-rgb.dcm={rgb_stuff}  burned-in-jpeg.dcm={burned_stuff}  (pattern-jpeg-mono1.dcm shares pattern-jpeg.dcm's fragment)")
    print(f"wrote {manifest_path} ({manifest_path.stat().st_size} bytes, sha256 {_sha(manifest_path)})")


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
    build_pixels(root)
    build_jpeg_pixels(root)


if __name__ == "__main__":
    main()
