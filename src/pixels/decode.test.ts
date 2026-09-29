import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseDicom } from "dicom-parser";
import { decodeImage } from "./decode";
import { extractFrameBytes } from "./pixel-data";

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES_DIR = path.join(ROOT, "fixtures", "pixels");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "pixels.manifest.json"), "utf8"));

function readFixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES_DIR, name)));
}

function manifestEntry(name: string) {
  const entry = manifest.files.find((f: { file: string }) => f.file === name);
  if (!entry) throw new Error(`No manifest entry for ${name}`);
  return entry;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// The raw stored-value pixel array for a file's frame 0, exactly as the manifest's own
// pixelArraySha256 was computed over: little-endian sample bytes, decompressed if the transfer
// syntax compressed them, but not yet bit-extracted, rescaled or windowed.
function rawPixelArrayBytes(bytes: Uint8Array): Uint8Array {
  const dataSet = parseDicom(bytes);
  const rows = dataSet.uint16("x00280010")!;
  const columns = dataSet.uint16("x00280011")!;
  const bitsAllocated = dataSet.uint16("x00280100")!;
  const pixelDataElement = dataSet.elements.x7fe00010;
  return extractFrameBytes(dataSet, pixelDataElement, 0, rows * columns, 1, bitsAllocated / 8);
}

const WINDOW = { center: manifest.window.center, width: manifest.window.width };
const SECOND_WINDOW = { center: manifest.secondWindow.center, width: manifest.secondWindow.width };

describe("decodeImage against the 3.1 manifest", () => {
  const PATTERN_FILES = ["pattern-explicit.dcm", "pattern-implicit.dcm", "pattern-rle.dcm", "pattern-mono1.dcm", "pattern-signed.dcm"];

  it.each(PATTERN_FILES)("%s: decoded raw pixel array matches the recorded sha256", (name) => {
    const entry = manifestEntry(name);
    const raw = rawPixelArrayBytes(readFixture(name));
    expect(sha256(raw)).toBe(entry.pixelArraySha256);
  });

  it("pattern-explicit, pattern-implicit and pattern-rle decode identically", () => {
    const explicit = decodeImage(readFixture("pattern-explicit.dcm"));
    const implicit = decodeImage(readFixture("pattern-implicit.dcm"));
    const rle = decodeImage(readFixture("pattern-rle.dcm"));

    expect(implicit.rgba).toEqual(explicit.rgba);
    expect(rle.rgba).toEqual(explicit.rgba);
    expect(implicit.width).toBe(explicit.width);
    expect(implicit.height).toBe(explicit.height);
  });

  it.each(PATTERN_FILES)("%s: all eight recorded coordinates match under the declared window", (name) => {
    const entry = manifestEntry(name);
    const { width, rgba } = decodeImage(readFixture(name), { window: WINDOW });

    for (const point of entry.expectedOutput) {
      const i = (point.y * width + point.x) * 4;
      expect([rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]], `${name} (${point.x},${point.y})`).toEqual([point.grey, point.grey, point.grey, 255]);
    }
  });

  it.each(PATTERN_FILES)("%s: all eight recorded coordinates match under the second window", (name) => {
    const entry = manifestEntry(name);
    const { width, rgba } = decodeImage(readFixture(name), { window: SECOND_WINDOW });

    for (const point of entry.expectedOutputSecondWindow) {
      const i = (point.y * width + point.x) * 4;
      expect([rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]], `${name} (${point.x},${point.y})`).toEqual([point.grey, point.grey, point.grey, 255]);
    }
  });

  it("the signed variant's corner values run -2048 to 2047", () => {
    const entry = manifestEntry("pattern-signed.dcm");
    const zero = entry.expectedOutput.find((p: { x: number; y: number }) => p.x === 0 && p.y === 0);
    const last = entry.expectedOutput.find((p: { x: number; y: number }) => p.x === 63 && p.y === 63);
    expect(zero.stored).toBe(-2048);
    expect(last.stored).toBe(2047);
  });

  it("mono1's output is 255-x of explicit's at every pixel (declared window)", () => {
    const explicit = decodeImage(readFixture("pattern-explicit.dcm"), { window: WINDOW });
    const mono1 = decodeImage(readFixture("pattern-mono1.dcm"), { window: WINDOW });

    for (let i = 0; i < explicit.rgba.length; i += 4) {
      expect(mono1.rgba[i]).toBe(255 - explicit.rgba[i]);
      expect(mono1.rgba[i + 1]).toBe(255 - explicit.rgba[i + 1]);
      expect(mono1.rgba[i + 2]).toBe(255 - explicit.rgba[i + 2]);
      expect(mono1.rgba[i + 3]).toBe(255); // alpha is untouched by the inversion
    }
  });

  // Section 7: burned-in.dcm declares no RescaleSlope/Intercept/WindowCenter/WindowWidth at all
  // (confirmed against the manifest below), so decoding it exercises the no-declared-window
  // fallback exclusively. That fallback must actually separate the text from the background, or
  // 3.1's fixture proves nothing - this is that proof, not a legibility judgement.
  it("burned-in.dcm declares no window, and the text is visible after windowing with the fallback", () => {
    const entry = manifestEntry("burned-in.dcm");
    expect(entry.rescaleSlope).toBeUndefined();
    expect(entry.rescaleIntercept).toBeUndefined();
    expect(entry.windowCenter).toBeUndefined();
    expect(entry.windowWidth).toBeUndefined();

    const { width, height, rgba } = decodeImage(readFixture("burned-in.dcm"));
    const box = entry.burnedInAnnotation.boundingBox;

    let insideSum = 0;
    let insideCount = 0;
    let outsideSum = 0;
    let outsideCount = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const grey = rgba[(y * width + x) * 4];
        const inside = y >= box.rowStart && y < box.rowEnd && x >= box.colStart && x < box.colEnd;
        if (inside) {
          insideSum += grey;
          insideCount++;
        } else {
          outsideSum += grey;
          outsideCount++;
        }
      }
    }

    const meanInside = insideSum / insideCount;
    const meanOutside = outsideSum / outsideCount;
    expect(Math.abs(meanInside - meanOutside)).toBeGreaterThanOrEqual(64);
  });
});

