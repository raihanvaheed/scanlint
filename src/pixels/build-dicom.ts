// Builds minimal, syntactically valid DICOM byte buffers for tests, since no dependency is
// available to construct real ones the way pydicom does for the fixture generator. Shared by
// decode.test.ts and handle.test.ts so neither duplicates the other's byte-level plumbing.

export function u16le(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}
export function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
export function asciiPadded(s: string): Uint8Array {
  return new TextEncoder().encode(s.length % 2 === 0 ? s : s + "\0");
}
export function dsValue(v: number | number[]): Uint8Array {
  const s = Array.isArray(v) ? v.join("\\") : String(v);
  return new TextEncoder().encode(s.length % 2 === 0 ? s : s + " ");
}

const LONG_FORM_VRS = new Set(["OB", "OW", "OF", "SQ", "UT", "UN"]);

export function explicitElement(group: number, element: number, vr: string, value: Uint8Array): Uint8Array {
  const tag = concatBytes([u16le(group), u16le(element)]);
  const vrBytes = new TextEncoder().encode(vr);
  if (LONG_FORM_VRS.has(vr)) {
    return concatBytes([tag, vrBytes, new Uint8Array(2), u32le(value.length), value]);
  }
  return concatBytes([tag, vrBytes, u16le(value.length), value]);
}

export const PART10_PREAMBLE = new Uint8Array(128);
export const DICM_MAGIC = new TextEncoder().encode("DICM");

export type BuildOptions = {
  rows: number;
  columns: number;
  bitsAllocated: number;
  bitsStored: number;
  highBit: number;
  pixelRepresentation?: number;
  samplesPerPixel?: number;
  photometricInterpretation: string;
  planarConfiguration?: number;
  rescaleSlope?: number;
  rescaleIntercept?: number;
  windowCenter?: number | number[];
  windowWidth?: number | number[];
  numberOfFrames?: number;
  // Omit to build a file with no PixelData element at all. Mutually exclusive with pixelDataRaw.
  pixelData?: Uint8Array;
  // The full (7FE0,0010) element, tag through value, verbatim - for encapsulated pixel data (see
  // encapsulatedElement below) or any other shape pixelData's always-defined-length OW wrapping
  // cannot express. Mutually exclusive with pixelData.
  pixelDataRaw?: Uint8Array;
  transferSyntaxUid?: string;
};

// --- Encapsulated (undefined-length) pixel data: PS3.5 Annex A.4. buildDicom's `pixelData` option
// always writes a defined-length OW element, which cannot represent this, so these are built
// separately and passed in as `pixelDataRaw`.

const ITEM_TAG = concatBytes([u16le(0xfffe), u16le(0xe000)]);
const SEQUENCE_DELIMITATION_TAG = concatBytes([u16le(0xfffe), u16le(0xe0dd)]);
const UNDEFINED_LENGTH = Uint8Array.of(0xff, 0xff, 0xff, 0xff);

export function item(data: Uint8Array): Uint8Array {
  return concatBytes([ITEM_TAG, u32le(data.length), data]);
}

export function sequenceDelimitationItem(): Uint8Array {
  return concatBytes([SEQUENCE_DELIMITATION_TAG, u32le(0)]);
}

export function basicOffsetTable(offsets: number[]): Uint8Array {
  return item(concatBytes(offsets.map(u32le)));
}

// The encapsulated value of (7FE0,0010): a Basic Offset Table item (possibly empty), then one item
// per fragment, then the sequence delimitation item. `offsets` is passed straight to
// basicOffsetTable - an empty array is a present-but-empty BOT (section 7's case 3/4), not the same
// as omitting it; this function always writes one, since every real encapsulated element does.
export function encapsulatedValue(fragments: Uint8Array[], offsets: number[]): Uint8Array {
  return concatBytes([basicOffsetTable(offsets), ...fragments.map(item), sequenceDelimitationItem()]);
}

