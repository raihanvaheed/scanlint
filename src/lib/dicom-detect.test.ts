import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { hasDicomMagic, isDicomDir } from "./dicom-detect";

const ROOT = path.resolve(__dirname, "../..");
const DIR = path.join(ROOT, "fixtures", "series");
const header = (name: string) => {
  const buf = fs.readFileSync(path.join(DIR, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + Math.min(132, buf.byteLength));
};

describe("hasDicomMagic", () => {
  it("is true for a real slice, at exactly offset 128", () => {
    expect(hasDicomMagic(header("IM_0001"))).toBe(true);
    expect(hasDicomMagic(header("DICOMDIR"))).toBe(true);
  });

  it("is false for the fixture's non-DICOM files", () => {
    expect(hasDicomMagic(header(".DS_Store"))).toBe(false);
    expect(hasDicomMagic(header("README.txt"))).toBe(false);
    expect(hasDicomMagic(header("thumbnail.jpg"))).toBe(false);
  });

  it("is false, not a crash, when the header is shorter than 132 bytes", () => {
    expect(hasDicomMagic(new ArrayBuffer(0))).toBe(false);
    expect(hasDicomMagic(new ArrayBuffer(131))).toBe(false);
    expect(hasDicomMagic(new ArrayBuffer(128))).toBe(false);
  });

  it("checks the DICM bytes exactly, not a loose match", () => {
    const buf = new ArrayBuffer(132);
    new Uint8Array(buf).set([..."dicm"].map((c) => c.charCodeAt(0)), 128);
    expect(hasDicomMagic(buf)).toBe(false); // wrong case
  });

  it("is true given exactly 132 bytes ending in DICM, and ignores anything after that offset", () => {
    const buf = new ArrayBuffer(200);
    new Uint8Array(buf).set([...".DICM"].map((c) => c.charCodeAt(0)), 127);
    expect(hasDicomMagic(buf)).toBe(true);
  });
});

describe("isDicomDir", () => {
  it("is true for the DICOMDIR fixture's own nodes", () => {
    expect(isDicomDir([{ tag: "00020002", value: "1.2.840.10008.1.3.10" }])).toBe(true);
  });

  it("is false for an ordinary slice's SOP Class, and when the tag is absent", () => {
    expect(isDicomDir([{ tag: "00020002", value: "1.2.840.10008.5.1.4.1.1.4" }])).toBe(false);
    expect(isDicomDir([{ tag: "00080016", value: "1.2.840.10008.1.3.10" }])).toBe(false);
    expect(isDicomDir([])).toBe(false);
  });

  it("looks at every node given, not only the first", () => {
    expect(isDicomDir([{ tag: "00080016", value: "x" }, { tag: "00020002", value: "1.2.840.10008.1.3.10" }])).toBe(true);
  });
});