// The hand-worked anchor from 3.1's own PR description, typed here as literals rather than read
// from the manifest - the two can't talk each other into the same mistake this way.
describe("the hand-worked anchor (pattern-explicit, window center 0 width 400)", () => {
  const { width, rgba } = decodeImage(readFixture("pattern-explicit.dcm"), { window: { center: 0, width: 400 } });
  const greyAt = (x: number, y: number) => rgba[(y * width + x) * 4];

  it("(0,0): stored 0, rescaled -1024, grey 0", () => {
    expect(greyAt(0, 0)).toBe(0);
  });

  it("(63,63): stored 4095, rescaled 7166, grey 255", () => {
    expect(greyAt(63, 63)).toBe(255);
  });

  it("(0,7): stored 448, rescaled -128, grey 46", () => {
    expect(greyAt(0, 7)).toBe(46);
  });
});

// --- Constructed cases: minimal DICOM byte buffers, built by hand, for situations the fixtures
// from 3.1 don't reach. Everything is Explicit VR Little Endian unless the test says otherwise.

function u16le(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}
function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
function asciiPadded(s: string): Uint8Array {
  return new TextEncoder().encode(s.length % 2 === 0 ? s : s + "\0");
}
function dsValue(v: number | number[]): Uint8Array {
  const s = Array.isArray(v) ? v.join("\\") : String(v);
  return new TextEncoder().encode(s.length % 2 === 0 ? s : s + " ");
}

const LONG_FORM_VRS = new Set(["OB", "OW", "OF", "SQ", "UT", "UN"]);

function explicitElement(group: number, element: number, vr: string, value: Uint8Array): Uint8Array {
  const tag = concatBytes([u16le(group), u16le(element)]);
  const vrBytes = new TextEncoder().encode(vr);
  if (LONG_FORM_VRS.has(vr)) {
    return concatBytes([tag, vrBytes, new Uint8Array(2), u32le(value.length), value]);
  }
  return concatBytes([tag, vrBytes, u16le(value.length), value]);
}

const PART10_PREAMBLE = new Uint8Array(128);
const DICM_MAGIC = new TextEncoder().encode("DICM");

