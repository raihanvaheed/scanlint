import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { groupAndOrder } from "../model/series";
import type { ParsedInstance } from "../model/series";
import type { Orientation, Vector3 } from "../model/geometry";
import { handleParse } from "../parse/handle";
import { checkSeries } from "./series";
import type { ParsedFile, SeriesFinding } from "./series";

const ROOT = path.resolve(__dirname, "../..");
const DIR = path.join(ROOT, "fixtures", "series");

type Manifest = {
  studyInstanceUid: string;
  files: { file: string; seriesInstanceUid: string }[];
  series: { label: string; seriesInstanceUid: string }[];
};
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "series.manifest.json"), "utf8")) as Manifest;

const num = (s: string | undefined) => (s ?? "").split("\\").map(Number);

function parse(name: string): { instance: ParsedInstance; parsedFile: ParsedFile } {
  const outcome = handleParse(new Uint8Array(fs.readFileSync(path.join(DIR, name))));
  if (!outcome.ok) throw new Error(`${name}: ${outcome.message}`);
  const byTag = new Map(outcome.nodes.map((n) => [n.tag, n]));
  const value = (tag: string) => byTag.get(tag)?.value;
  const orientation = value("00200037");
  const position = value("00200032");
  const instanceNumber = value("00200013");
  const instance: ParsedInstance = {
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
  return { instance, parsedFile: { nodes: outcome.nodes, findings: outcome.findings } };
}

const parsedFixture = manifest.files.map((f) => parse(f.file));
const fixtureFiles = parsedFixture.map((p) => p.instance);
const fixtureParsed = new Map(parsedFixture.map((p) => [p.instance.fileName, p.parsedFile]));

const SERIES_A = manifest.series.find((s) => s.label === "A")!.seriesInstanceUid;
const SERIES_B = manifest.series.find((s) => s.label === "B")!.seriesInstanceUid;

// Sorts array-valued fields so the exact-equality test isn't sensitive to iteration order the spec
// never dictates (which file lands first inside a `modalities` bucket, for instance).
function normalize(f: SeriesFinding): SeriesFinding {
  const out: SeriesFinding = { ...f };
  if (out.files) out.files = [...out.files].sort();
  if (out.modalities) {
    out.modalities = Object.fromEntries(Object.entries(out.modalities).map(([k, v]) => [k, [...v].sort()]));
  }
  return out;
}

function byCanonicalOrder(a: SeriesFinding, b: SeriesFinding): number {
  const ka = JSON.stringify(normalize(a));
  const kb = JSON.stringify(normalize(b));
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function sorted(findings: SeriesFinding[]): SeriesFinding[] {
  return findings.map(normalize).sort(byCanonicalOrder);
}

describe("against the fixture", () => {
  const grouping = groupAndOrder(fixtureFiles);
  const produced = checkSeries(grouping, fixtureParsed);

  // The manifest's own oracle, translated from its two lists (`seriesFindings` and
  // `consequencesOfMisfiledSlice` - the second is what the A-9 misfile causes, kept separate in the
  // manifest for readability) into this module's SeriesFinding shape. See the PR description for why
  // this is 11 findings, not the 10 the step's own sketch expected: the manifest's extra-field entry
  // for A-3 only listed the top-level ReferringPhysicianName; A-3 also keeps a nested copy the rest
  // of the series lacks, which is a second, distinct finding compared by canonical path.
  const expected: SeriesFinding[] = [
    { kind: "position-gap", scope: "series", seriesInstanceUid: SERIES_A, files: ["IM_0014", "IM_0007"], expectedMm: 3, actualMm: 6 },
    { kind: "position-gap", scope: "series", seriesInstanceUid: SERIES_A, files: ["IM_0007", "IM_0013"], expectedMm: 3, actualMm: 6 },
    { kind: "position-gap", scope: "series", seriesInstanceUid: SERIES_B, files: ["IM_0008", "IM_0001"], expectedMm: 5, actualMm: 9 },
    { kind: "extra-field", scope: "series", seriesInstanceUid: SERIES_A, tag: "00080090", path: "00080090", files: ["IM_0011"] },
    {
      kind: "extra-field",
      scope: "series",
      seriesInstanceUid: SERIES_A,
      tag: "00080090",
      path: "04000561/0/04000550/0/00080090",
      files: ["IM_0011"],
    },
    {
      kind: "varying-value",
      scope: "series",
      seriesInstanceUid: SERIES_A,
      tag: "00100020",
      path: "00100020",
      files: ["IM_0006"],
      values: { IM_0006: "SCANLINT-MISFILED-0005" },
      otherFiles: "SCANLINT-TEST-0001",
    },
    {
      kind: "varying-value",
      scope: "series",
      seriesInstanceUid: SERIES_B,
      tag: "0008103e",
      path: "0008103e",
      files: ["IM_0001"],
      values: { IM_0001: "SYNTHETIC AXIAL MR SERIES" },
      otherFiles: "SYNTHETIC AXIAL CT SERIES",
    },
    {
      kind: "inconsistent-pixel-spacing",
      scope: "series",
      seriesInstanceUid: SERIES_A,
      files: ["IM_0007"],
      spacingValues: { IM_0007: [0.6, 0.6] },
      expectedSpacing: [0.5, 0.5],
    },
    {
      kind: "inconsistent-pixel-spacing",
      scope: "series",
      seriesInstanceUid: SERIES_B,
      files: ["IM_0001"],
      spacingValues: { IM_0001: [0.5, 0.5] },
      expectedSpacing: [0.7, 0.7],
    },
    {
      kind: "mixed-modality",
      scope: "series",
      seriesInstanceUid: SERIES_B,
      modalities: { CT: ["IM_0002", "IM_0005", "IM_0008", "IM_0012"], MR: ["IM_0001"] },
    },
    {
      kind: "mixed-modality",
      scope: "folder",
      modalities: {
        CT: fixtureFiles.filter((f) => f.modality === "CT").map((f) => f.fileName),
        MR: fixtureFiles.filter((f) => f.modality === "MR").map((f) => f.fileName),
      },
    },
  ];

  it("the fixture's modality split is 11 MR (including the misfiled slice) and 4 CT, as the manifest declares", () => {
    expect(fixtureFiles.filter((f) => f.modality === "MR")).toHaveLength(11);
    expect(fixtureFiles.filter((f) => f.modality === "CT")).toHaveLength(4);
  });

  it("produces exactly the expected findings - nothing missing", () => {
    const missing = sorted(expected).filter((e) => !sorted(produced).some((p) => JSON.stringify(p) === JSON.stringify(e)));
    expect(missing).toEqual([]);
  });

  it("produces exactly the expected findings - nothing extra", () => {
    const extra = sorted(produced).filter((p) => !sorted(expected).some((e) => JSON.stringify(e) === JSON.stringify(p)));
    expect(extra).toEqual([]);
  });

  it("produces exactly 11 findings, matching the expected count", () => {
    expect(produced).toHaveLength(expected.length);
    expect(produced).toHaveLength(11);
  });

  it("never reports a varying-value finding for an exempt tag, even though SOPInstanceUID genuinely differs on every slice", () => {
    expect(produced.filter((f) => f.kind === "varying-value" && f.tag === "00080018")).toEqual([]);
  });
});

describe("position gaps", () => {
  const seriesUid = "1.1";
  const orientation: Orientation = [1, 0, 0, 0, 1, 0];
  const file = (fileName: string, z: number, instanceNumber: number): ParsedInstance => ({
    fileName,
    studyInstanceUid: "1",
    seriesInstanceUid: seriesUid,
    instanceNumber,
    imageOrientationPatient: orientation,
    imagePositionPatient: [0, 0, z],
  });
  const parsedOf = (fileNames: string[]): Map<string, ParsedFile> =>
    new Map(fileNames.map((f) => [f, { nodes: [], findings: [] }]));

  it("a perfectly even series produces no position-gap findings", () => {
    const files = [file("a", 0, 1), file("b", 3, 2), file("c", 6, 3), file("d", 9, 4)];
    const grouping = groupAndOrder(files);
    const findings = checkSeries(grouping, parsedOf(files.map((f) => f.fileName)));
    expect(findings.filter((f) => f.kind === "position-gap")).toEqual([]);
  });

  it("a two-slice series produces no position-gap finding - there's no mode with only one difference", () => {
    const files = [file("a", 0, 1), file("b", 100, 2)];
    const grouping = groupAndOrder(files);
    const findings = checkSeries(grouping, parsedOf(files.map((f) => f.fileName)));
    expect(findings.filter((f) => f.kind === "position-gap")).toEqual([]);
  });

  it("float noise of 1e-6 mm on otherwise-even positions produces no gaps - what the 0.01 mm tolerance exists for", () => {
    const files = [
      file("a", 0, 1),
      file("b", 3 + 1e-6, 2),
      file("c", 6 - 1e-6, 3),
      file("d", 9 + 1e-6, 4),
      file("e", 12, 5),
    ];
    const grouping = groupAndOrder(files);
    const findings = checkSeries(grouping, parsedOf(files.map((f) => f.fileName)));
    expect(findings.filter((f) => f.kind === "position-gap")).toEqual([]);
  });

  it("a single actual gap among otherwise-even spacing is reported with its expected and actual values", () => {
    const files = [file("a", 0, 1), file("b", 3, 2), file("c", 6, 3), file("d", 12, 4), file("e", 15, 5)];
    const grouping = groupAndOrder(files);
    const findings = checkSeries(grouping, parsedOf(files.map((f) => f.fileName)));
    expect(findings.filter((f) => f.kind === "position-gap")).toEqual([
      { kind: "position-gap", scope: "series", seriesInstanceUid: seriesUid, files: ["c", "d"], expectedMm: 3, actualMm: 6 },
    ]);
  });

  it("a difference just outside the 0.01 mm tolerance is reported, however small", () => {
    const files = [file("a", 0, 1), file("b", 3, 2), file("c", 6.02, 3), file("d", 9.02, 4)];
    const grouping = groupAndOrder(files);
    const findings = checkSeries(grouping, parsedOf(files.map((f) => f.fileName)));
    const gaps = findings.filter((f) => f.kind === "position-gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: "position-gap", scope: "series", seriesInstanceUid: seriesUid, files: ["b", "c"], expectedMm: 3 });
    expect(gaps[0].actualMm).toBeCloseTo(3.02, 9);
  });

  it("an exact tie between two candidate gap sizes breaks toward the smaller, per the same reasoning as mostCommonValue", () => {
    // Diffs are 3, 3, 6, 6: two candidates, tied at two occurrences each. The smaller (3) wins as
    // "expected", so the two 6 mm steps are reported as gaps - not the other way around.
    const files = [file("a", 0, 1), file("b", 3, 2), file("c", 6, 3), file("d", 12, 4), file("e", 18, 5)];
    const grouping = groupAndOrder(files);
    const findings = checkSeries(grouping, parsedOf(files.map((f) => f.fileName)));
    expect(findings.filter((f) => f.kind === "position-gap")).toEqual([
      { kind: "position-gap", scope: "series", seriesInstanceUid: seriesUid, files: ["c", "d"], expectedMm: 3, actualMm: 6 },
      { kind: "position-gap", scope: "series", seriesInstanceUid: seriesUid, files: ["d", "e"], expectedMm: 3, actualMm: 6 },
    ]);
  });
});

describe("duplicate positions", () => {
  it("two slices at the same distance, within tolerance, are reported", () => {
    const orientation: Orientation = [1, 0, 0, 0, 1, 0];
    const file = (fileName: string, z: number, instanceNumber: number): ParsedInstance => ({
      fileName,
      studyInstanceUid: "1",
      seriesInstanceUid: "1.1",
      instanceNumber,
      imageOrientationPatient: orientation,
      imagePositionPatient: [0, 0, z],
    });
    const files = [file("a", 0, 1), file("b", 3, 2), file("c", 3.005, 3), file("d", 6, 4)];
    const grouping = groupAndOrder(files);
    const parsed = new Map(files.map((f) => [f.fileName, { nodes: [], findings: [] }]));
    const findings = checkSeries(grouping, parsed);
    expect(findings.filter((f) => f.kind === "duplicate-position")).toEqual([
      { kind: "duplicate-position", scope: "series", seriesInstanceUid: "1.1", files: ["b", "c"] },
    ]);
  });

  it("the fixture itself has no duplicate positions in either series", () => {
    const grouping = groupAndOrder(fixtureFiles);
    const findings = checkSeries(grouping, fixtureParsed);
    expect(findings.filter((f) => f.kind === "duplicate-position")).toEqual([]);
  });
});

describe("ordering fallback", () => {
  it("a series ordered by instance-number gets no gap and no duplicate-position findings, even with uneven spacing", () => {
    const files: ParsedInstance[] = [
      { fileName: "a", studyInstanceUid: "1", seriesInstanceUid: "1.1", instanceNumber: 1 },
      { fileName: "b", studyInstanceUid: "1", seriesInstanceUid: "1.1", instanceNumber: 2 },
      { fileName: "c", studyInstanceUid: "1", seriesInstanceUid: "1.1", instanceNumber: 3 },
    ];
    const grouping = groupAndOrder(files);
    expect(grouping.studies[0].series[0].orderedBy).toBe("instance-number");
    const parsed = new Map(files.map((f) => [f.fileName, { nodes: [], findings: [] }]));
    const findings = checkSeries(grouping, parsed);
    expect(findings.filter((f) => f.kind === "position-gap" || f.kind === "duplicate-position")).toEqual([]);
  });
});

describe("inconsistent orientation", () => {
  it("is reported when 2.3 recorded orientationConsistent: false, naming every slice in the series", () => {
    const files: ParsedInstance[] = [
      {
        fileName: "a",
        studyInstanceUid: "1",
        seriesInstanceUid: "1.1",
        instanceNumber: 1,
        imageOrientationPatient: [1, 0, 0, 0, 1, 0],
        imagePositionPatient: [0, 0, 0],
      },
      {
        fileName: "b",
        studyInstanceUid: "1",
        seriesInstanceUid: "1.1",
        instanceNumber: 2,
        imageOrientationPatient: [1, 0, 0, 0, 0, -1],
        imagePositionPatient: [0, 0, 10],
      },
    ];
    const grouping = groupAndOrder(files);
    const parsed = new Map(files.map((f) => [f.fileName, { nodes: [], findings: [] }]));
    const findings = checkSeries(grouping, parsed);
    expect(findings.filter((f) => f.kind === "inconsistent-orientation")).toEqual([
      { kind: "inconsistent-orientation", scope: "series", seriesInstanceUid: "1.1", files: ["a", "b"] },
    ]);
  });

  it("the fixture's two series are both internally orientation-consistent, so neither reports this", () => {
    const grouping = groupAndOrder(fixtureFiles);
    const findings = checkSeries(grouping, fixtureParsed);
    expect(findings.filter((f) => f.kind === "inconsistent-orientation")).toEqual([]);
  });
});

describe("inconsistent identifier", () => {
  it("is reported when one SeriesInstanceUID appears under two different studies", () => {
    const files: ParsedInstance[] = [
      { fileName: "a", studyInstanceUid: "study-1", seriesInstanceUid: "shared-series", instanceNumber: 1 },
      { fileName: "b", studyInstanceUid: "study-2", seriesInstanceUid: "shared-series", instanceNumber: 1 },
    ];
    const grouping = groupAndOrder(files);
    expect(grouping.studies).toHaveLength(2);
    const parsed = new Map(files.map((f) => [f.fileName, { nodes: [], findings: [] }]));
    const findings = checkSeries(grouping, parsed);
    const identifierFindings = findings.filter((f) => f.kind === "inconsistent-identifier");
    expect(identifierFindings).toHaveLength(1);
    expect(identifierFindings[0].seriesInstanceUid).toBe("shared-series");
    expect(identifierFindings[0].files?.sort()).toEqual(["a", "b"]);
  });

  it("the fixture has no such disagreement", () => {
    const grouping = groupAndOrder(fixtureFiles);
    const findings = checkSeries(grouping, fixtureParsed);
    expect(findings.filter((f) => f.kind === "inconsistent-identifier")).toEqual([]);
  });
});

describe("extra field", () => {
  it("reports a private tag present on one slice only, distinct from a standard tag", () => {
    const seriesUid = "1.1";
    const privateFinding = (path: string): import("../model/types").Finding => ({ path, tag: "00990010", vr: "LO", kind: "private" });
    const files: ParsedInstance[] = [
      { fileName: "a", studyInstanceUid: "1", seriesInstanceUid: seriesUid, instanceNumber: 1 },
      { fileName: "b", studyInstanceUid: "1", seriesInstanceUid: seriesUid, instanceNumber: 2 },
    ];
    const grouping = groupAndOrder(files);
    const parsed = new Map<string, ParsedFile>([
      ["a", { nodes: [], findings: [privateFinding("00990010")] }],
      ["b", { nodes: [], findings: [] }],
    ]);
    const findings = checkSeries(grouping, parsed);
    expect(findings.filter((f) => f.kind === "extra-field")).toEqual([
      { kind: "extra-field", scope: "series", seriesInstanceUid: seriesUid, tag: "00990010", path: "00990010", files: ["a"] },
    ]);
  });

  it("a single-instance series produces no extra-field findings - there's nothing to compare it against", () => {
    const files: ParsedInstance[] = [{ fileName: "a", studyInstanceUid: "1", seriesInstanceUid: "1.1", instanceNumber: 1 }];
    const grouping = groupAndOrder(files);
    const parsed = new Map<string, ParsedFile>([["a", { nodes: [], findings: [{ path: "00080090", tag: "00080090", vr: "PN", kind: "annex-e" }] }]]);
    const findings = checkSeries(grouping, parsed);
    expect(findings.filter((f) => f.kind === "extra-field")).toEqual([]);
  });
});

describe("varying value", () => {
  it("every exempt tag varying across a series produces no finding", () => {
    const seriesUid = "1.1";
    const files: ParsedInstance[] = [
      { fileName: "a", studyInstanceUid: "1", seriesInstanceUid: seriesUid, instanceNumber: 1 },
      { fileName: "b", studyInstanceUid: "1", seriesInstanceUid: seriesUid, instanceNumber: 2 },
    ];
    const grouping = groupAndOrder(files);
    const exemptFinding = (tag: string, value: string): import("../model/types").Finding => ({ path: tag, tag, vr: "UI", kind: "annex-e", value });
    const exemptTags = ["00080018", "00080013", "00080032", "00080033", "0008002a", "00200012", "00201041"];
    const parsed = new Map<string, ParsedFile>([
      ["a", { nodes: [], findings: exemptTags.map((t) => exemptFinding(t, `${t}-a`)) }],
      ["b", { nodes: [], findings: exemptTags.map((t) => exemptFinding(t, `${t}-b`)) }],
    ]);
    const findings = checkSeries(grouping, parsed);
    expect(findings.filter((f) => f.kind === "varying-value")).toEqual([]);
  });

  it("a private finding with differing values across a series produces no varying-value finding - only its presence is checked, by extra-field", () => {
    const seriesUid = "1.1";
    const files: ParsedInstance[] = [
      { fileName: "a", studyInstanceUid: "1", seriesInstanceUid: seriesUid, instanceNumber: 1 },
      { fileName: "b", studyInstanceUid: "1", seriesInstanceUid: seriesUid, instanceNumber: 2 },
    ];
    const grouping = groupAndOrder(files);
    const parsed = new Map<string, ParsedFile>([
      ["a", { nodes: [], findings: [{ path: "00990010", tag: "00990010", vr: "LO", kind: "private", value: "one" }] }],
      ["b", { nodes: [], findings: [{ path: "00990010", tag: "00990010", vr: "LO", kind: "private", value: "two" }] }],
    ]);
    const findings = checkSeries(grouping, parsed);
    expect(findings.filter((f) => f.kind === "varying-value")).toEqual([]);
  });

  it("a burned-in finding is never treated as identifying, so its presence alone (extra-field) is the only thing that would be reported", () => {
    const seriesUid = "1.1";
    const files: ParsedInstance[] = [
      { fileName: "a", studyInstanceUid: "1", seriesInstanceUid: seriesUid, instanceNumber: 1 },
      { fileName: "b", studyInstanceUid: "1", seriesInstanceUid: seriesUid, instanceNumber: 2 },
    ];
    const grouping = groupAndOrder(files);
    const parsed = new Map<string, ParsedFile>([
      ["a", { nodes: [], findings: [{ path: "00280301", tag: "00280301", vr: "CS", kind: "burned-in", value: "YES" }] }],
      ["b", { nodes: [], findings: [{ path: "00280301", tag: "00280301", vr: "CS", kind: "burned-in", value: "NO" }] }],
    ]);
    const findings = checkSeries(grouping, parsed);
    expect(findings.filter((f) => f.kind === "varying-value")).toEqual([]);
  });

  it("a finding present on only some slices produces no varying-value finding - that's extra-field's job, not this check's", () => {
    const seriesUid = "1.1";
    const files: ParsedInstance[] = [
      { fileName: "a", studyInstanceUid: "1", seriesInstanceUid: seriesUid, instanceNumber: 1 },
      { fileName: "b", studyInstanceUid: "1", seriesInstanceUid: seriesUid, instanceNumber: 2 },
      { fileName: "c", studyInstanceUid: "1", seriesInstanceUid: seriesUid, instanceNumber: 3 },
    ];
    const grouping = groupAndOrder(files);
    const parsed = new Map<string, ParsedFile>([
      ["a", { nodes: [], findings: [{ path: "00100020", tag: "00100020", vr: "LO", kind: "annex-e", value: "ONE" }] }],
      ["b", { nodes: [], findings: [{ path: "00100020", tag: "00100020", vr: "LO", kind: "annex-e", value: "TWO" }] }],
      ["c", { nodes: [], findings: [] }], // missing entirely, not merely differing
    ]);
    const findings = checkSeries(grouping, parsed);
    expect(findings.filter((f) => f.kind === "varying-value")).toEqual([]);
    expect(findings.filter((f) => f.kind === "extra-field")).toHaveLength(1);
  });

  it("a genuine three-way tie for majority breaks toward the lexicographically smallest value, same reasoning as everywhere else", () => {
    const seriesUid = "1.1";
    const files: ParsedInstance[] = [
      { fileName: "a", studyInstanceUid: "1", seriesInstanceUid: seriesUid, instanceNumber: 1 },
      { fileName: "b", studyInstanceUid: "1", seriesInstanceUid: seriesUid, instanceNumber: 2 },
      { fileName: "c", studyInstanceUid: "1", seriesInstanceUid: seriesUid, instanceNumber: 3 },
    ];
    const grouping = groupAndOrder(files);
    const findingAt = (value: string): import("../model/types").Finding => ({ path: "00100020", tag: "00100020", vr: "LO", kind: "annex-e", value });
    const parsed = new Map<string, ParsedFile>([
      ["a", { nodes: [], findings: [findingAt("ZEBRA")] }],
      ["b", { nodes: [], findings: [findingAt("APPLE")] }],
      ["c", { nodes: [], findings: [findingAt("MANGO")] }],
    ]);
    const findings = checkSeries(grouping, parsed);
    expect(findings.filter((f) => f.kind === "varying-value")).toEqual([
      {
        kind: "varying-value",
        scope: "series",
        seriesInstanceUid: seriesUid,
        tag: "00100020",
        path: "00100020",
        files: ["a", "c"],
        values: { a: "ZEBRA", c: "MANGO" },
        otherFiles: "APPLE",
      },
    ]);
  });
});

describe("mixed modality", () => {
  it("reports both scopes, distinguishable by their scope field, for a folder holding two single-modality series", () => {
    const mr = (n: string, i: number): ParsedInstance => ({ fileName: n, studyInstanceUid: "1", seriesInstanceUid: "1.1", instanceNumber: i, modality: "MR" });
    const ct = (n: string, i: number): ParsedInstance => ({ fileName: n, studyInstanceUid: "1", seriesInstanceUid: "1.2", instanceNumber: i, modality: "CT" });
    const files = [mr("a", 1), mr("b", 2), ct("c", 1), ct("d", 2)];
    const grouping = groupAndOrder(files);
    // checkSeries reads Modality off `parsed`'s tag nodes, not off `ParsedInstance` - 2.3's grouping
    // only keeps modality as a series-level summary, so the per-file tag has to be supplied here too.
    const modalityNode = (modality: string): import("../model/types").TagNode => ({ tag: "00080060", path: "00080060", vr: "CS", value: modality });
    const parsed = new Map(files.map((f) => [f.fileName, { nodes: [modalityNode(f.modality!)], findings: [] }]));
    const findings = checkSeries(grouping, parsed);

    const withinSeries = findings.filter((f) => f.kind === "mixed-modality" && f.scope === "series");
    const acrossFolder = findings.filter((f) => f.kind === "mixed-modality" && f.scope === "folder");
    expect(withinSeries).toEqual([]); // neither series is internally mixed
    expect(acrossFolder).toHaveLength(1);
    expect(acrossFolder[0].modalities).toEqual({ MR: ["a", "b"], CT: ["c", "d"] });
  });
});