// A full (7FE0,0010) element with undefined length, wrapping `value` (normally encapsulatedValue's
// result) - the encapsulated counterpart to explicitElement, which can only write a defined length.
export function encapsulatedPixelDataElement(value: Uint8Array, vr: "OB" | "OW" = "OB"): Uint8Array {
  const tag = concatBytes([u16le(0x7fe0), u16le(0x0010)]);
  return concatBytes([tag, new TextEncoder().encode(vr), new Uint8Array(2), UNDEFINED_LENGTH, value]);
}

// The offsets a real Basic Offset Table would hold for `fragments`, in the order they will be
// written: each fragment's start, measured (per PS3.5 Annex A.4) from the byte right after the
// Basic Offset Table item itself - 8 bytes of item header (tag + length) precede each fragment's
// own data, so offset 0 is always the first fragment.
export function fragmentOffsets(fragments: Uint8Array[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const fragment of fragments) {
    offsets.push(offset);
    offset += 8 + fragment.length;
  }
  return offsets;
}

// Builds a minimal, syntactically valid Part 10 file: a 128-byte preamble, "DICM", a one-element
// File Meta group (just TransferSyntaxUID - dicom-parser needs nothing else), then the tags
// decodeImage actually reads.
export function buildDicom(opts: BuildOptions): Uint8Array {
  const meta = explicitElement(0x0002, 0x0010, "UI", asciiPadded(opts.transferSyntaxUid ?? "1.2.840.10008.1.2.1"));

  const elements: Uint8Array[] = [
    explicitElement(0x0028, 0x0002, "US", u16le(opts.samplesPerPixel ?? 1)),
    explicitElement(0x0028, 0x0004, "CS", asciiPadded(opts.photometricInterpretation)),
  ];
  if (opts.numberOfFrames !== undefined) elements.push(explicitElement(0x0028, 0x0008, "IS", dsValue(opts.numberOfFrames)));
  if (opts.planarConfiguration !== undefined) elements.push(explicitElement(0x0028, 0x0006, "US", u16le(opts.planarConfiguration)));
  elements.push(
    explicitElement(0x0028, 0x0010, "US", u16le(opts.rows)),
    explicitElement(0x0028, 0x0011, "US", u16le(opts.columns)),
    explicitElement(0x0028, 0x0100, "US", u16le(opts.bitsAllocated)),
    explicitElement(0x0028, 0x0101, "US", u16le(opts.bitsStored)),
    explicitElement(0x0028, 0x0102, "US", u16le(opts.highBit)),
    explicitElement(0x0028, 0x0103, "US", u16le(opts.pixelRepresentation ?? 0)),
  );
  if (opts.rescaleIntercept !== undefined) elements.push(explicitElement(0x0028, 0x1052, "DS", dsValue(opts.rescaleIntercept)));
  if (opts.rescaleSlope !== undefined) elements.push(explicitElement(0x0028, 0x1053, "DS", dsValue(opts.rescaleSlope)));
  if (opts.windowCenter !== undefined) elements.push(explicitElement(0x0028, 0x1050, "DS", dsValue(opts.windowCenter)));
  if (opts.windowWidth !== undefined) elements.push(explicitElement(0x0028, 0x1051, "DS", dsValue(opts.windowWidth)));
  if (opts.pixelData !== undefined && opts.pixelDataRaw !== undefined) throw new Error("buildDicom: pixelData and pixelDataRaw are mutually exclusive");
  if (opts.pixelData !== undefined) elements.push(explicitElement(0x7fe0, 0x0010, "OW", opts.pixelData));
  if (opts.pixelDataRaw !== undefined) elements.push(opts.pixelDataRaw);

  return concatBytes([PART10_PREAMBLE, DICM_MAGIC, meta, ...elements]);
}

// Encodes one stored (post-sign-extension) value into the on-disk bit pattern BitsStored/HighBit
// describe - the inverse of decodeImage's own extraction, so a test can assert the extraction
// undoes exactly this.
export function encodeWord(storedValue: number, bitsStored: number, highBit: number): number {
  const shift = highBit + 1 - bitsStored;
  const mask = (1 << bitsStored) - 1;
  return ((storedValue & mask) << shift) & 0xffff;
}
export function words16(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint16(i * 2, v, true));
  return out;
}
export function bytes8(values: number[]): Uint8Array {
  return new Uint8Array(values.map((v) => v & 0xff));
}
