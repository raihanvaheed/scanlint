import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { flattenNodes } from "../model/tree";
import type { Finding, TagNode } from "../model/types";
import { handleParse } from "./handle";

// The series fixtures are the oracle for Stage 2. Nothing in the app reads them yet, so this reads them
// the way the app will: through handleParse, not through the generator's own checks.

const ROOT = path.resolve(__dirname, "../..");
const DIR = path.join(ROOT, "fixtures", "series");

type FileEntry = {
  file: string;
  sha256: string;
  plannedSeries: string;
  plannedSlice: number;
  seriesInstanceUid: string;
  instanceNumber: string;
  imagePositionPatient: number[];
  pixelSpacing: number[];
  modality: string;
  fault?: { id: string };
};
type SeriesEntry = { label: string; seriesInstanceUid: string; files: string[]; spatialOrder: { file: string; distanceAlongNormalMm: number }[] };
type Manifest = {
  studyInstanceUid: string;
  series: SeriesEntry[];
  files: FileEntry[];
  seriesFindings: { kind: string; files?: string[]; tag?: string }[];
  findingsUnion: { tags: string[] };
  skipped: { file: string; dicom: boolean }[];
};
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "series.manifest.json"), "utf8")) as Manifest;

const bytesOf = (name: string) => new Uint8Array(fs.readFileSync(path.join(DIR, name)));

function parse(name: string) {
  const outcome = handleParse(bytesOf(name));
  if (!outcome.ok) throw new Error(`${name}: ${outcome.message}`);
  const flat = flattenNodes(outcome.nodes);
  const byPath = new Map<string, TagNode>(flat.map((n) => [n.path, n]));
  return { ...outcome, flat, byPath, value: (p: string) => byPath.get(p)?.value };
}

const names = manifest.files.map((f) => f.file);
const parsed = new Map(names.map((n) => [n, parse(n)]));
const num = (s: string | undefined) => (s ?? "").split("\\").map(Number);

describe("the series folder", () => {
  it("holds 15 slices without extensions, and the four other files", () => {
    expect(fs.readdirSync(DIR).sort()).toEqual([".DS_Store", "DICOMDIR", "README.txt", "thumbnail.jpg", ...names].sort());
    expect(names).toHaveLength(15);
    expect(names.filter((n) => n.includes("."))).toEqual([]);
  });

  it("matches the manifest's hashes, so a stale fixture fails here", () => {
    for (const f of manifest.files) {
      expect(createHash("sha256").update(bytesOf(f.file)).digest("hex"), f.file).toBe(f.sha256);
    }
  });

  it("is 64 by 64, and every slice parses with the Stage 1 code", () => {
    for (const [name, p] of parsed) {
      expect(p.value("00280010"), name).toBe("64");
      expect(p.value("00280011"), name).toBe("64");
      expect(p.byPath.get("7fe00010")?.length, name).toBe(64 * 64 * 2);
    }
  });
});

describe("grouping", () => {
  const groups = new Map<string, string[]>();
  for (const [name, p] of parsed) groups.set(p.value("0020000e") as string, [...(groups.get(p.value("0020000e") as string) ?? []), name]);

  it("puts 10 files in series A and 5 in series B, one study", () => {
    for (const [, p] of parsed) expect(p.value("0020000d")).toBe(manifest.studyInstanceUid);
    expect(groups.size).toBe(2);
    for (const s of manifest.series) expect(groups.get(s.seriesInstanceUid)?.sort(), s.label).toEqual([...s.files].sort());
    expect(manifest.series.map((s) => s.files.length)).toEqual([10, 5]);
  });

  it("is not what the filenames suggest: the first file alphabetically is in series B", () => {
    const b = manifest.series.find((s) => s.label === "B")!;
    expect(b.files).toContain("IM_0001");
    expect(manifest.files.find((f) => f.file === "IM_0001")?.plannedSeries).toBe("A");
  });
});

describe("spatial order", () => {
  // The slice normal is the cross product of the row and column direction cosines.
  function distance(name: string): number {
    const p = parsed.get(name)!;
    const [r0, r1, r2, c0, c1, c2] = num(p.value("00200037"));
    const n = [r1 * c2 - r2 * c1, r2 * c0 - r0 * c2, r0 * c1 - r1 * c0];
    return num(p.value("00200032")).reduce((sum, v, i) => sum + v * n[i], 0);
  }

  it.each(manifest.series.map((s) => [s.label, s] as const))("orders series %s by projection onto the normal, as the manifest says", (_label, s) => {
    const computed = [...s.files].sort((a, b) => distance(a) - distance(b));
    expect(computed).toEqual(s.spatialOrder.map((o) => o.file));
    expect(s.spatialOrder.map((o) => o.distanceAlongNormalMm)).toEqual(computed.map(distance));
  });

  it.each(manifest.series.map((s) => [s.label, s] as const))("does not match alphabetical order in series %s", (_label, s) => {
    expect([...s.files].sort()).not.toEqual(s.spatialOrder.map((o) => o.file));
  });

  it("is not InstanceNumber order in series A, because A-11 says 2", () => {
    const a = manifest.series.find((s) => s.label === "A")!;
    const byInstance = [...a.files].sort((x, y) => Number(parsed.get(x)!.value("00200013")) - Number(parsed.get(y)!.value("00200013")));
    expect(byInstance).not.toEqual(a.spatialOrder.map((o) => o.file));
    const wrong = manifest.files.find((f) => f.fault?.id === "A-11")!;
    expect(parsed.get(wrong.file)!.value("00200013")).toBe("2");
    expect(a.files.filter((f) => parsed.get(f)!.value("00200013") === "2")).toHaveLength(2);
  });

  it("has a 6.0 mm gap in series A between z = 15 and z = 21, from the missing slice 7", () => {
    const a = manifest.series.find((s) => s.label === "A")!;
    const zs = a.spatialOrder.map((o) => o.distanceAlongNormalMm);
    expect(zs.slice(0, 8)).toEqual([0, 3, 6, 9, 12, 15, 21, 27]);
    expect(manifest.files.filter((f) => f.plannedSeries === "A" && f.plannedSlice === 7)).toEqual([]);
    const gap = manifest.seriesFindings.find((f) => f.kind === "position-gap")!;
    expect(gap.files?.map((f) => distance(f))).toEqual([15, 21]);
  });
});

