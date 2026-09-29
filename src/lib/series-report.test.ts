import { describe, expect, it } from "vitest";
import { buildSeriesReport, seriesNumberOf } from "./series-report";
import type { Grouping } from "../model/series";
import type { SeriesFinding } from "../rules/series";

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
