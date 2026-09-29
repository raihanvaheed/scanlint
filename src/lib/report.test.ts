import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { handleParse } from "../parse/handle";
import { groupAndOrder } from "../model/series";
import type { ParsedInstance } from "../model/series";
import { checkSeries } from "../rules/series";
import { toParsedInstance } from "./series-input";
import { buildSeriesReport } from "./series-report";
import { buildJsonReport, buildMarkdownReport, reportFilename, slugify } from "./report";
import type { ReportInput } from "./report";

const ROOT = path.resolve(__dirname, "../..");
const DIR = path.join(ROOT, "fixtures", "series");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "series.manifest.json"), "utf8")) as {
  files: { file: string }[];
  seriesFindings: unknown[];
  consequencesOfMisfiledSlice: unknown[];
  studyInstanceUid: string;
  series: { seriesInstanceUid: string }[];
};

function parseFixtureFile(name: string) {
  const outcome = handleParse(new Uint8Array(fs.readFileSync(path.join(DIR, name))));
  if (!outcome.ok) throw new Error(`${name}: ${outcome.message}`);
  return { fileName: name, nodes: outcome.nodes, findings: outcome.findings };
}

const fixtureFiles = manifest.files.map((f) => parseFixtureFile(f.file));
const fixtureInstances: ParsedInstance[] = fixtureFiles.map((f) => toParsedInstance(f.fileName, undefined, f.nodes));
const fixtureParsed = new Map(fixtureFiles.map((f) => [f.fileName, { nodes: f.nodes, findings: f.findings }]));
const fixtureGrouping = groupAndOrder(fixtureInstances);
const fixtureFindings = checkSeries(fixtureGrouping, fixtureParsed);
const fixtureReport = buildSeriesReport(
  fixtureGrouping,
  fixtureFindings,
  fixtureFiles.map((f) => ({ fileName: f.fileName, findings: f.findings })),
);

function reportInput(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    folderName: "series",
    totals: { selected: 19, read: 15, notDicom: 3, dicomdir: 1, failed: 0 },
    grouping: fixtureGrouping,
    findings: fixtureFindings,
    parsed: fixtureParsed,
    report: fixtureReport,
    failedFiles: [],
    includeValues: false,
    ...overrides,
  };
}

const FIXED_NOW = new Date(2026, 0, 15, 14, 30); // local-time constructor: deterministic regardless of the running machine's timezone

// Every string value planted in the fixture that a `varying-value` or `extra-field` fault turns on,
// read from the manifest itself so this test cannot drift from the fixture it protects.
function plantedValues(): string[] {
  const values = new Set<string>();
  const collect = (entry: Record<string, unknown>) => {
    if (typeof entry.otherFiles === "string") values.add(entry.otherFiles);
    if (entry.values && typeof entry.values === "object") {
      for (const v of Object.values(entry.values as Record<string, unknown>)) {
        if (typeof v === "string") values.add(v);
      }
    }
  };
  for (const entry of manifest.seriesFindings as Record<string, unknown>[]) collect(entry);
  for (const entry of manifest.consequencesOfMisfiledSlice as Record<string, unknown>[]) collect(entry);
  values.add(manifest.studyInstanceUid);
  for (const s of manifest.series) values.add(s.seriesInstanceUid);
  return [...values].filter((v) => v.length > 3);
}

describe("the privacy assertion — the important one", () => {
  it("the default report contains none of the manifest's planted identifying values", () => {
    const markdown = buildMarkdownReport(reportInput({ includeValues: false }), FIXED_NOW);
    const json = buildJsonReport(reportInput({ includeValues: false }), FIXED_NOW);

    const leaked = plantedValues().filter((value) => markdown.includes(value) || json.includes(value));
    expect(
      leaked,
      "A value planted in the fixture appears in the default report. The default report must name fields and say where they are, never reproduce their contents - that is what makes it safe to send to someone else.",
    ).toEqual([]);
  });
});

describe("the opt-in", () => {
  it("values appear, and the warning line is present immediately under the heading, before anything else", () => {
    const markdown = buildMarkdownReport(reportInput({ includeValues: true }), FIXED_NOW);
    const leaked = plantedValues().filter((value) => markdown.includes(value));
    expect(leaked.length).toBeGreaterThan(0);

    const lines = markdown.split("\n");
    expect(lines[0]).toBe("# ScanLint report");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("This report contains identifying information copied from the file. Handle it as you would the file itself.");
  });

  it("the warning is absent by default", () => {
    const markdown = buildMarkdownReport(reportInput({ includeValues: false }), FIXED_NOW);
    expect(markdown).not.toContain("Handle it as you would the file itself.");
  });
});

