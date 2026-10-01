import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseDicom } from "dicom-parser";
import { extractEncapsulatedFragment } from "./pixel-data";
import { buildDicom, encapsulatedPixelDataElement, encapsulatedValue, fragmentOffsets } from "./build-dicom";

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES_DIR = path.join(ROOT, "fixtures", "pixels");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "pixels.manifest.json"), "utf8"));

function manifestEntry(name: string) {
  const entry = manifest.files.find((f: { file: string }) => f.file === name);
  if (!entry) throw new Error(`No manifest entry for ${name}`);
  return entry;
}

function readFixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES_DIR, name)));
}

const JPEG_FILES = ["pattern-jpeg.dcm", "pattern-jpeg-mono1.dcm", "pattern-jpeg-rgb.dcm", "burned-in-jpeg.dcm"];

// Section 7's rule 1: NumberOfFrames 1 or absent, every fragment concatenated regardless of what the
// offset table says. All four JPEG fixtures are single-frame, single-fragment, so this is also the
// path they themselves exercise - the assertion that catches a silent trim of the trailing pad byte
// 3.5a found (PS3.5 Annex A.4).
describe("extractEncapsulatedFragment against the 3.5/3.5a JPEG fixtures", () => {
  it.each(JPEG_FILES)("%s: the extracted fragment's length equals the manifest's jpegFragmentEncapsulatedLength", (name) => {
    const entry = manifestEntry(name);
    const dataSet = parseDicom(readFixture(name));
    const pixelDataElement = dataSet.elements.x7fe00010;
    const fragment = extractEncapsulatedFragment(dataSet, pixelDataElement, 0, 1);
    expect(fragment.length).toBe(entry.jpegFragmentEncapsulatedLength);
  });
});

describe("extractEncapsulatedFragment: section 7's four frame-boundary rules, constructed", () => {
  function parseWithFragments(fragments: Uint8Array[], offsets: number[], numberOfFrames?: number) {
    const value = encapsulatedValue(fragments, offsets);
    const pixelDataRaw = encapsulatedPixelDataElement(value);
    const bytes = buildDicom({
      rows: 1,
      columns: 1,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      photometricInterpretation: "MONOCHROME2",
      transferSyntaxUid: "1.2.840.10008.1.2.5",
      numberOfFrames,
      pixelDataRaw,
    });
    const dataSet = parseDicom(bytes);
    return dataSet.elements.x7fe00010 ? { dataSet, pixelDataElement: dataSet.elements.x7fe00010 } : (() => { throw new Error("no pixel data element parsed"); })();
  }

  it("rule 1: NumberOfFrames absent, two fragments, concatenated regardless of what a (wrong) offset table says", () => {
    const fragments = [Uint8Array.of(0x01, 0x02), Uint8Array.of(0x03, 0x04, 0x05, 0x06)];
    // A deliberately wrong single-entry BOT (as if only fragment 0 belonged to the frame) - rule 1
    // says NumberOfFrames of 1 (here, absent) wins over this regardless.
    const { dataSet, pixelDataElement } = parseWithFragments(fragments, [0]);
    const result = extractEncapsulatedFragment(dataSet, pixelDataElement, 0, 1);
    expect(Array.from(result)).toEqual([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
  });

  it("rule 2: a non-empty Basic Offset Table resolves two frames, each spanning two fragments", () => {
    const frame0 = [Uint8Array.of(0x01, 0x02), Uint8Array.of(0x03, 0x04)];
    const frame1 = [Uint8Array.of(0x05, 0x06), Uint8Array.of(0x07, 0x08)];
    const fragments = [...frame0, ...frame1];
    const allOffsets = fragmentOffsets(fragments);
    const bot = [allOffsets[0], allOffsets[2]]; // frame 0 starts at fragment 0, frame 1 at fragment 2
    const { dataSet, pixelDataElement } = parseWithFragments(fragments, bot, 2);

    expect(Array.from(extractEncapsulatedFragment(dataSet, pixelDataElement, 0, 2))).toEqual([0x01, 0x02, 0x03, 0x04]);
    expect(Array.from(extractEncapsulatedFragment(dataSet, pixelDataElement, 1, 2))).toEqual([0x05, 0x06, 0x07, 0x08]);
  });

  it("rule 3: an empty Basic Offset Table with fragment count equal to NumberOfFrames - one fragment per frame", () => {
    const fragments = [Uint8Array.of(0xaa), Uint8Array.of(0xbb), Uint8Array.of(0xcc)];
    const { dataSet, pixelDataElement } = parseWithFragments(fragments, [], 3);

    expect(Array.from(extractEncapsulatedFragment(dataSet, pixelDataElement, 0, 3))).toEqual([0xaa]);
    expect(Array.from(extractEncapsulatedFragment(dataSet, pixelDataElement, 1, 3))).toEqual([0xbb]);
    expect(Array.from(extractEncapsulatedFragment(dataSet, pixelDataElement, 2, 3))).toEqual([0xcc]);
  });

  it("rule 4: anything else (empty table, fragment count not equal to NumberOfFrames) is refused, naming both counts", () => {
    const fragments = [Uint8Array.of(0xaa), Uint8Array.of(0xbb)];
    const { dataSet, pixelDataElement } = parseWithFragments(fragments, [], 3);

    expect(() => extractEncapsulatedFragment(dataSet, pixelDataElement, 0, 3)).toThrow(/3 frame.*2 fragment|2 fragment.*3 frame/);
  });

  it("rule 4 also catches a non-empty Basic Offset Table that cannot resolve the requested frame", () => {
    const fragments = [Uint8Array.of(0x01), Uint8Array.of(0x02)];
    const { dataSet, pixelDataElement } = parseWithFragments(fragments, [0, 999], 2); // 999 matches no fragment's real offset
    expect(() => extractEncapsulatedFragment(dataSet, pixelDataElement, 1, 2)).toThrow(/Basic Offset Table/);
  });
});