type BuildOptions = {
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
  pixelData: Uint8Array;
  transferSyntaxUid?: string;
};

// Builds a minimal, syntactically valid Part 10 file: a 128-byte preamble, "DICM", a one-element
// File Meta group (just TransferSyntaxUID - dicom-parser needs nothing else), then the tags
// decodeImage actually reads.
function buildDicom(opts: BuildOptions): Uint8Array {
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
  elements.push(explicitElement(0x7fe0, 0x0010, "OW", opts.pixelData));

  return concatBytes([PART10_PREAMBLE, DICM_MAGIC, meta, ...elements]);
}

// Encodes one stored (post-sign-extension) value into the on-disk bit pattern BitsStored/HighBit
// describe - the inverse of decodeImage's own extraction, so a test can assert the extraction
// undoes exactly this.
function encodeWord(storedValue: number, bitsStored: number, highBit: number): number {
  const shift = highBit + 1 - bitsStored;
  const mask = (1 << bitsStored) - 1;
  return ((storedValue & mask) << shift) & 0xffff;
}
function words16(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint16(i * 2, v, true));
  return out;
}
function bytes8(values: number[]): Uint8Array {
  return new Uint8Array(values.map((v) => v & 0xff));
}

describe("decodeImage: constructed edge cases", () => {
  it("a shifted HighBit (BitsStored 12, HighBit 15) extracts correctly", () => {
    const words = [0, 2048, 4095].map((v) => encodeWord(v, 12, 15));
    const bytes = buildDicom({
      rows: 1,
      columns: 3,
      bitsAllocated: 16,
      bitsStored: 12,
      highBit: 15,
      photometricInterpretation: "MONOCHROME2",
      pixelData: words16(words),
    });

    const { rgba } = decodeImage(bytes, { window: { center: 2047.5, width: 4095 } });
    expect([rgba[0], rgba[4], rgba[8]]).toEqual([0, 128, 255]);
  });

  it("reading a signed value as unsigned would give a different (wrong) result", () => {
    // Both files store the same bit pattern (0xFFF, all ones in 12 bits): -1 signed, 4095 unsigned.
    const word = encodeWord(-1, 12, 11);
    const commonOpts = {
      rows: 1,
      columns: 1,
      bitsAllocated: 16,
      bitsStored: 12,
      highBit: 11,
      photometricInterpretation: "MONOCHROME2",
      pixelData: words16([word]),
      windowCenter: 2047,
      windowWidth: 8190,
    };

    const signed = decodeImage(buildDicom({ ...commonOpts, pixelRepresentation: 1 }));
    const unsigned = decodeImage(buildDicom({ ...commonOpts, pixelRepresentation: 0 }));

    expect(signed.rgba[0]).toBe(64);
    expect(unsigned.rgba[0]).toBe(191);
    expect(signed.rgba[0]).not.toBe(unsigned.rgba[0]);
  });

  it("the exact lower threshold value maps to 0, one above does not (window center 0, width 100)", () => {
    const bytes = buildDicom({
      rows: 1,
      columns: 2,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      pixelRepresentation: 1,
      photometricInterpretation: "MONOCHROME2",
      pixelData: bytes8([-50, -49]),
      windowCenter: 0,
      windowWidth: 100,
    });
    const { rgba } = decodeImage(bytes);
    expect(rgba[0]).toBe(0); // -50 is exactly the low threshold
    expect(rgba[4]).not.toBe(0); // -49 is one above it
    expect(rgba[4]).toBe(3);
  });

  it("the exact upper threshold value maps to 255, one below does not (window center 0, width 100)", () => {
    const bytes = buildDicom({
      rows: 1,
      columns: 2,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      pixelRepresentation: 1,
      photometricInterpretation: "MONOCHROME2",
      pixelData: bytes8([48, 49]),
      windowCenter: 0,
      windowWidth: 100,
    });
    const { rgba } = decodeImage(bytes);
    expect(rgba[4]).toBe(255); // 49 is exactly the high threshold
    expect(rgba[0]).not.toBe(255); // 48 is one below it
    expect(rgba[0]).toBe(252);
  });

  it("no declared window falls back to the data's own rescaled range", () => {
    const bytes = buildDicom({
      rows: 1,
      columns: 3,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      photometricInterpretation: "MONOCHROME2",
      pixelData: bytes8([10, 50, 90]),
    });
    const { rgba } = decodeImage(bytes);
    expect([rgba[0], rgba[4], rgba[8]]).toEqual([0, 129, 255]);
  });

  it("a multi-valued WindowCenter/WindowWidth takes only the first value", () => {
    const bytes = buildDicom({
      rows: 1,
      columns: 1,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      photometricInterpretation: "MONOCHROME2",
      pixelData: bytes8([100]),
      windowCenter: [100, 9999],
      windowWidth: [50, 1],
    });
    const { rgba } = decodeImage(bytes);
    expect(rgba[0]).toBe(130);
  });

  it("a uniform image (max equals min) does not divide by zero", () => {
    const bytes = buildDicom({
      rows: 1,
      columns: 2,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      photometricInterpretation: "MONOCHROME2",
      pixelData: bytes8([77, 77]),
    });
    const { rgba } = decodeImage(bytes);
    expect(Number.isFinite(rgba[0])).toBe(true);
    expect(Number.isFinite(rgba[4])).toBe(true);
    expect(rgba[0]).toBe(255);
    expect(rgba[4]).toBe(255);
  });

  it("Explicit VR Big Endian throws, naming the reason", () => {
    // The transfer syntax alone is enough for decodeImage to refuse, before it looks at any other
    // attribute - but dicom-parser still needs a byte of real (big-endian) dataset content to parse
    // past the meta header at all, so one harmless element (Rows) follows it.
    const meta = explicitElement(0x0002, 0x0010, "UI", asciiPadded("1.2.840.10008.1.2.2"));
    const rowsBigEndian = concatBytes([Uint8Array.of(0x00, 0x28, 0x00, 0x10), new TextEncoder().encode("US"), Uint8Array.of(0x00, 0x02), Uint8Array.of(0x00, 0x01)]);
    const bytes = concatBytes([PART10_PREAMBLE, DICM_MAGIC, meta, rowsBigEndian]);
    expect(() => decodeImage(bytes)).toThrow(/Big Endian/);
  });

  it("PlanarConfiguration 1 throws, naming the reason", () => {
    const bytes = buildDicom({
      rows: 1,
      columns: 1,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      samplesPerPixel: 3,
      photometricInterpretation: "RGB",
      planarConfiguration: 1,
      pixelData: bytes8([1, 2, 3]),
    });
    expect(() => decodeImage(bytes)).toThrow(/PlanarConfiguration/);
  });

  it("PALETTE COLOR throws, naming the reason", () => {
    const bytes = buildDicom({
      rows: 1,
      columns: 1,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      photometricInterpretation: "PALETTE COLOR",
      pixelData: bytes8([1]),
    });
    expect(() => decodeImage(bytes)).toThrow(/PALETTE COLOR/);
  });

  it("YBR_FULL throws, naming the reason", () => {
    const bytes = buildDicom({
      rows: 1,
      columns: 1,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      samplesPerPixel: 3,
      photometricInterpretation: "YBR_FULL",
      planarConfiguration: 0,
      pixelData: bytes8([1, 2, 3]),
    });
    expect(() => decodeImage(bytes)).toThrow(/YBR_FULL/);
  });

  it("interleaved RGB (SamplesPerPixel 3, PlanarConfiguration 0) passes through unwindowed", () => {
    const bytes = buildDicom({
      rows: 1,
      columns: 2,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      samplesPerPixel: 3,
      photometricInterpretation: "RGB",
      planarConfiguration: 0,
      pixelData: bytes8([10, 20, 30, 200, 150, 100]),
    });
    const { rgba } = decodeImage(bytes);
    expect(Array.from(rgba)).toEqual([10, 20, 30, 255, 200, 150, 100, 255]);
  });

  it("a frame index out of range throws, naming the reason", () => {
    const bytes = buildDicom({
      rows: 1,
      columns: 1,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      photometricInterpretation: "MONOCHROME2",
      pixelData: bytes8([0]),
    });
    expect(() => decodeImage(bytes, { frame: 1 })).toThrow(/[Ff]rame/);
  });
});
