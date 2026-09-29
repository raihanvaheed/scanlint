import { describe, expect, it } from "vitest";
import { IDENTIFYING_KINDS, STRUCTURAL_KINDS, wordFinding } from "./series-wording";
import type { SeriesFinding } from "../rules/series";

const base = { scope: "series" as const, seriesInstanceUid: "1.1" };

describe("wordFinding: section 6's table, verbatim", () => {
  it("varying-value names the field", () => {
    const finding: SeriesFinding = { ...base, kind: "varying-value", tag: "00100020", path: "00100020", files: ["a"] };
    expect(wordFinding(finding).text).toBe("Patient ID is not the same on every file");
  });

  it("extra-field names the field and counts against the series total", () => {
    const finding: SeriesFinding = { ...base, kind: "extra-field", tag: "00080090", path: "00080090", files: ["a"] };
    expect(wordFinding(finding, { totalInSeries: 10 }).text).toBe("Referring Physician's Name appears on 1 of 10 files only");
  });

  it("falls back to the formatted tag when the dictionary has no name", () => {
    const finding: SeriesFinding = { ...base, kind: "varying-value", tag: "00990010", path: "00990010", files: ["a"] };
    expect(wordFinding(finding).text).toBe("(0099,0010) is not the same on every file");
  });

  it("position-gap states both figures, trimming float noise", () => {
    const finding: SeriesFinding = { ...base, kind: "position-gap", files: ["a", "b"], expectedMm: 3, actualMm: 6.0199999999999996 };
    expect(wordFinding(finding).text).toBe("A slice may be missing — 6.02 mm between two slices where 3 mm is expected");
  });

  it("duplicate-position is a fixed sentence", () => {
    const finding: SeriesFinding = { ...base, kind: "duplicate-position", files: ["a", "b"] };
    expect(wordFinding(finding).text).toBe("Two slices occupy the same position");
  });

  it("inconsistent-pixel-spacing conjugates correctly for one file - section 6's '(s)' covers the noun, not freezing the verb wrong", () => {
    const finding: SeriesFinding = { ...base, kind: "inconsistent-pixel-spacing", files: ["a"] };
    expect(wordFinding(finding).text).toBe("1 file has different pixel dimensions from the rest");
  });

  it("inconsistent-pixel-spacing pluralises correctly for more than one file", () => {
    const finding: SeriesFinding = { ...base, kind: "inconsistent-pixel-spacing", files: ["a", "b"] };
    expect(wordFinding(finding).text).toBe("2 files have different pixel dimensions from the rest");
  });

  it("inconsistent-orientation is a fixed sentence", () => {
    const finding: SeriesFinding = { ...base, kind: "inconsistent-orientation", files: ["a", "b"] };
    expect(wordFinding(finding).text).toBe("Slices in this series are not all in the same plane");
  });

  it("inconsistent-identifier is a fixed sentence", () => {
    const finding: SeriesFinding = { ...base, kind: "inconsistent-identifier", files: ["a", "b"] };
    expect(wordFinding(finding).text).toBe("Slices in this series belong to different studies");
  });

  it("mixed-modality at series scope", () => {
    const finding: SeriesFinding = { ...base, kind: "mixed-modality", modalities: { CT: ["a"], MR: ["b"] } };
    expect(wordFinding(finding).text).toBe("This series contains a file from a different kind of scan");
  });

  it("mixed-modality at folder scope", () => {
    const finding: SeriesFinding = { kind: "mixed-modality", scope: "folder", modalities: { CT: ["a"], MR: ["b"] } };
    expect(wordFinding(finding).text).toBe("This folder holds more than one kind of scan");
  });

  it("derives files from `modalities` when `files` is absent, for mixed-modality", () => {
    const finding: SeriesFinding = { kind: "mixed-modality", scope: "folder", modalities: { CT: ["a", "b"], MR: ["c"] } };
    expect(wordFinding(finding).files.sort()).toEqual(["a", "b", "c"]);
  });

  it("passes through a nested finding's canonical path, as Stage 1 does", () => {
    const finding: SeriesFinding = { ...base, kind: "extra-field", tag: "00080090", path: "seq/0/00080090", files: ["a"] };
    expect(wordFinding(finding, { totalInSeries: 5 }).path).toBe("seq/0/00080090");
  });

  it("has no path for a structural finding", () => {
    const finding: SeriesFinding = { ...base, kind: "duplicate-position", files: ["a", "b"] };
    expect(wordFinding(finding).path).toBeUndefined();
  });
});

describe("the identifying/structural split", () => {
  it("matches section 4's rule exactly", () => {
    expect([...IDENTIFYING_KINDS].sort()).toEqual(["extra-field", "varying-value"]);
    expect([...STRUCTURAL_KINDS].sort()).toEqual([
      "duplicate-position",
      "inconsistent-identifier",
      "inconsistent-orientation",
      "inconsistent-pixel-spacing",
      "mixed-modality",
      "position-gap",
    ]);
  });
});
