import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseDicom } from "dicom-parser";
import { decodeImage } from "./decode";
import { UnsupportedFormatError, UnsupportedSyntaxError } from "./errors";
import { extractFrameBytes } from "./pixel-data";
import {
  PART10_PREAMBLE,
  DICM_MAGIC,
  asciiPadded,
  buildDicom,
  bytes8,
  concatBytes,
  encapsulatedPixelDataElement,
  encapsulatedValue,
  encodeWord,
  explicitElement,
  words16,
} from "./build-dicom";
import transferSyntaxRegistry from "./transfer-syntaxes.json";

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

  it("pattern-explicit, pattern-implicit and pattern-rle decode identically", async () => {
    const explicit = await decodeImage(readFixture("pattern-explicit.dcm"));
    const implicit = await decodeImage(readFixture("pattern-implicit.dcm"));
    const rle = await decodeImage(readFixture("pattern-rle.dcm"));

    expect(implicit.rgba).toEqual(explicit.rgba);
    expect(rle.rgba).toEqual(explicit.rgba);
    expect(implicit.width).toBe(explicit.width);
    expect(implicit.height).toBe(explicit.height);
  });

  it.each(PATTERN_FILES)("%s: all eight recorded coordinates match under the declared window", async (name) => {
    const entry = manifestEntry(name);
    const { width, rgba } = await decodeImage(readFixture(name), { window: WINDOW });

    for (const point of entry.expectedOutput) {
      const i = (point.y * width + point.x) * 4;
      expect([rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]], `${name} (${point.x},${point.y})`).toEqual([point.grey, point.grey, point.grey, 255]);
    }
  });

  it.each(PATTERN_FILES)("%s: all eight recorded coordinates match under the second window", async (name) => {
    const entry = manifestEntry(name);
    const { width, rgba } = await decodeImage(readFixture(name), { window: SECOND_WINDOW });

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

  it("mono1's output is 255-x of explicit's at every pixel (declared window)", async () => {
    const explicit = await decodeImage(readFixture("pattern-explicit.dcm"), { window: WINDOW });
    const mono1 = await decodeImage(readFixture("pattern-mono1.dcm"), { window: WINDOW });

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
  it("burned-in.dcm declares no window, and the text is visible after windowing with the fallback", async () => {
    const entry = manifestEntry("burned-in.dcm");
    expect(entry.rescaleSlope).toBeUndefined();
    expect(entry.rescaleIntercept).toBeUndefined();
    expect(entry.windowCenter).toBeUndefined();
    expect(entry.windowWidth).toBeUndefined();

    const { width, height, rgba, window } = await decodeImage(readFixture("burned-in.dcm"));
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
  let width: number;
  let rgba: Uint8ClampedArray;

  beforeAll(async () => {
    ({ width, rgba } = await decodeImage(readFixture("pattern-explicit.dcm"), { window: { center: 0, width: 400 } }));
  });

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

  it("echoes back the window that was actually applied", async () => {
    expect((await decodeImage(readFixture("pattern-explicit.dcm"), { window: { center: 0, width: 400 } })).window).toEqual({ center: 0, width: 400 });
  });
});

// --- Constructed cases: minimal DICOM byte buffers, built by hand, for situations the fixtures
// from 3.1 don't reach. Everything is Explicit VR Little Endian unless the test says otherwise.

describe("decodeImage: constructed edge cases", () => {
  it("a shifted HighBit (BitsStored 12, HighBit 15) extracts correctly", async () => {
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

    const { rgba } = await decodeImage(bytes, { window: { center: 2047.5, width: 4095 } });
    expect([rgba[0], rgba[4], rgba[8]]).toEqual([0, 128, 255]);
  });

  it("reading a signed value as unsigned would give a different (wrong) result", async () => {
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

    const signed = await decodeImage(buildDicom({ ...commonOpts, pixelRepresentation: 1 }));
    const unsigned = await decodeImage(buildDicom({ ...commonOpts, pixelRepresentation: 0 }));

    expect(signed.rgba[0]).toBe(64);
    expect(unsigned.rgba[0]).toBe(191);
    expect(signed.rgba[0]).not.toBe(unsigned.rgba[0]);
  });

  it("the exact lower threshold value maps to 0, one above does not (window center 0, width 100)", async () => {
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
    const { rgba } = await decodeImage(bytes);
    expect(rgba[0]).toBe(0); // -50 is exactly the low threshold
    expect(rgba[4]).not.toBe(0); // -49 is one above it
    expect(rgba[4]).toBe(3);
  });

  it("the exact upper threshold value maps to 255, one below does not (window center 0, width 100)", async () => {
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
    const { rgba } = await decodeImage(bytes);
    expect(rgba[4]).toBe(255); // 49 is exactly the high threshold
    expect(rgba[0]).not.toBe(255); // 48 is one below it
    expect(rgba[0]).toBe(252);
  });

  it("no declared window falls back to the data's own rescaled range", async () => {
    const bytes = buildDicom({
      rows: 1,
      columns: 3,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      photometricInterpretation: "MONOCHROME2",
      pixelData: bytes8([10, 50, 90]),
    });
    const { rgba } = await decodeImage(bytes);
    expect([rgba[0], rgba[4], rgba[8]]).toEqual([0, 129, 255]);
  });

  it("a multi-valued WindowCenter/WindowWidth takes only the first value", async () => {
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
    const { rgba } = await decodeImage(bytes);
    expect(rgba[0]).toBe(130);
  });

  it("a uniform image (max equals min) does not divide by zero", async () => {
    const bytes = buildDicom({
      rows: 1,
      columns: 2,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      photometricInterpretation: "MONOCHROME2",
      pixelData: bytes8([77, 77]),
    });
    const { rgba } = await decodeImage(bytes);
    expect(Number.isFinite(rgba[0])).toBe(true);
    expect(Number.isFinite(rgba[4])).toBe(true);
    expect(rgba[0]).toBe(255);
    expect(rgba[4]).toBe(255);
  });

  it("Explicit VR Big Endian throws, naming the reason", async () => {
    // The transfer syntax alone is enough for decodeImage to refuse, before it looks at any other
    // attribute - but dicom-parser still needs a byte of real (big-endian) dataset content to parse
    // past the meta header at all, so one harmless element (Rows) follows it.
    const meta = explicitElement(0x0002, 0x0010, "UI", asciiPadded("1.2.840.10008.1.2.2"));
    const rowsBigEndian = concatBytes([Uint8Array.of(0x00, 0x28, 0x00, 0x10), new TextEncoder().encode("US"), Uint8Array.of(0x00, 0x02), Uint8Array.of(0x00, 0x01)]);
    const bytes = concatBytes([PART10_PREAMBLE, DICM_MAGIC, meta, rowsBigEndian]);
    await expect(decodeImage(bytes)).rejects.toThrow(/Big Endian/);
  });

  it("PlanarConfiguration 1 throws, naming the reason", async () => {
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
    await expect(decodeImage(bytes)).rejects.toThrow(/PlanarConfiguration/);
  });

  it("PALETTE COLOR throws, naming the reason", async () => {
    const bytes = buildDicom({
      rows: 1,
      columns: 1,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      photometricInterpretation: "PALETTE COLOR",
      pixelData: bytes8([1]),
    });
    await expect(decodeImage(bytes)).rejects.toThrow(/PALETTE COLOR/);
  });

  it("YBR_FULL throws, naming the reason", async () => {
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
    await expect(decodeImage(bytes)).rejects.toThrow(/YBR_FULL/);
  });

  it("interleaved RGB (SamplesPerPixel 3, PlanarConfiguration 0) passes through unwindowed", async () => {
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
    const { rgba, window } = await decodeImage(bytes);
    expect(Array.from(rgba)).toEqual([10, 20, 30, 255, 200, 150, 100, 255]);
    expect(window).toBeUndefined();
  });

  // A DICOMDIR or a structured report has neither Rows nor PixelData - "no pixel data" must win
  // over "missing required attribute Rows", or the message misleads about what's actually wrong.
  it("a file with no image geometry at all (a DICOMDIR's own shape) says there is no pixel data, not that Rows is missing", async () => {
    const meta = explicitElement(0x0002, 0x0010, "UI", asciiPadded("1.2.840.10008.1.2.1"));
    // One harmless, unrelated element - a DICOMDIR has plenty of its own tags, just none about an
    // image - and dicom-parser needs at least one byte of main-dataset content to parse at all.
    const fileSetId = explicitElement(0x0004, 0x1130, "CS", asciiPadded("SCANLINT"));
    const bytes = concatBytes([PART10_PREAMBLE, DICM_MAGIC, meta, fileSetId]);
    await expect(decodeImage(bytes)).rejects.toThrow("No pixel data (7FE0,0010) in this file");
  });

  it("a frame index out of range throws, naming the reason", async () => {
    const bytes = buildDicom({
      rows: 1,
      columns: 1,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      photometricInterpretation: "MONOCHROME2",
      pixelData: bytes8([0]),
    });
    await expect(decodeImage(bytes, { frame: 1 })).rejects.toThrow(/[Ff]rame/);
  });
});

// Node has no JPEG decoder (section 11 of 3.6's own write-up explains why that correctness claim
// belongs to a manual browser check, not this suite): this stub only proves decodeImage reaches and
// completes the JPEG path with the right shape - a bitmap of the declared dimensions, no window, the
// JPEG transfer syntax UID echoed back - not that the pixel values it would produce are correct.
function stubJpegDecoder(width: number, height: number) {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width, height, close: vi.fn() })),
  );
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return { drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4) }) };
      }
    },
  );
}