describe("the planted faults", () => {
  const fileOf = (id: string) => manifest.files.find((f) => f.fault?.id === id)!.file;

  it("gives A-3, and only A-3, a top-level ReferringPhysicianName, and no other file has the tag at any depth", () => {
    for (const [name, p] of parsed) {
      const anywhere = p.flat.filter((n) => n.tag === "00080090");
      expect(anywhere.length, name).toBe(name === fileOf("A-3") ? 2 : 0);
    }
    expect(parsed.get(fileOf("A-3"))!.byPath.get("00080090")).toBeDefined();
  });

  it("gives A-5, and only A-5, a different PatientID", () => {
    const different = [...parsed].filter(([, p]) => p.value("00100020") !== "SCANLINT-TEST-0001").map(([n]) => n);
    expect(different).toEqual([fileOf("A-5")]);
  });

  it("gives A-8, and only A-8, PixelSpacing 0.6", () => {
    const off = [...parsed].filter(([, p]) => p.value("00280030") === "0.6\\0.6").map(([n]) => n);
    expect(off).toEqual([fileOf("A-8")]);
    for (const f of manifest.files.filter((f) => f.plannedSeries === "A" && f.fault?.id !== "A-8")) expect(parsed.get(f.file)!.value("00280030")).toBe("0.5\\0.5");
  });

  it("gives A-9 series B's SeriesInstanceUID and A's modality", () => {
    const b = manifest.series.find((s) => s.label === "B")!;
    const p = parsed.get(fileOf("A-9"))!;
    expect(p.value("0020000e")).toBe(b.seriesInstanceUid);
    expect(p.value("00080060")).toBe("MR");
  });

  it("lists exactly the five kinds of series-level finding", () => {
    expect(manifest.seriesFindings.map((f) => f.kind).sort()).toEqual(
      ["extra-field", "inconsistent-pixel-spacing", "mixed-modality", "position-gap", "varying-value"],
    );
  });
});

describe("what ScanLint finds across the folder", () => {
  it("finds the manifest's union of identifying tags, by the rules engine and not by the generator", () => {
    const union = new Set<string>();
    for (const [, p] of parsed) for (const f of p.findings as Finding[]) if (f.kind !== "burned-in") union.add(f.tag);
    expect([...union].sort()).toEqual(manifest.findingsUnion.tags);
    expect(manifest.findingsUnion.tags).toHaveLength(28);
  });

  it("finds one more identifying field in A-3 than in a plain slice, and the same 27 otherwise", () => {
    const count = (name: string) => parsed.get(name)!.findings.filter((f) => f.kind !== "burned-in").length;
    const a3 = manifest.files.find((f) => f.fault?.id === "A-3")!.file;
    const plain = manifest.files.find((f) => f.plannedSeries === "A" && f.plannedSlice === 1)!.file;
    expect(count(a3) - count(plain)).toBe(2); // the top-level tag and the one nested in the sequence
    expect(count(plain)).toBe(27);
  });
});

describe("the four files that are not slices", () => {
  it.each([".DS_Store", "thumbnail.jpg", "README.txt"])("%s is not DICOM: the parser rejects it with a message, not a crash", (name) => {
    const outcome = handleParse(bytesOf(name));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message.length).toBeGreaterThan(0);
  });

  it("DICOMDIR is DICOM, and the parser accepts it: skipping it has to be by SOP Class, because it does not fail", () => {
    const p = parse("DICOMDIR");
    expect(p.value("00020002")).toBe("1.2.840.10008.1.3.10");
    expect(p.byPath.get("7fe00010")).toBeUndefined();
    expect(p.value("00280010")).toBeUndefined();
  });

  it("are all listed in the manifest as skipped", () => {
    expect(manifest.skipped.map((s) => s.file).sort()).toEqual([".DS_Store", "DICOMDIR", "README.txt", "thumbnail.jpg"]);
    expect(manifest.skipped.find((s) => s.file === "DICOMDIR")?.dicom).toBe(true);
  });
});
