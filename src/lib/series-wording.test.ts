import { describe, expect, it } from "vitest";
import { formatFileList, IDENTIFYING_KINDS, STRUCTURAL_KINDS, wordFinding } from "./series-wording";
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

  it("mixed-modality at series scope: names the minority and majority modalities, and lists only the minority files", () => {
    const finding: SeriesFinding = { ...base, kind: "mixed-modality", modalities: { CT: ["a", "b", "c", "d"], MR: ["e"] } };
    const worded = wordFinding(finding);
    expect(worded.text).toBe("This series contains 1 file from a different kind of scan — MR among CT");
    expect(worded.files).toEqual(["e"]);
  });

  it("mixed-modality at series scope: pluralises the minority count correctly", () => {
    const finding: SeriesFinding = { ...base, kind: "mixed-modality", modalities: { CT: ["a", "b", "c"], MR: ["d", "e"] } };
    expect(wordFinding(finding).text).toBe("This series contains 2 files from a different kind of scan — MR among CT");
  });

  it("mixed-modality at folder scope: names every modality with its own count, and lists no files at all", () => {
    const finding: SeriesFinding = { kind: "mixed-modality", scope: "folder", modalities: { CT: ["a", "b", "c", "d"], MR: ["e"] } };
    const worded = wordFinding(finding);
    expect(worded.text).toBe("This folder holds more than one kind of scan — CT (4 files), MR (1 file)");
    expect(worded.files).toEqual([]);
  });

  it("mixed-modality: breaks a tied majority alphabetically, deterministic regardless of key order", () => {
    const finding: SeriesFinding = { ...base, kind: "mixed-modality", modalities: { MR: ["a"], CT: ["b"] } };
    // CT < MR alphabetically, so CT is the majority even though MR was listed first.
    expect(wordFinding(finding).text).toBe("This series contains 1 file from a different kind of scan — MR among CT");
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

describe("formatFileList", () => {
  it("lists every name when there are five or fewer", () => {
    expect(formatFileList(["a", "b", "c"])).toBe("a, b, c");
    expect(formatFileList(["a", "b", "c", "d", "e"])).toBe("a, b, c, d, e");
  });

  it("lists the first five, then how many more, for a finding affecting 40 files", () => {
    const files = Array.from({ length: 40 }, (_, i) => `IM_${String(i + 1).padStart(4, "0")}`);
    expect(formatFileList(files)).toBe("IM_0001, IM_0002, IM_0003, IM_0004, IM_0005, and 35 more");
  });

  it("truncates at exactly six", () => {
    const files = ["a", "b", "c", "d", "e", "f"];
    expect(formatFileList(files)).toBe("a, b, c, d, e, and 1 more");
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