describe("caveats", () => {
  it("appear in every report, opt-in or not", () => {
    for (const includeValues of [false, true]) {
      const markdown = buildMarkdownReport(reportInput({ includeValues }), FIXED_NOW);
      expect(markdown).toContain("ScanLint reads metadata.");
      expect(markdown).toContain("Flagging is not anonymising.");
      const json = JSON.parse(buildJsonReport(reportInput({ includeValues }), FIXED_NOW));
      expect(json.caveats.join(" ")).toContain("Flagging is not anonymising.");
    }
  });
});

describe("varying-value fields", () => {
  it("reports a distinct-value count and no values by default", () => {
    const markdown = buildMarkdownReport(reportInput({ includeValues: false }), FIXED_NOW);
    const patientIdSection = markdown.split("### Patient ID")[1]?.split("###")[0] ?? "";
    expect(patientIdSection).toContain("Distinct values: 2");
    expect(patientIdSection).not.toContain("SCANLINT-MISFILED-0005");
    expect(patientIdSection).not.toContain("SCANLINT-TEST-0001");
  });
});

describe("snapshot", () => {
  it("the full Markdown report for the fixture, with a fixed timestamp", () => {
    const markdown = buildMarkdownReport(reportInput({ includeValues: false }), FIXED_NOW);
    expect(markdown).toMatchSnapshot();
  });
});

describe("JSON", () => {
  it("parses, and round-trips the counts, series and findings", () => {
    const json = JSON.parse(buildJsonReport(reportInput(), FIXED_NOW));
    expect(json.headline.filesRead).toBe(fixtureReport.totalRead);
    expect(json.headline.seriesCount).toBe(fixtureReport.seriesCount);
    expect(json.headline.identifyingFieldCount).toBe(fixtureReport.aggregatedFields.length);
    expect(json.series).toHaveLength(fixtureReport.seriesCount);
    expect(json.notConsistent.length + json.structural.length).toBe(fixtureFindings.length);
  });

  it("never truncates file lists, unlike the Markdown report - a script needs the real list", () => {
    const manyFiles = Array.from({ length: 40 }, (_, i) => `f${i}`);
    const input = reportInput({
      findings: [{ kind: "duplicate-position", scope: "series", seriesInstanceUid: manifest.series[0].seriesInstanceUid, files: manyFiles }],
    });
    const json = JSON.parse(buildJsonReport(input, FIXED_NOW));
    expect(json.structural[0].files).toHaveLength(40);
  });

  it("gives a folder-scope mixed-modality finding no files, by design, and a per-modality count instead", () => {
    const input = reportInput({
      findings: [{ kind: "mixed-modality", scope: "folder", modalities: { CT: ["a", "b"], MR: ["c"] } }],
    });
    const json = JSON.parse(buildJsonReport(input, FIXED_NOW));
    expect(json.structural[0].files).toEqual([]);
    expect(json.structural[0].text).toBe("This folder holds more than one kind of scan — CT (2 files), MR (1 file)");
  });
});

describe("filenames", () => {
  it("slugifies a folder name: lowercase, non-alphanumerics to hyphens, collapsed", () => {
    expect(slugify("My Study #1 (2024)")).toBe("my-study-1-2024");
    expect(slugify("already-clean")).toBe("already-clean");
  });

  it("is correct for a named folder", () => {
    expect(reportFilename("My Series", "md", FIXED_NOW)).toBe("scanlint-my-series-2026-01-15.md");
    expect(reportFilename("My Series", "json", FIXED_NOW)).toBe("scanlint-my-series-2026-01-15.json");
  });

  it("falls back to 'files' when the folder name is unavailable", () => {
    expect(reportFilename(undefined, "md", FIXED_NOW)).toBe("scanlint-files-2026-01-15.md");
  });
});

describe("truncation, shared with the screen", () => {
  it("a finding affecting 40 files lists five and 'and 35 more' in the Markdown report", () => {
    const manyFiles = Array.from({ length: 40 }, (_, i) => `IM_${String(i + 1).padStart(4, "0")}`);
    const input = reportInput({
      findings: [{ kind: "duplicate-position", scope: "series", seriesInstanceUid: manifest.series[0].seriesInstanceUid, files: manyFiles }],
    });
    const markdown = buildMarkdownReport(input, FIXED_NOW);
    expect(markdown).toContain("IM_0001, IM_0002, IM_0003, IM_0004, IM_0005, and 35 more");
  });
});

describe("the generator never reads the clock", () => {
  it("produces identical output for the same injected timestamp across calls", () => {
    const a = buildMarkdownReport(reportInput(), FIXED_NOW);
    const b = buildMarkdownReport(reportInput(), FIXED_NOW);
    expect(a).toBe(b);
    const aJson = buildJsonReport(reportInput(), FIXED_NOW);
    const bJson = buildJsonReport(reportInput(), FIXED_NOW);
    expect(aJson).toBe(bJson);
  });

  it("produces different output for a different injected timestamp - proving the timestamp is actually used, not ignored", () => {
    const a = buildMarkdownReport(reportInput(), FIXED_NOW);
    const b = buildMarkdownReport(reportInput(), new Date(2027, 5, 1, 9, 0));
    expect(a).not.toBe(b);
  });
});

