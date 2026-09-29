import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { groupAndOrder } from "./series";
import type { Orientation, Vector3 } from "./geometry";
import type { ParsedInstance } from "./series";
import { handleParse } from "../parse/handle";

const ROOT = path.resolve(__dirname, "../..");
const DIR = path.join(ROOT, "fixtures", "series");

type ManifestFile = { file: string; plannedSeries: string; seriesInstanceUid: string };
type ManifestSeries = { label: string; seriesInstanceUid: string; files: string[]; spatialOrder: { file: string; distanceAlongNormalMm: number }[] };
type Manifest = { studyInstanceUid: string; files: ManifestFile[]; series: ManifestSeries[] };
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "series.manifest.json"), "utf8")) as Manifest;

const num = (s: string | undefined) => (s ?? "").split("\\").map(Number);

function parsedInstance(name: string): ParsedInstance {
  const outcome = handleParse(new Uint8Array(fs.readFileSync(path.join(DIR, name))));
  if (!outcome.ok) throw new Error(`${name}: ${outcome.message}`);
  const byTag = new Map(outcome.nodes.map((n) => [n.tag, n]));
  const value = (tag: string) => byTag.get(tag)?.value;
  const orientation = value("00200037");
  const position = value("00200032");
  const instanceNumber = value("00200013");
  return {
    fileName: name,
    studyInstanceUid: value("0020000d"),
    seriesInstanceUid: value("0020000e"),
    sopInstanceUid: value("00080018"),
    instanceNumber: instanceNumber === undefined ? undefined : Number(instanceNumber),
    modality: value("00080060"),
    seriesDescription: value("0008103e"),
    imageOrientationPatient: orientation === undefined ? undefined : (num(orientation) as unknown as Orientation),
    imagePositionPatient: position === undefined ? undefined : (num(position) as unknown as Vector3),
  };
}

const fixtureFiles = manifest.files.map((f) => parsedInstance(f.file));

describe("against the fixture", () => {
  const grouping = groupAndOrder(fixtureFiles);
  const study = grouping.studies.find((s) => s.studyInstanceUid === manifest.studyInstanceUid)!;

  it("has exactly one study, matching the manifest's", () => {
    expect(grouping.studies).toHaveLength(1);
    expect(study).toBeDefined();
  });

  it("puts 10 instances in series A and 5 in series B, matching the manifest", () => {
    const byUid = new Map(study.series.map((s) => [s.seriesInstanceUid, s]));
    const a = manifest.series.find((s) => s.label === "A")!;
    const b = manifest.series.find((s) => s.label === "B")!;
    expect(byUid.get(a.seriesInstanceUid)?.instances).toHaveLength(10);
    expect(byUid.get(b.seriesInstanceUid)?.instances).toHaveLength(5);
  });

  it.each(manifest.series.map((s) => [s.label, s] as const))("series %s orders by position, in the manifest's own recorded order", (_label, expected) => {
    const found = study.series.find((s) => s.seriesInstanceUid === expected.seriesInstanceUid)!;
    expect(found.orderedBy).toBe("position");
    expect(found.orientationConsistent).toBe(true);
    expect(found.instances.map((i) => i.fileName)).toEqual(expected.spatialOrder.map((o) => o.file));
  });

  it("series A's spatial order disagrees with InstanceNumber order, proving the geometric path ran", () => {
    const a = manifest.series.find((s) => s.label === "A")!;
    const found = study.series.find((s) => s.seriesInstanceUid === a.seriesInstanceUid)!;
    const byInstanceNumber = [...fixtureFiles]
      .filter((f) => f.seriesInstanceUid === a.seriesInstanceUid)
      .sort((x, y) => x.instanceNumber! - y.instanceNumber!)
      .map((f) => f.fileName);
    expect(found.instances.map((i) => i.fileName)).not.toEqual(byInstanceNumber);
  });

  it("series A's spatial order disagrees with filename order", () => {
    const a = manifest.series.find((s) => s.label === "A")!;
    const found = study.series.find((s) => s.seriesInstanceUid === a.seriesInstanceUid)!;
    expect(found.instances.map((i) => i.fileName)).not.toEqual([...found.instances.map((i) => i.fileName)].sort());
  });

  it("records each instance's distance matching the manifest's own millimetre values", () => {
    for (const s of manifest.series) {
      const found = study.series.find((se) => se.seriesInstanceUid === s.seriesInstanceUid)!;
      for (const o of s.spatialOrder) {
        const instance = found.instances.find((i) => i.fileName === o.file)!;
        expect(instance.distance).toBeCloseTo(o.distanceAlongNormalMm, 6);
      }
    }
  });
});