describe("decodeImage: 3.6 transfer syntax dispatch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("each of the four supported transfer syntaxes reaches its own path", async () => {
    const explicit = await decodeImage(readFixture("pattern-explicit.dcm")); // native
    expect(explicit.transferSyntaxUid).toBe("1.2.840.10008.1.2.1");

    const rle = await decodeImage(readFixture("pattern-rle.dcm")); // rle
    expect(rle.transferSyntaxUid).toBe("1.2.840.10008.1.2.5");

    stubJpegDecoder(64, 64);
    const jpeg = await decodeImage(readFixture("pattern-jpeg.dcm")); // jpeg
    expect(jpeg.transferSyntaxUid).toBe("1.2.840.10008.1.2.4.50");
    expect(jpeg.width).toBe(64);
    expect(jpeg.height).toBe(64);
    expect(jpeg.window).toBeUndefined();
  });

  // "Deflated Explicit VR Little Endian" is excluded from the table below on purpose - see the
  // dedicated test after it for why it can never reach decodeImage's own refusal at all.
  const REFUSAL_FAMILIES: Array<[string, string]> = [
    ["JPEG 2000", "1.2.840.10008.1.2.4.90"],
    ["JPEG-LS", "1.2.840.10008.1.2.4.80"],
    ["JPEG Lossless", "1.2.840.10008.1.2.4.70"],
    ["HTJ2K", "1.2.840.10008.1.2.4.201"],
    ["MPEG-4", "1.2.840.10008.1.2.4.102"],
    ["Encapsulated Uncompressed", "1.2.840.10008.1.2.1.98"],
  ];

  it.each(REFUSAL_FAMILIES)("%s (%s) is refused, naming the standard's own name and the UID", async (_family, uid) => {
    const name = (transferSyntaxRegistry.transferSyntaxes as Record<string, { name: string }>)[uid]?.name;
    expect(name, `transfer-syntaxes.json has no entry for ${uid}`).toBeTruthy();

    const bytes = buildDicom({
      rows: 1,
      columns: 1,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      photometricInterpretation: "MONOCHROME2",
      transferSyntaxUid: uid,
      pixelData: bytes8([0]),
    });

    await expect(decodeImage(bytes)).rejects.toThrow(uid);
    await expect(decodeImage(bytes)).rejects.toThrow(name!);
  });

  // dicom-parser inspects this one UID itself, before decodeImage ever runs: it attempts to
  // zlib-inflate the dataset bytes as soon as it reads the transfer syntax from file meta (see
  // getDataSetByteStream in its own source). In Node that is real zlib; in a browser, with no
  // `options.inflater` supplied and no pako dependency in this project, it is nothing at all - the
  // library throws its own "no inflater available" error. Either way, decodeImage's transfer-syntax
  // dispatch never runs for this UID: parseDicom() itself throws first. A constructed (deliberately
  // non-deflated) file under this UID demonstrates the same thing in this Node test environment -
  // the thrown message is dicom-parser's own decompression failure, not decodeImage's named refusal.
  it("Deflated Explicit VR Little Endian never reaches decodeImage's own refusal - dicom-parser's own (un)deflate handling runs first", async () => {
    const uid = "1.2.840.10008.1.2.1.99";
    const bytes = buildDicom({
      rows: 1,
      columns: 1,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      photometricInterpretation: "MONOCHROME2",
      transferSyntaxUid: uid,
      pixelData: bytes8([0]), // deliberately not deflate-compressed
    });

    let caught: unknown;
    try {
      await decodeImage(bytes);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain(uid); // never reached decodeImage's own named refusal
  });

  it("a UID absent from the registry entirely is refused, naming the UID", async () => {
    const uid = "1.2.9999.1.2.3";
    const bytes = buildDicom({
      rows: 1,
      columns: 1,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      photometricInterpretation: "MONOCHROME2",
      transferSyntaxUid: uid,
      pixelData: bytes8([0]),
    });
    await expect(decodeImage(bytes)).rejects.toThrow(uid);
  });

  it("a native transfer syntax with an undefined-length pixel data element is refused, naming both facts", async () => {
    const value = encapsulatedValue([Uint8Array.of(0x00, 0x00)], [0]);
    const bytes = buildDicom({
      rows: 1,
      columns: 1,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      photometricInterpretation: "MONOCHROME2",
      transferSyntaxUid: "1.2.840.10008.1.2.1", // native
      pixelDataRaw: encapsulatedPixelDataElement(value),
    });
    await expect(decodeImage(bytes)).rejects.toThrow(/native/);
    await expect(decodeImage(bytes)).rejects.toThrow(/undefined length/);
  });

  it("an encapsulated transfer syntax with a defined-length pixel data element is refused, naming both facts", async () => {
    const bytes = buildDicom({
      rows: 1,
      columns: 1,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      photometricInterpretation: "MONOCHROME2",
      transferSyntaxUid: "1.2.840.10008.1.2.5", // RLE Lossless: encapsulated
      pixelData: bytes8([0]), // a defined-length element, not encapsulated
    });
    await expect(decodeImage(bytes)).rejects.toThrow(/encapsulated/);
    await expect(decodeImage(bytes)).rejects.toThrow(/defined length/);
  });

  // 3.6a: two pairwise orderings do not pin a six-step chain. One file that trips several checks at
  // once does: Big Endian (step 1), no PixelData element at all (step 2), a nonsense BitsAllocated
  // and PlanarConfiguration 1 (both step 6) - if the chain's order is right, only step 1 ever fires.
  it("a file broken in several ways at once reports only the unsupported transfer syntax, nothing else", async () => {
    const meta = explicitElement(0x0002, 0x0010, "UI", asciiPadded("1.2.840.10008.1.2.2")); // Big Endian
    // Big-endian-encoded elements, built by hand since explicitElement always writes little-endian:
    // BitsAllocated 7 (neither 8 nor 16) and PlanarConfiguration 1 - no Rows, Columns or PixelData
    // element anywhere in this file.
    const bitsAllocatedBigEndian = concatBytes([Uint8Array.of(0x00, 0x28, 0x01, 0x00), new TextEncoder().encode("US"), Uint8Array.of(0x00, 0x02), Uint8Array.of(0x00, 0x07)]);
    const planarConfigurationBigEndian = concatBytes([Uint8Array.of(0x00, 0x28, 0x00, 0x06), new TextEncoder().encode("US"), Uint8Array.of(0x00, 0x02), Uint8Array.of(0x00, 0x01)]);
    const bytes = concatBytes([PART10_PREAMBLE, DICM_MAGIC, meta, bitsAllocatedBigEndian, planarConfigurationBigEndian]);

    let caught: unknown;
    try {
      await decodeImage(bytes);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsupportedSyntaxError);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("1.2.840.10008.1.2.2");
    expect(message).not.toMatch(/pixel data/i);
    expect(message).not.toMatch(/BitsAllocated/);
    expect(message).not.toMatch(/PlanarConfiguration/);
  });
});