describe("failed files", () => {
  it("lists each with its message, and reads 'None.' when there are none", () => {
    const withFailures = buildMarkdownReport(reportInput({ failedFiles: [{ name: "bad.dcm", message: "buffer overrun" }] }), FIXED_NOW);
    expect(withFailures).toContain("bad.dcm: buffer overrun");

    const withoutFailures = buildMarkdownReport(reportInput({ failedFiles: [] }), FIXED_NOW);
    const section = withoutFailures.split("## Failed files")[1];
    expect(section.trim().startsWith("(0)")).toBe(true);
    expect(section).toContain("None.");
  });
});

describe("ungrouped files", () => {
  it("is never omitted, even when there are none", () => {
    const markdown = buildMarkdownReport(reportInput(), FIXED_NOW);
    expect(markdown).toContain("## Ungrouped files (0)");
    expect(markdown.split("## Ungrouped files")[1].split("##")[0]).toContain("None.");
  });
});

describe("2.6a: six corrections", () => {
  it("1. burned-in annotation is reported in the Summary, with the Stage 1 caveat, before the Identifying fields section", () => {
    const markdown = buildMarkdownReport(reportInput(), FIXED_NOW);
    const summarySection = markdown.split("## Summary")[1].split("## Identifying fields")[0];
    expect(summarySection).toContain("All 15 files declare burned-in annotation: YES");
    expect(summarySection).toContain("ScanLint reports what this field says. It cannot see text printed into the image itself.");
  });

  it("2. mixed-modality: series scope lists only the minority file(s); folder scope lists none", () => {
    const markdown = buildMarkdownReport(reportInput(), FIXED_NOW);
    expect(markdown).toContain("This series contains 1 file from a different kind of scan — MR among CT\n  IM_0001");
    expect(markdown).toContain("This folder holds more than one kind of scan — MR (11 files), CT (4 files)");
    // The folder-scope line has no file-list line under it - the next thing after it is a blank line.
    const folderLineIndex = markdown.split("\n").findIndex((l) => l.includes("This folder holds more than one kind of scan"));
    expect(markdown.split("\n")[folderLineIndex + 1]).toBe("");
  });

  it("3. series-scoped findings are grouped under their own series heading; folder-scoped under 'Whole folder'", () => {
    const markdown = buildMarkdownReport(reportInput(), FIXED_NOW);
    const notConsistentSection = markdown.split("## Not consistent across files")[1].split("## Structural")[0];
    expect(notConsistentSection).toContain("### Series 1");
    expect(notConsistentSection).toContain("### Series 2");
    const structuralSection = markdown.split("## Structural inconsistencies")[1].split("## Series (")[0];
    expect(structuralSection).toContain("### Series 1");
    expect(structuralSection).toContain("### Series 2");
    expect(structuralSection).toContain("### Whole folder");
  });

  it("4. the two Referring Physician's Name findings are distinguishable by canonical path, top-level included", () => {
    const markdown = buildMarkdownReport(reportInput(), FIXED_NOW);
    expect(markdown).toContain("Referring Physician's Name appears on 1 of 10 files only\n  IM_0011\n  `00080090`");
    expect(markdown).toContain("Referring Physician's Name appears on 1 of 10 files only\n  IM_0011\n  `04000561/0/04000550/0/00080090`");
  });

  it("5. no distinct-value count on an exempt tag (SOP Instance UID); counts stay for Series Description and Patient ID", () => {
    const markdown = buildMarkdownReport(reportInput(), FIXED_NOW);
    const sopSection = markdown.split("### SOP Instance UID")[1].split("###")[0];
    expect(sopSection).not.toContain("Distinct values");
    const mediaSopSection = markdown.split("### Media Storage SOP Instance UID")[1].split("###")[0];
    expect(mediaSopSection).not.toContain("Distinct values");
    const seriesDescSection = markdown.split("### Series Description")[1].split("###")[0];
    expect(seriesDescSection).toContain("Distinct values: 2");
    const patientIdSection = markdown.split("### Patient ID")[1].split("###")[0];
    expect(patientIdSection).toContain("Distinct values: 2");
  });

  it("6. a masked series description is omitted entirely by default, and shown under the opt-in", () => {
    const off = buildMarkdownReport(reportInput({ includeValues: false }), FIXED_NOW);
    expect(off).not.toContain("Description:");
    const on = buildMarkdownReport(reportInput({ includeValues: true }), FIXED_NOW);
    expect(on).toContain("Description: SYNTHETIC AXIAL MR SERIES");
    expect(on).toContain("Description: SYNTHETIC AXIAL CT SERIES");
  });
});
