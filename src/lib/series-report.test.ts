import { describe, expect, it } from "vitest";
import { buildSeriesReport, groupFindingsBySeries, headlineLines, seriesNumberOf } from "./series-report";
import type { Grouping } from "../model/series";
import type { Finding } from "../model/types";
import type { SeriesFinding } from "../rules/series";

const NO_GROUPING: Grouping = { studies: [], ungrouped: [] };
const burnedIn = (value: string): Finding => ({ path: "00280301", tag: "00280301", vr: "CS", kind: "burned-in", value });
const identifying = (n: number): Finding[] => [{ path: `p${n}`, tag: "00100010", vr: "PN", kind: "annex-e" }];

describe("buildSeriesReport", () => {
  const grouping: Grouping = {
    studies: [
      { studyInstanceUid: "1", series: [{ seriesInstanceUid: "1.1", orderedBy: "position", orientationConsistent: true, instances: [] }] },
      { studyInstanceUid: "2", series: [{ seriesInstanceUid: "2.1", orderedBy: "position", orientationConsistent: true, instances: [] }] },
    ],
    ungrouped: [],
  };
  const findings: SeriesFinding[] = [
    { kind: "varying-value", scope: "series", seriesInstanceUid: "1.1", files: ["a"] },
    { kind: "extra-field", scope: "series", seriesInstanceUid: "1.1", files: ["a"] },
    { kind: "position-gap", scope: "series", seriesInstanceUid: "1.1", files: ["a", "b"] },
  ];

  it("counts series across every study, not just the first", () => {
    expect(buildSeriesReport(grouping, [], []).seriesCount).toBe(2);
  });

  it("splits findings into identifying and structural by section 4's rule", () => {
    const report = buildSeriesReport(grouping, findings, []);
    expect(report.notConsistentFindings).toHaveLength(2);
    expect(report.structuralFindings).toHaveLength(1);
  });

  it("counts read files as given, independent of grouping", () => {
    const report = buildSeriesReport(grouping, [], [{ fileName: "a", findings: [] }, { fileName: "b", findings: [] }]);
    expect(report.totalRead).toBe(2);
  });
});

describe("headlineLines", () => {
  it("gives all four lines when everything is non-zero, worded exactly as the screen shows them", () => {
    const grouping: Grouping = {
      studies: [{ studyInstanceUid: "1", series: [{ seriesInstanceUid: "1.1", orderedBy: "position", orientationConsistent: true, instances: [] }] }],
      ungrouped: [],
    };
    const findings: SeriesFinding[] = [
      { kind: "varying-value", scope: "series", seriesInstanceUid: "1.1", files: ["a"] },
      { kind: "position-gap", scope: "series", seriesInstanceUid: "1.1", files: ["a", "b"] },
    ];
    const report = buildSeriesReport(grouping, findings, [{ fileName: "a", findings: [{ path: "p", tag: "t", vr: "LO", kind: "annex-e" }] }]);
    expect(headlineLines(report)).toEqual([
      "1 file read across 1 series",
      "1 field could identify a patient",
      "1 identifying field is not the same on every file",
      "1 structural inconsistency between files",
    ]);
  });

  it("omits the third and fourth lines when there are no such findings, matching the screen's own section-hiding", () => {
    const grouping: Grouping = { studies: [], ungrouped: [] };
    const report = buildSeriesReport(grouping, [], []);
    expect(headlineLines(report)).toEqual(["0 files read across 0 series", "0 fields could identify a patient"]);
  });
});