// 3.8: multiframe-burned-in.dcm is native, so every check here runs for real in Node - unlike
// multiframe-jpeg.dcm, whose per-frame pixel *values* need a real browser's JPEG decoder (section 11
// of 3.8's own report) and are not re-asserted here; what Node can and does check for it is
// dispatch - that three distinct frames resolve, with the right frame/numberOfFrames echoed back.
describe("decodeImage: 3.8 multi-frame fixtures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("multiframe-burned-in.dcm: every frame decodes under the one declared window, matching the manifest exactly", async () => {
    const entry = manifestEntry("multiframe-burned-in.dcm");
    const bytes = readFixture("multiframe-burned-in.dcm");
    expect(entry.numberOfFrames).toBe(3);

    for (let frame = 0; frame < entry.numberOfFrames; frame++) {
      const { width, rgba, window, numberOfFrames } = await decodeImage(bytes, { frame });
      expect(window).toEqual({ center: entry.windowCenter, width: entry.windowWidth });
      expect(numberOfFrames).toBe(3);
      for (const point of entry.expectedOutputByFrame[frame]) {
        const i = (point.y * width + point.x) * 4;
        expect([rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]], `frame ${frame} (${point.x},${point.y})`).toEqual([point.grey, point.grey, point.grey, 255]);
      }
    }
  });

  it("multiframe-burned-in.dcm: frame 3's text differs from its surroundings by at least 64 of 255; frames 1 and 2 have no pixel at the maximum", async () => {
    const entry = manifestEntry("multiframe-burned-in.dcm");
    const bytes = readFixture("multiframe-burned-in.dcm");
    const box = entry.burnedInAnnotation.boundingBox;

    const meanInsideOutside = (rgba: Uint8ClampedArray, width: number, height: number) => {
      let insideSum = 0;
      let insideCount = 0;
      let outsideSum = 0;
      let outsideCount = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const grey = rgba[(y * width + x) * 4];
          if (y >= box.rowStart && y < box.rowEnd && x >= box.colStart && x < box.colEnd) {
            insideSum += grey;
            insideCount++;
          } else {
            outsideSum += grey;
            outsideCount++;
          }
        }
      }
      return Math.abs(insideSum / insideCount - outsideSum / outsideCount);
    };

    const frame3 = await decodeImage(bytes, { frame: entry.burnedInAnnotation.textFrame - 1 });
    expect(meanInsideOutside(frame3.rgba, frame3.width, frame3.height)).toBeGreaterThanOrEqual(64);

    for (const frame of [0, 1]) {
      const { rgba } = await decodeImage(bytes, { frame });
      expect(Array.from(rgba).some((v, i) => i % 4 === 0 && v === 255)).toBe(false);
    }
  });

  it("multiframe-jpeg.dcm: three distinct frames dispatch correctly, echoing frame/numberOfFrames back (pixel values need a browser - see the report)", async () => {
    const entry = manifestEntry("multiframe-jpeg.dcm");
    const bytes = readFixture("multiframe-jpeg.dcm");
    expect(entry.numberOfFrames).toBe(3);
    stubJpegDecoder(64, 64);

    for (let frame = 0; frame < 3; frame++) {
      const image = await decodeImage(bytes, { frame });
      expect(image.frame).toBe(frame);
      expect(image.numberOfFrames).toBe(3);
      expect(image.window).toBeUndefined();
    }
  });

  it("a frame index out of range still fails as a plain failure, with no reason, for a multi-frame file", async () => {
    const bytes = readFixture("multiframe-burned-in.dcm");
    let caught: unknown;
    try {
      await decodeImage(bytes, { frame: 3 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UnsupportedFormatError);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toMatch(/frame/i);
  });
});
