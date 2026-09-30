import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { handleDecode } from "./handle";
import { decodeImage } from "./decode";
import { bytes8, buildDicom, explicitElement, asciiPadded, concatBytes, PART10_PREAMBLE, DICM_MAGIC } from "./build-dicom";

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES_DIR = path.join(ROOT, "fixtures", "pixels");

function readFixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES_DIR, name)));
}

const PATTERN_FILES = ["pattern-explicit.dcm", "pattern-implicit.dcm", "pattern-rle.dcm", "pattern-mono1.dcm", "pattern-signed.dcm"];

describe("handleDecode on the pattern fixtures", () => {
  it.each(PATTERN_FILES)("%s: an ok outcome with the right dimensions and RGBA matching decodeImage directly", (name) => {
    const bytes = readFixture(name);
    const outcome = handleDecode(bytes);
    const direct = decodeImage(bytes);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.width).toBe(direct.width);
    expect(outcome.height).toBe(direct.height);
    expect(new Uint8ClampedArray(outcome.rgba)).toEqual(direct.rgba);
  });
});

describe("handleDecode on rejection cases from 3.2", () => {
  it("never throws, and every case resolves not-ok with a non-empty message", () => {
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
      const outcome = handleDecode(bytes);
      expect(outcome.ok, label).toBe(false);
      if (outcome.ok) continue;
      expect(typeof outcome.message, label).toBe("string");
      expect(outcome.message.length, label).toBeGreaterThan(0);
    }
  });

  it("a frame index out of range returns not-ok, not a throw", () => {
    const bytes = buildDicom({ rows: 1, columns: 1, bitsAllocated: 8, bitsStored: 8, highBit: 7, photometricInterpretation: "MONOCHROME2", pixelData: bytes8([0]) });
    const outcome = handleDecode(bytes, { frame: 1 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toMatch(/[Ff]rame/);
  });

  it("a file with no pixel data at all returns not-ok, naming that", () => {
    const bytes = buildDicom({ rows: 1, columns: 1, bitsAllocated: 8, bitsStored: 8, highBit: 7, photometricInterpretation: "MONOCHROME2" });
    const outcome = handleDecode(bytes);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toMatch(/pixel data/i);
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
    expect(mocked.handleDecode(new Uint8Array(0))).toEqual({ ok: false, message: "a plain string failure" });
  });
});