describe("burned-in annotation summary (2.6a)", () => {
  it("all files declaring the same value: 'All N files declare burned-in annotation: YES'", () => {
    const readFiles = [
      { fileName: "a", findings: [burnedIn("YES")] },
      { fileName: "b", findings: [burnedIn("YES")] },
    ];
    expect(buildSeriesReport(NO_GROUPING, [], readFiles).burnedIn).toBe("All 2 files declare burned-in annotation: YES");
  });

  it("a single file also uses the 'All' wording, conjugated for the singular", () => {
    const readFiles = [{ fileName: "a", findings: [burnedIn("NO")] }];
    expect(buildSeriesReport(NO_GROUPING, [], readFiles).burnedIn).toBe("All 1 file declares burned-in annotation: NO");
  });

  it("a mix of YES and NO, none absent: 'Burned-in annotation: 14 files declare YES, 1 declares NO'", () => {
    const readFiles = [
      ...Array.from({ length: 14 }, (_, i) => ({ fileName: `yes${i}`, findings: [burnedIn("YES")] })),
      { fileName: "no", findings: [burnedIn("NO")] },
    ];
    expect(buildSeriesReport(NO_GROUPING, [], readFiles).burnedIn).toBe("Burned-in annotation: 14 files declare YES, 1 declares NO");
  });

  it("a majority declaring, some carrying nothing at all: 'Burned-in annotation: 12 files declare YES; 3 do not carry the field'", () => {
    const readFiles = [
      ...Array.from({ length: 12 }, (_, i) => ({ fileName: `yes${i}`, findings: [burnedIn("YES")] })),
      ...Array.from({ length: 3 }, (_, i) => ({ fileName: `absent${i}`, findings: [] })),
    ];
    expect(buildSeriesReport(NO_GROUPING, [], readFiles).burnedIn).toBe("Burned-in annotation: 12 files declare YES; 3 do not carry the field");
  });

  it("no file declares it at all: 'No file declares burned-in annotation.'", () => {
    const readFiles = [
      { fileName: "a", findings: [] },
      { fileName: "b", findings: [] },
    ];
    expect(buildSeriesReport(NO_GROUPING, [], readFiles).burnedIn).toBe("No file declares burned-in annotation.");
  });

  it("an empty folder also reads 'No file declares burned-in annotation.'", () => {
    expect(buildSeriesReport(NO_GROUPING, [], []).burnedIn).toBe("No file declares burned-in annotation.");
  });

  it("is never counted in the identifying-field total - a statement about the image, not a field holding patient data", () => {
    const readFiles = [
      { fileName: "a", findings: [burnedIn("YES"), ...identifying(1)] },
      { fileName: "b", findings: [burnedIn("YES"), ...identifying(1)] },
    ];
    const report = buildSeriesReport(NO_GROUPING, [], readFiles);
    expect(report.aggregatedFields.some((f) => f.tag === "00280301")).toBe(false);
    expect(report.aggregatedFields).toHaveLength(1); // only the identifying field, not burned-in
  });
});

describe("groupFindingsBySeries", () => {
  const grouping: Grouping = {
    studies: [
      { studyInstanceUid: "1", series: [{ seriesInstanceUid: "1.1", orderedBy: "position", orientationConsistent: true, instances: [{ fileName: "a" }] }] },
      { studyInstanceUid: "1", series: [{ seriesInstanceUid: "1.2", orderedBy: "position", orientationConsistent: true, instances: [{ fileName: "b" }] }] },
    ],
    ungrouped: [],
  };
  const parsed = new Map([
    ["a", { nodes: [], findings: [] }],
    ["b", { nodes: [], findings: [] }],
  ]);

  it("groups series-scoped findings under their own series label, in the grouping's order", () => {
    const findings: SeriesFinding[] = [
      { kind: "duplicate-position", scope: "series", seriesInstanceUid: "1.2", files: ["b"] },
      { kind: "duplicate-position", scope: "series", seriesInstanceUid: "1.1", files: ["a"] },
    ];
    const groups = groupFindingsBySeries(findings, grouping, parsed);
    expect(groups.map((g) => g.label)).toEqual(["Series 1", "Series 2"]);
    expect(groups[0].findings).toHaveLength(1);
    expect(groups[0].findings[0].seriesInstanceUid).toBe("1.1");
  });

  it("puts folder-scoped findings under 'Whole folder', last", () => {
    const findings: SeriesFinding[] = [
      { kind: "mixed-modality", scope: "folder", modalities: {} },
      { kind: "duplicate-position", scope: "series", seriesInstanceUid: "1.1", files: ["a"] },
    ];
    const groups = groupFindingsBySeries(findings, grouping, parsed);
    expect(groups.map((g) => g.label)).toEqual(["Series 1", "Whole folder"]);
  });

  it("omits a series with nothing to report - no empty heading", () => {
    const findings: SeriesFinding[] = [{ kind: "duplicate-position", scope: "series", seriesInstanceUid: "1.1", files: ["a"] }];
    const groups = groupFindingsBySeries(findings, grouping, parsed);
    expect(groups.map((g) => g.label)).toEqual(["Series 1"]);
  });
});

describe("seriesNumberOf", () => {
  it("reads SeriesNumber from the first instance that has it", () => {
    const parsed = new Map([
      ["a", { nodes: [], findings: [] }],
      ["b", { nodes: [{ tag: "00200011", path: "00200011", vr: "IS", value: "2" }], findings: [] }],
    ]);
    expect(seriesNumberOf(["a", "b"], parsed)).toBe("2");
  });

  it("returns undefined when no instance carries it", () => {
    const parsed = new Map([["a", { nodes: [], findings: [] }]]);
    expect(seriesNumberOf(["a"], parsed)).toBeUndefined();
  });
});