describe("ordering: constructed cases", () => {
  const file = (overrides: Partial<ParsedInstance>): ParsedInstance => ({
    fileName: "x",
    studyInstanceUid: "1.1",
    seriesInstanceUid: "1.1.1",
    ...overrides,
  });

  it("orders correctly when position descends as InstanceNumber ascends", () => {
    const files = [
      file({ fileName: "s1", instanceNumber: 1, imageOrientationPatient: [1, 0, 0, 0, 1, 0], imagePositionPatient: [0, 0, 20] }),
      file({ fileName: "s2", instanceNumber: 2, imageOrientationPatient: [1, 0, 0, 0, 1, 0], imagePositionPatient: [0, 0, 10] }),
      file({ fileName: "s3", instanceNumber: 3, imageOrientationPatient: [1, 0, 0, 0, 1, 0], imagePositionPatient: [0, 0, 0] }),
    ];
    const [series] = groupAndOrder(files).studies[0].series;
    expect(series.orderedBy).toBe("position");
    expect(series.instances.map((i) => i.fileName)).toEqual(["s3", "s2", "s1"]);
    expect(series.instances.map((i) => i.distance)).toEqual([0, 10, 20]);
  });

  it("orders a sagittal series correctly", () => {
    // sliceNormal([0,1,0, 0,0,-1]) = (-1,0,0), so distance = -x.
    const files = [
      file({ fileName: "s1", instanceNumber: 2, imageOrientationPatient: [0, 1, 0, 0, 0, -1], imagePositionPatient: [10, 0, 0] }),
      file({ fileName: "s2", instanceNumber: 3, imageOrientationPatient: [0, 1, 0, 0, 0, -1], imagePositionPatient: [0, 0, 0] }),
      file({ fileName: "s3", instanceNumber: 1, imageOrientationPatient: [0, 1, 0, 0, 0, -1], imagePositionPatient: [-10, 0, 0] }),
    ];
    const [series] = groupAndOrder(files).studies[0].series;
    expect(series.orderedBy).toBe("position");
    expect(series.instances.map((i) => i.fileName)).toEqual(["s1", "s2", "s3"]);
    expect(series.instances.map((i) => i.distance)).toEqual([-10, 0, 10]);
  });

  it("orders a coronal series correctly", () => {
    // sliceNormal([1,0,0, 0,0,-1]) = (0,1,0), so distance = y.
    const files = [
      file({ fileName: "s1", instanceNumber: 1, imageOrientationPatient: [1, 0, 0, 0, 0, -1], imagePositionPatient: [0, -5, 0] }),
      file({ fileName: "s2", instanceNumber: 2, imageOrientationPatient: [1, 0, 0, 0, 0, -1], imagePositionPatient: [0, 5, 0] }),
      file({ fileName: "s3", instanceNumber: 3, imageOrientationPatient: [1, 0, 0, 0, 0, -1], imagePositionPatient: [0, 0, 0] }),
    ];
    const [series] = groupAndOrder(files).studies[0].series;
    expect(series.orderedBy).toBe("position");
    expect(series.instances.map((i) => i.fileName)).toEqual(["s1", "s3", "s2"]);
    expect(series.instances.map((i) => i.distance)).toEqual([-5, 0, 5]);
  });

  it("a tilted gantry normal orders correctly where InstanceNumber, filename and a naive z-sort would all agree with each other and all be wrong", () => {
    // orientation [1,0,0, 0,0.8,-0.6]: R=(1,0,0), C=(0,0.8,-0.6), R.C=0, |C|=1.
    // N = R x C = (0*-0.6 - 0*0.8, 0*0 - 1*-0.6, 1*0.8 - 0*0) = (0, 0.6, 0.8), already unit length.
    const orientation: Orientation = [1, 0, 0, 0, 0.8, -0.6];
    // distance = 0.6*y + 0.8*z
    const fileA = file({ fileName: "fileA", instanceNumber: 1, imageOrientationPatient: orientation, imagePositionPatient: [0, 10, 0] }); // z=0,  distance 6
    const fileB = file({ fileName: "fileB", instanceNumber: 2, imageOrientationPatient: orientation, imagePositionPatient: [0, 0, 5] }); // z=5,  distance 4
    const fileC = file({ fileName: "fileC", instanceNumber: 3, imageOrientationPatient: orientation, imagePositionPatient: [0, 0, 10] }); // z=10, distance 8

    // Every wrong method agrees on A, B, C. Only projection gives B, A, C.
    expect([fileA, fileB, fileC].map((f) => f.fileName)).toEqual(["fileA", "fileB", "fileC"]); // filename order
    expect([...[fileA, fileB, fileC]].sort((a, b) => a.instanceNumber! - b.instanceNumber!).map((f) => f.fileName)).toEqual(["fileA", "fileB", "fileC"]); // instance-number order
    expect([...[fileA, fileB, fileC]].sort((a, b) => a.imagePositionPatient![2] - b.imagePositionPatient![2]).map((f) => f.fileName)).toEqual(["fileA", "fileB", "fileC"]); // naive z order

    const [series] = groupAndOrder([fileA, fileB, fileC]).studies[0].series;
    expect(series.orderedBy).toBe("position");
    expect(series.instances.map((i) => i.fileName)).toEqual(["fileB", "fileA", "fileC"]);
    expect(series.instances.map((i) => i.distance)).toEqual([4, 6, 8]);
  });
});

