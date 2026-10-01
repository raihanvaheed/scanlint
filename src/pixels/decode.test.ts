import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseDicom } from "dicom-parser";
import { decodeImage } from "./decode";
import { extractFrameBytes } from "./pixel-data";
import { PART10_PREAMBLE, DICM_MAGIC, asciiPadded, buildDicom, bytes8, concatBytes, encodeWord, explicitElement, words16 } from "./build-dicom";

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES_DIR = path.join(ROOT, "fixtures", "pixels");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "pixels.manifest.json"), "utf8"));

function manifestEntry(name: string) {
  const entry = manifest.files.find((f: { file: string }) => f.file === name);
  if (!entry) throw new Error(`No manifest entry for ${name}`);
  return entry;
}

// burned-in.dcm ships as a second sample (3.4a), not a fixture - its manifest entry carries its own
// "directory", which this honours rather than assuming every file lives in fixtures/pixels/.
function readFixture(name: string): Uint8Array {
  const entry = manifestEntry(name);
  const dir = entry.directory ? path.join(ROOT, entry.directory) : FIXTURES_DIR;
  return new Uint8Array(fs.readFileSync(path.join(dir, name)));
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

    const { width, height, rgba, window } = decodeImage(readFixture("burned-in.dcm"));
    expect(window).toEqual({ center: 2149.5, width: 3891 }); // (204+4095)/2, 4095-204 - the fallback, over the whole image
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

  it("echoes back the window that was actually applied", () => {
    expect(decodeImage(readFixture("pattern-explicit.dcm"), { window: { center: 0, width: 400 } }).window).toEqual({ center: 0, width: 400 });
  });
});

// --- Constructed cases: minimal DICOM byte buffers, built by hand, for situations the fixtures
// from 3.1 don't reach. Everything is Explicit VR Little Endian unless the test says otherwise.

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
    const { rgba, window } = decodeImage(bytes);
    expect(Array.from(rgba)).toEqual([10, 20, 30, 255, 200, 150, 100, 255]);
    expect(window).toBeUndefined();
  });

  // A DICOMDIR or a structured report has neither Rows nor PixelData - "no pixel data" must win
  // over "missing required attribute Rows", or the message misleads about what's actually wrong.
  it("a file with no image geometry at all (a DICOMDIR's own shape) says there is no pixel data, not that Rows is missing", () => {
    const meta = explicitElement(0x0002, 0x0010, "UI", asciiPadded("1.2.840.10008.1.2.1"));
    // One harmless, unrelated element - a DICOMDIR has plenty of its own tags, just none about an
    // image - and dicom-parser needs at least one byte of main-dataset content to parse at all.
    const fileSetId = explicitElement(0x0004, 0x1130, "CS", asciiPadded("SCANLINT"));
    const bytes = concatBytes([PART10_PREAMBLE, DICM_MAGIC, meta, fileSetId]);
    expect(() => decodeImage(bytes)).toThrow("No pixel data (7FE0,0010) in this file");
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
