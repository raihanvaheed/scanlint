import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { handleDecode } from "./handle";
import { decodeImage } from "./decode";
import { bytes8, buildDicom, explicitElement, asciiPadded, concatBytes, encapsulatedPixelDataElement, encapsulatedValue, PART10_PREAMBLE, DICM_MAGIC } from "./build-dicom";

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES_DIR = path.join(ROOT, "fixtures", "pixels");

function readFixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES_DIR, name)));
}

const PATTERN_FILES = ["pattern-explicit.dcm", "pattern-implicit.dcm", "pattern-rle.dcm", "pattern-mono1.dcm", "pattern-signed.dcm"];

describe("handleDecode on the pattern fixtures", () => {
  it.each(PATTERN_FILES)("%s: an ok outcome with the right dimensions and RGBA matching decodeImage directly", async (name) => {
    const bytes = readFixture(name);
    const outcome = await handleDecode(bytes);
    const direct = await decodeImage(bytes);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.width).toBe(direct.width);
    expect(outcome.height).toBe(direct.height);
    expect(new Uint8ClampedArray(outcome.rgba)).toEqual(direct.rgba);
  });
});

describe("handleDecode on rejection cases from 3.2", () => {
  it("never throws, and every case resolves not-ok with a non-empty message", async () => {
    const cases: Array<[string, Uint8Array]> = [
      [
        "Explicit VR Big Endian",
        concatBytes([PART10_PREAMBLE, DICM_MAGIC, explicitElement(0x0002, 0x0010, "UI", asciiPadded("1.2.840.10008.1.2.2"))]),
      ],
      [
        "PALETTE COLOR",
        buildDicom({ rows: 1, columns: 1, bitsAllocated: 8, bitsStored: 8, highBit: 7, photometricInterpretation: "PALETTE COLOR", pixelData: bytes8([1]) }),
      ],
      [
        "YBR_FULL",
        buildDicom({
          rows: 1,
          columns: 1,
          bitsAllocated: 8,
          bitsStored: 8,
          highBit: 7,
          samplesPerPixel: 3,
          photometricInterpretation: "YBR_FULL",
          planarConfiguration: 0,
          pixelData: bytes8([1, 2, 3]),
        }),
      ],
      [
        "PlanarConfiguration 1",
        buildDicom({
          rows: 1,
          columns: 1,
          bitsAllocated: 8,
          bitsStored: 8,
          highBit: 7,
          samplesPerPixel: 3,
          photometricInterpretation: "RGB",
          planarConfiguration: 1,
          pixelData: bytes8([1, 2, 3]),
        }),
      ],
      ["not DICOM at all", new Uint8Array(1000)],
      ["an empty buffer", new Uint8Array(0)],
    ];

    for (const [label, bytes] of cases) {
      const outcome = await handleDecode(bytes);
      expect(outcome.ok, label).toBe(false);
      if (outcome.ok) continue;
      expect(typeof outcome.message, label).toBe("string");
      expect(outcome.message.length, label).toBeGreaterThan(0);
    }
  });

  it("a frame index out of range returns not-ok, not a throw", async () => {
    const bytes = buildDicom({ rows: 1, columns: 1, bitsAllocated: 8, bitsStored: 8, highBit: 7, photometricInterpretation: "MONOCHROME2", pixelData: bytes8([0]) });
    const outcome = await handleDecode(bytes, { frame: 1 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toMatch(/[Ff]rame/);
  });

  it("a file with no pixel data at all returns not-ok, naming that", async () => {
    const bytes = buildDicom({ rows: 1, columns: 1, bitsAllocated: 8, bitsStored: 8, highBit: 7, photometricInterpretation: "MONOCHROME2" });
    const outcome = await handleDecode(bytes);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toMatch(/pixel data/i);
  });
});

const JPEG_FILES = ["pattern-jpeg.dcm", "pattern-jpeg-mono1.dcm", "pattern-jpeg-rgb.dcm"];

describe("handleDecode on the JPEG fixtures, in Node (no browser JPEG primitives)", () => {
  it.each(JPEG_FILES)("%s: resolves not-ok, naming the missing primitive, never throwing or rejecting", async (name) => {
    const bytes = readFixture(name);
    await expect(handleDecode(bytes)).resolves.not.toThrow();
    const outcome = await handleDecode(bytes);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toMatch(/createImageBitmap/);
      expect("reason" in outcome).toBe(false); // a missing browser primitive is a genuine failure, not a stated scope limitation
    }
  });
});

describe("the outcome taxonomy (3.6)", () => {
  const FORBIDDEN_LEADING_WORDS = ["error", "failed", "unsupported", "cannot"];

  function assertWording(message: string) {
    const firstWord = message.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "");
    expect(FORBIDDEN_LEADING_WORDS, message).not.toContain(firstWord);
    expect(message.toLowerCase(), message).not.toContain("yet");
  }

  it("Explicit VR Big Endian produces reason unsupported-syntax, carrying the UID", async () => {
    // The transfer syntax alone is enough to refuse, before decodeImage looks at anything else - but
    // dicom-parser still needs a byte of real (big-endian) dataset content to parse past the meta
    // header at all (see decode.test.ts's identical construction).
    const meta = explicitElement(0x0002, 0x0010, "UI", asciiPadded("1.2.840.10008.1.2.2"));
    const rowsBigEndian = concatBytes([Uint8Array.of(0x00, 0x28, 0x00, 0x10), new TextEncoder().encode("US"), Uint8Array.of(0x00, 0x02), Uint8Array.of(0x00, 0x01)]);
    const bytes = concatBytes([PART10_PREAMBLE, DICM_MAGIC, meta, rowsBigEndian]);
    const outcome = await handleDecode(bytes);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome).toMatchObject({ reason: "unsupported-syntax", transferSyntaxUid: "1.2.840.10008.1.2.2" });
    assertWording(outcome.message);
  });

  it("a transfer syntax absent from the registry produces reason unsupported-syntax, carrying the UID", async () => {
    const bytes = buildDicom({ rows: 1, columns: 1, bitsAllocated: 8, bitsStored: 8, highBit: 7, photometricInterpretation: "MONOCHROME2", transferSyntaxUid: "1.2.9999.1", pixelData: bytes8([0]) });
    const outcome = await handleDecode(bytes);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome).toMatchObject({ reason: "unsupported-syntax", transferSyntaxUid: "1.2.9999.1" });
    assertWording(outcome.message);
  });

  it.each([
    ["PALETTE COLOR", buildDicom({ rows: 1, columns: 1, bitsAllocated: 8, bitsStored: 8, highBit: 7, photometricInterpretation: "PALETTE COLOR", pixelData: bytes8([1]) })],
    [
      "YBR_FULL on uncompressed data",
      buildDicom({ rows: 1, columns: 1, bitsAllocated: 8, bitsStored: 8, highBit: 7, samplesPerPixel: 3, photometricInterpretation: "YBR_FULL", planarConfiguration: 0, pixelData: bytes8([1, 2, 3]) }),
    ],
    [
      "PlanarConfiguration 1",
      buildDicom({
        rows: 1,
        columns: 1,
        bitsAllocated: 8,
        bitsStored: 8,
        highBit: 7,
        samplesPerPixel: 3,
        photometricInterpretation: "RGB",
        planarConfiguration: 1,
        pixelData: bytes8([1, 2, 3]),
      }),
    ],
  ] as Array<[string, Uint8Array]>)("%s produces reason unsupported-format", async (_label, bytes) => {
    const outcome = await handleDecode(bytes);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect("reason" in outcome && outcome.reason).toBe("unsupported-format");
    assertWording(outcome.message);
  });

  it("no PixelData element produces reason no-pixel-data", async () => {
    const bytes = buildDicom({ rows: 1, columns: 1, bitsAllocated: 8, bitsStored: 8, highBit: 7, photometricInterpretation: "MONOCHROME2" });
    const outcome = await handleDecode(bytes);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect("reason" in outcome && outcome.reason).toBe("no-pixel-data");
    assertWording(outcome.message);
  });

  it("a truncated RLE segment produces no reason (a genuine failure)", async () => {
    // A segment claiming 2 literal bytes but supplying only 1: decodeRleFrame's own
    // "ended before producing the expected number of pixels" case, surfaced through the full stack.
    const header = new Uint8Array(64);
    new DataView(header.buffer).setUint32(0, 1, true); // 1 segment
    new DataView(header.buffer).setUint32(4, 64, true); // starts right after the header
    const segment = Uint8Array.of(1, 10); // control 1: claims 2 literal bytes, supplies only 1
    const fragment = concatBytes([header, segment]);
    const value = encapsulatedValue([fragment], [0]);
    const pixelDataRaw = encapsulatedPixelDataElement(value);
    const bytes = buildDicom({ rows: 1, columns: 2, bitsAllocated: 8, bitsStored: 8, highBit: 7, photometricInterpretation: "MONOCHROME2", transferSyntaxUid: "1.2.840.10008.1.2.5", pixelDataRaw });

    const outcome = await handleDecode(bytes);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect("reason" in outcome).toBe(false);
  });

  it("a frame index out of range produces no reason (a genuine failure)", async () => {
    const bytes = buildDicom({ rows: 1, columns: 1, bitsAllocated: 8, bitsStored: 8, highBit: 7, photometricInterpretation: "MONOCHROME2", pixelData: bytes8([0]) });
    const outcome = await handleDecode(bytes, { frame: 1 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect("reason" in outcome).toBe(false);
  });

  // A static audit, not just the handful of cases exercised above by name: every message any throw
  // site in the pixel-decoding path can produce, scanned directly from source. `yet` and the four
  // leading words would otherwise only be caught for whichever case someone happened to test by
  // hand - this catches the one nobody thought to run.
  it("every throw site in the pixel-decoding path produces wording within the rule, scanned from source", () => {
    const files = ["decode.ts", "pixel-data.ts", "jpeg.ts", "rle.ts"].map((name) => fs.readFileSync(path.join(__dirname, name), "utf8"));
    const THROW_PATTERN = /throw new (?:Error|UnsupportedSyntaxError|UnsupportedFormatError)\(\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*")/g;
    let checked = 0;

    for (const content of files) {
      for (const match of content.matchAll(THROW_PATTERN)) {
        const literal = match[1].slice(1, -1); // strip the surrounding ` or "
        const deinterpolated = literal.replace(/\$\{[^}]*\}/g, "X");
        checked++;
        assertWording(deinterpolated);
      }
    }
    expect(checked).toBeGreaterThan(10); // guards against the regex going blind and vacuously passing
  });
});

describe("normalising what decodeImage throws", () => {
  afterEach(() => {
    vi.doUnmock("./decode");
    vi.resetModules();
  });

  it("passes a plain-string throw through as the message, constructed directly", async () => {
    vi.resetModules();
    vi.doMock("./decode", () => ({
      // dicom-parser itself throws plain strings; this reproduces that shape directly rather than
      // relying on it happening to still be true of some particular input.
      decodeImage: () => {
        throw "a plain string failure";
      },
    }));
    const mocked = await import("./handle");
    await expect(mocked.handleDecode(new Uint8Array(0))).resolves.toEqual({ ok: false, message: "a plain string failure" });
  });
});