describe("fallbacks", () => {
  const file = (overrides: Partial<ParsedInstance>): ParsedInstance => ({
    fileName: "x",
    studyInstanceUid: "1.1",
    seriesInstanceUid: "1.1.1",
    ...overrides,
  });
  const axial: Orientation = [1, 0, 0, 0, 1, 0];

  it("falls back to instance-number when orientation is missing, and says so", () => {
    const files = [
      file({ fileName: "s2", instanceNumber: 2, imagePositionPatient: [0, 0, 10] }),
      file({ fileName: "s1", instanceNumber: 1, imagePositionPatient: [0, 0, 0] }),
    ];
    const [series] = groupAndOrder(files).studies[0].series;
    expect(series.orderedBy).toBe("instance-number");
    expect(series.orientationConsistent).toBe(true);
    expect(series.instances.map((i) => i.fileName)).toEqual(["s1", "s2"]);
    expect(series.instances.every((i) => i.distance === undefined)).toBe(true);
  });

  it("falls back to instance-number when position is missing but orientation is present", () => {
    const files = [
      file({ fileName: "s2", instanceNumber: 2, imageOrientationPatient: axial }),
      file({ fileName: "s1", instanceNumber: 1, imageOrientationPatient: axial }),
    ];
    const [series] = groupAndOrder(files).studies[0].series;
    expect(series.orderedBy).toBe("instance-number");
  });

  it("falls back to filename when neither orientation nor InstanceNumber is available", () => {
    const files = [file({ fileName: "b" }), file({ fileName: "a" }), file({ fileName: "c" })];
    const [series] = groupAndOrder(files).studies[0].series;
    expect(series.orderedBy).toBe("filename");
    expect(series.orientationConsistent).toBe(true);
    expect(series.instances.map((i) => i.fileName)).toEqual(["a", "b", "c"]);
  });

  it("falls back to filename when only some files have InstanceNumber, not every one", () => {
    const files = [file({ fileName: "b", instanceNumber: 2 }), file({ fileName: "a" })];
    const [series] = groupAndOrder(files).studies[0].series;
    expect(series.orderedBy).toBe("filename");
  });

  it("falls back when orientations disagree beyond tolerance, records orientationConsistent: false, and never reports position", () => {
    const different: Orientation = [1, 0, 0, 0, 0, -1]; // coronal, not axial: a genuinely different plane
    const files = [
      file({ fileName: "s2", instanceNumber: 2, imageOrientationPatient: axial, imagePositionPatient: [0, 0, 10] }),
      file({ fileName: "s1", instanceNumber: 1, imageOrientationPatient: different, imagePositionPatient: [0, 0, 0] }),
    ];
    const [series] = groupAndOrder(files).studies[0].series;
    expect(series.orderedBy).toBe("instance-number");
    expect(series.orderedBy).not.toBe("position");
    expect(series.orientationConsistent).toBe(false);
    expect(series.instances.map((i) => i.fileName)).toEqual(["s1", "s2"]);
  });

  it("orientations differing by only 5e-5 (rounding) still count as consistent and use position", () => {
    const nudged: Orientation = [1 + 5e-5, 0, 0, 0, 1, 0];
    const files = [
      file({ fileName: "s2", instanceNumber: 2, imageOrientationPatient: axial, imagePositionPatient: [0, 0, 10] }),
      file({ fileName: "s1", instanceNumber: 1, imageOrientationPatient: nudged, imagePositionPatient: [0, 0, 0] }),
    ];
    const [series] = groupAndOrder(files).studies[0].series;
    expect(series.orderedBy).toBe("position");
    expect(series.orientationConsistent).toBe(true);
  });

  it("nine slices agreeing and one genuinely different plane is still reported inconsistent - the realistic shape of the fault", () => {
    const different: Orientation = [1, 0, 0, 0, 0, -1]; // coronal, not axial
    const files = [
      ...Array.from({ length: 9 }, (_, n) =>
        file({ fileName: `s${n}`, instanceNumber: n, imageOrientationPatient: axial, imagePositionPatient: [0, 0, n * 10] }),
      ),
      file({ fileName: "odd-one-out", instanceNumber: 9, imageOrientationPatient: different, imagePositionPatient: [0, 0, 90] }),
    ];
    const [series] = groupAndOrder(files).studies[0].series;
    expect(series.orientationConsistent).toBe(false);
    expect(series.orderedBy).toBe("instance-number");
  });
});

describe("grouping", () => {
  const file = (overrides: Partial<ParsedInstance>): ParsedInstance => ({ fileName: "x", ...overrides });

  it("produces two study entries for two studies in one folder", () => {
    const files = [
      file({ fileName: "a", studyInstanceUid: "1.1", seriesInstanceUid: "1.1.1" }),
      file({ fileName: "b", studyInstanceUid: "2.2", seriesInstanceUid: "2.2.1" }),
    ];
    const grouping = groupAndOrder(files);
    expect(grouping.studies).toHaveLength(2);
    expect(grouping.studies.map((s) => s.studyInstanceUid).sort()).toEqual(["1.1", "2.2"]);
  });

  it("puts a file missing SeriesInstanceUID in ungrouped, not dropped, with reason missing-series", () => {
    const files = [
      file({ fileName: "a", studyInstanceUid: "1.1", seriesInstanceUid: "1.1.1" }),
      file({ fileName: "orphan", studyInstanceUid: "1.1" }),
    ];
    const grouping = groupAndOrder(files);
    expect(grouping.ungrouped.map((i) => i.fileName)).toEqual(["orphan"]);
    expect(grouping.ungrouped[0].ungroupedReason).toBe("missing-series");
    expect(grouping.studies).toHaveLength(1);
    expect(grouping.studies[0].series[0].instances).toHaveLength(1);
  });

  it("puts a file missing StudyInstanceUID in ungrouped too, with reason missing-study", () => {
    const files = [file({ fileName: "orphan", seriesInstanceUid: "1.1.1" })];
    const grouping = groupAndOrder(files);
    expect(grouping.ungrouped.map((i) => i.fileName)).toEqual(["orphan"]);
    expect(grouping.ungrouped[0].ungroupedReason).toBe("missing-study");
    expect(grouping.studies).toHaveLength(0);
  });

  it("a file missing both identifiers gets reason missing-both", () => {
    const files = [file({ fileName: "orphan" })];
    const grouping = groupAndOrder(files);
    expect(grouping.ungrouped[0].ungroupedReason).toBe("missing-both");
  });

  it("sorts multiple ungrouped files by filename, regardless of input order", () => {
    const files = [file({ fileName: "zebra" }), file({ fileName: "apple" }), file({ fileName: "mango" })];
    const grouping = groupAndOrder(files);
    expect(grouping.ungrouped.map((i) => i.fileName)).toEqual(["apple", "mango", "zebra"]);
  });

  it("every input file appears exactly once in the output, so nothing given to it is ever dropped", () => {
    const files = fixtureFiles;
    const grouping = groupAndOrder(files);
    const seen = [
      ...grouping.studies.flatMap((s) => s.series.flatMap((se) => se.instances.map((i) => i.fileName))),
      ...grouping.ungrouped.map((i) => i.fileName),
    ];
    expect(seen.sort()).toEqual(files.map((f) => f.fileName).sort());
    expect(new Set(seen).size).toBe(files.length);
  });

  it("is deterministic: shuffling the input gives the same studies, series and instance order back", () => {
    const shuffled = [...fixtureFiles].reverse();
    const a = groupAndOrder(fixtureFiles);
    const b = groupAndOrder(shuffled);
    expect(a).toEqual(b);
  });

  it("returns studies and series in a stable order, by identifier", () => {
    const files = [
      file({ fileName: "a", studyInstanceUid: "2", seriesInstanceUid: "2.1" }),
      file({ fileName: "b", studyInstanceUid: "1", seriesInstanceUid: "1.2" }),
      file({ fileName: "c", studyInstanceUid: "1", seriesInstanceUid: "1.1" }),
    ];
    const grouping = groupAndOrder(files);
    expect(grouping.studies.map((s) => s.studyInstanceUid)).toEqual(["1", "2"]);
    expect(grouping.studies[0].series.map((s) => s.seriesInstanceUid)).toEqual(["1.1", "1.2"]);
  });
});

describe("series metadata", () => {
  it("takes modality and description from the one instance that has them, when only one does", () => {
    const files: ParsedInstance[] = [
      { fileName: "a", studyInstanceUid: "1", seriesInstanceUid: "1.1", modality: "MR", seriesDescription: "AXIAL" },
      { fileName: "b", studyInstanceUid: "1", seriesInstanceUid: "1.1" },
    ];
    const [series] = groupAndOrder(files).studies[0].series;
    expect(series.modality).toBe("MR");
    expect(series.description).toBe("AXIAL");
  });

  it("omits modality and description entirely when no instance has one", () => {
    const files: ParsedInstance[] = [{ fileName: "a", studyInstanceUid: "1", seriesInstanceUid: "1.1" }];
    const [series] = groupAndOrder(files).studies[0].series;
    expect(series).not.toHaveProperty("modality");
    expect(series).not.toHaveProperty("description");
  });

  it("takes the majority value when instances disagree, regardless of which order they were supplied in", () => {
    const files: ParsedInstance[] = [
      { fileName: "a", studyInstanceUid: "1", seriesInstanceUid: "1.1", modality: "MR" },
      { fileName: "b", studyInstanceUid: "1", seriesInstanceUid: "1.1", modality: "CT" },
      { fileName: "c", studyInstanceUid: "1", seriesInstanceUid: "1.1", modality: "CT" },
    ];
    const forward = groupAndOrder(files).studies[0].series[0];
    const reversed = groupAndOrder([...files].reverse()).studies[0].series[0];
    expect(forward.modality).toBe("CT");
    expect(reversed.modality).toBe("CT");
  });

  it("breaks an exact tie by the value itself, not by input order, so a tie is still order-independent", () => {
    const files: ParsedInstance[] = [
      { fileName: "a", studyInstanceUid: "1", seriesInstanceUid: "1.1", modality: "MR" },
      { fileName: "b", studyInstanceUid: "1", seriesInstanceUid: "1.1", modality: "CT" },
    ];
    const forward = groupAndOrder(files).studies[0].series[0];
    const reversed = groupAndOrder([...files].reverse()).studies[0].series[0];
    expect(forward.modality).toBe(reversed.modality);
    expect(forward.modality).toBe("CT"); // "CT" < "MR" lexicographically
  });
});
