// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { handleParse } from "../parse/handle";
import { groupAndOrder } from "../model/series";
import type { Grouping, ParsedInstance } from "../model/series";
import type { Orientation, Vector3 } from "../model/geometry";
import { checkSeries } from "../rules/series";
import type { SeriesFinding } from "../rules/series";
import { toParsedInstance } from "../lib/series-input";
import { buildSeriesReport } from "../lib/series-report";
import type { ParsedFile, SeriesReport } from "../lib/series-report";
import { SeriesBody, SeriesHeader } from "./series-result";

afterEach(cleanup);

const ROOT = path.resolve(__dirname, "../..");
const DIR = path.join(ROOT, "fixtures", "series");
type Manifest = { files: { file: string }[] };
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "series.manifest.json"), "utf8")) as Manifest;

function parseFixtureFile(name: string): { fileName: string; nodes: ParsedFile["nodes"]; findings: ParsedFile["findings"] } {
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

const NO_ANNOUNCE = () => {};

function renderBody(grouping: Grouping, findings: SeriesFinding[], parsed: Map<string, ParsedFile>, report: SeriesReport) {
  return render(<SeriesBody grouping={grouping} findings={findings} parsed={parsed} report={report} announce={NO_ANNOUNCE} />);
}

describe("against the fixture: headline counts", () => {
  it("reports the real counts, not any guessed ones", () => {
    // Section 4 guessed 15/29/4/7; the real numbers, computed by the same code the app runs, are
    // asserted here so a future change that quietly shifts them is caught.
    expect(fixtureReport.totalRead).toBe(15);
    expect(fixtureReport.seriesCount).toBe(2);
    expect(fixtureReport.notConsistentFindings).toHaveLength(4);
    expect(fixtureReport.structuralFindings).toHaveLength(7);
  });

  it("renders those counts in the header", () => {
    render(<SeriesHeader report={fixtureReport} skipFail={{ notDicom: 0, dicomdir: 0, failed: 0 }} />);
    expect(screen.getByText(`15 files read across 2 series`)).toBeTruthy();
    expect(screen.getByText(`${fixtureReport.aggregatedFields.length} fields could identify a patient`)).toBeTruthy();
    expect(screen.getByText("4 identifying fields are not the same on every file")).toBeTruthy();
    expect(screen.getByText("7 structural inconsistencies between files")).toBeTruthy();
  });

  it("shows the folder name when there is one, and a file count when there is none", () => {
    const { rerender } = render(<SeriesHeader folderName="my-study" report={fixtureReport} skipFail={{ notDicom: 0, dicomdir: 0, failed: 0 }} />);
    expect(screen.getByText("my-study")).toBeTruthy();
    rerender(<SeriesHeader report={fixtureReport} skipFail={{ notDicom: 0, dicomdir: 0, failed: 0 }} />);
    expect(screen.getByText("15 files")).toBeTruthy();
  });

  it("2.6a: reports burned-in annotation right after the four headline lines, with Stage 1's caveat", () => {
    render(<SeriesHeader report={fixtureReport} skipFail={{ notDicom: 0, dicomdir: 0, failed: 0 }} />);
    expect(screen.getByText("All 15 files declare burned-in annotation: YES")).toBeTruthy();
    expect(screen.getByText("ScanLint reports what this field says. It cannot see text printed into the image itself.")).toBeTruthy();
  });
});

describe("against the fixture: aggregated identifying fields", () => {
  it("a field present in every file reads 'in all 15 files'", () => {
    renderBody(fixtureGrouping, fixtureFindings, fixtureParsed, fixtureReport);
    expect(screen.getAllByText("in all 15 files").length).toBeGreaterThan(0);
  });

  it("ReferringPhysicianName reads 'in 1 of 15 files'", () => {
    renderBody(fixtureGrouping, fixtureFindings, fixtureParsed, fixtureReport);
    // Present at two depths (the top-level tag and the one nested in the sequence), so two rows.
    const rows = screen.getAllByText("Referring Physician's Name").map((el) => el.closest("li") as HTMLElement);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(within(row).getByText("in 1 of 15 files")).toBeTruthy();
  });

  it("PatientID shows '2 different values', expanding to both with their own file counts (the misfiled slice alone, and the other 14)", async () => {
    const user = userEvent.setup();
    renderBody(fixtureGrouping, fixtureFindings, fixtureParsed, fixtureReport);

    const patientId = screen.getByText("Patient ID").closest("li") as HTMLElement;
    const toggle = within(patientId).getByText("2 different values");
    await user.click(toggle);
    expect(within(patientId).getByText("in 1 file")).toBeTruthy();
    expect(within(patientId).getByText("in 14 files")).toBeTruthy();
  });

  it("masking holds across the aggregation, and revealing a row reveals it in the expansion", async () => {
    const user = userEvent.setup();
    renderBody(fixtureGrouping, fixtureFindings, fixtureParsed, fixtureReport);

    const patientId = screen.getByText("Patient ID").closest("li") as HTMLElement;
    await user.click(within(patientId).getByText("2 different values"));
    const revealButtons = within(patientId).getAllByRole("button", { name: /Reveal/ });
    expect(revealButtons.length).toBeGreaterThan(0);
    expect(within(patientId).getAllByLabelText("hidden value").length).toBe(revealButtons.length);

    await user.click(revealButtons[0]);
    expect(within(patientId).getAllByLabelText("hidden value").length).toBe(revealButtons.length - 1);
  });
});

describe("against the fixture: Not consistent list reads the same as the series block it echoes", () => {
  // A real bug, caught only by driving the built app in a browser: the folder-wide list defaulted
  // an extra-field's "of N files" to its own file count (1 of 1) instead of the series' instance
  // count (1 of 10), because it never looked the series up.
  it("an extra-field finding's total is the series' instance count, not the finding's own file count", () => {
    renderBody(fixtureGrouping, fixtureFindings, fixtureParsed, fixtureReport);
    const notConsistent = screen.getByText("Not consistent across files (4)").closest("details") as HTMLElement;
    const rows = within(notConsistent).getAllByText("Referring Physician's Name appears on 1 of 10 files only");
    expect(rows).toHaveLength(2); // the top-level tag and the one nested in the sequence
    expect(within(notConsistent).queryByText(/appears on 1 of 1 files only/)).toBeNull();
  });

  it("2.6a: the two findings are distinguishable by canonical path, the top-level one included", () => {
    renderBody(fixtureGrouping, fixtureFindings, fixtureParsed, fixtureReport);
    const notConsistent = screen.getByText("Not consistent across files (4)").closest("details") as HTMLElement;
    expect(within(notConsistent).getByText("00080090")).toBeTruthy();
    expect(within(notConsistent).getByText("04000561/0/04000550/0/00080090")).toBeTruthy();
  });
});

describe("against the fixture: sections", () => {
  it("Not consistent and Series are open by default; Identifying fields and Structural are collapsed", () => {
    renderBody(fixtureGrouping, fixtureFindings, fixtureParsed, fixtureReport);
    const detailsFor = (summaryText: string) => screen.getByText(summaryText, { exact: false }).closest("details") as HTMLDetailsElement;

    expect(detailsFor(`Identifying fields (${fixtureReport.aggregatedFields.length})`).open).toBe(false);
    expect(detailsFor("Not consistent across files (4)").open).toBe(true);
    expect(detailsFor("Structural inconsistencies (7)").open).toBe(false);
    expect(detailsFor("Series (2)").open).toBe(true);
  });

  it("a folder with no inconsistencies omits both inconsistency sections", () => {
    renderBody(fixtureGrouping, [], fixtureParsed, buildSeriesReport(fixtureGrouping, [], []));
    expect(screen.queryByText(/Not consistent across files/)).toBeNull();
    expect(screen.queryByText(/Structural inconsistencies/)).toBeNull();
  });

  it("truncates a finding's file list on screen, same as the report will", () => {
    const manyFiles = Array.from({ length: 40 }, (_, i) => `IM_${String(i + 1).padStart(4, "0")}`);
    const seriesUid = fixtureGrouping.studies[0].series[0].seriesInstanceUid!;
    const findings: SeriesFinding[] = [{ kind: "duplicate-position", scope: "series", seriesInstanceUid: seriesUid, files: manyFiles }];
    renderBody(fixtureGrouping, findings, fixtureParsed, buildSeriesReport(fixtureGrouping, findings, []));
    // Appears twice: once in the folder-wide "Structural inconsistencies" list, once inside the
    // series' own block - both must be truncated the same way.
    expect(screen.getAllByText(/, and \d+ more$/).length).toBeGreaterThan(0);
  });
});

describe("against the fixture: series blocks", () => {
  it("renders two series, in the grouping's own order, with their slice counts and modalities", () => {
    renderBody(fixtureGrouping, fixtureFindings, fixtureParsed, fixtureReport);
    const headings = screen.getAllByText(/^Series \d+ ·/).map((el) => el.textContent);
    expect(headings[0]).toContain("MR");
    expect(headings[0]).toContain("10 slices");
    expect(headings[1]).toContain("CT");
    expect(headings[1]).toContain("5 slices");
  });

  it("series A's spatial order disagrees with its own file-name order - the slice list follows the series' order, not the alphabet", () => {
    renderBody(fixtureGrouping, fixtureFindings, fixtureParsed, fixtureReport);
    const slicesDetails = screen.getAllByText(/^Slices \(/)[0].closest("details") as HTMLElement;
    const rows = within(slicesDetails).getAllByRole("listitem").map((li) => li.textContent ?? "");
    const seriesA = fixtureGrouping.studies[0].series[0];
    expect(rows.map((r) => seriesA.instances.find((i) => r.includes(i.fileName))?.fileName)).toEqual(seriesA.instances.map((i) => i.fileName));
    expect(rows.map((r) => r.match(/IM_\d{4}/)?.[0])).not.toEqual([...rows.map((r) => r.match(/IM_\d{4}/)?.[0])].sort());
  });
});

describe("ordering fallbacks, rendered", () => {
  const file = (overrides: Partial<ParsedInstance>): ParsedInstance => ({ fileName: "x", studyInstanceUid: "1", seriesInstanceUid: "1.1", ...overrides });

  it("renders 'Ordered by instance number — position data missing' when geometry is absent", () => {
    const files = [file({ fileName: "a", instanceNumber: 1 }), file({ fileName: "b", instanceNumber: 2 })];
    const grouping = groupAndOrder(files);
    const parsed = new Map(files.map((f) => [f.fileName, { nodes: [], findings: [] }]));
    renderBody(grouping, [], parsed, buildSeriesReport(grouping, [], []));
    expect(screen.getByText("Ordered by instance number — position data missing")).toBeTruthy();
  });

  it("renders 'Ordered by file name — no position or instance number' when neither is present", () => {
    const files = [file({ fileName: "b" }), file({ fileName: "a" })];
    const grouping = groupAndOrder(files);
    const parsed = new Map(files.map((f) => [f.fileName, { nodes: [], findings: [] }]));
    renderBody(grouping, [], parsed, buildSeriesReport(grouping, [], []));
    expect(screen.getByText("Ordered by file name — no position or instance number")).toBeTruthy();
  });

  it("states inconsistent orientation on the series it belongs to", () => {
    const axial: Orientation = [1, 0, 0, 0, 1, 0];
    const coronal: Orientation = [1, 0, 0, 0, 0, -1];
    const files: ParsedInstance[] = [
      file({ fileName: "a", instanceNumber: 1, imageOrientationPatient: axial, imagePositionPatient: [0, 0, 0] as Vector3 }),
      file({ fileName: "b", instanceNumber: 2, imageOrientationPatient: coronal, imagePositionPatient: [0, 0, 10] as Vector3 }),
    ];
    const grouping = groupAndOrder(files);
    const parsed = new Map(files.map((f) => [f.fileName, { nodes: [], findings: [] }]));
    const findings = checkSeries(grouping, parsed);
    renderBody(grouping, findings, parsed, buildSeriesReport(grouping, findings, []));
    // Appears twice by design: once in the folder-wide "Structural inconsistencies" list, and once
    // again inside the series' own block (section 7's explicit duplication).
    expect(screen.getAllByText("Slices in this series are not all in the same plane")).toHaveLength(2);
  });
});

describe("ungrouped", () => {
  it("renders each of the three reasons", () => {
    const files: ParsedInstance[] = [
      { fileName: "no-study", seriesInstanceUid: "1.1" },
      { fileName: "no-series", studyInstanceUid: "1" },
      { fileName: "neither" },
    ];
    const grouping = groupAndOrder(files);
    const parsed = new Map(files.map((f) => [f.fileName, { nodes: [], findings: [] }]));
    renderBody(grouping, [], parsed, buildSeriesReport(grouping, [], []));

    expect(screen.getByText("no study identifier")).toBeTruthy();
    expect(screen.getByText("no series identifier")).toBeTruthy();
    expect(screen.getByText("neither identifier")).toBeTruthy();
  });

  it("is never hidden, even when nothing else needs the reader's attention", () => {
    const files: ParsedInstance[] = [{ fileName: "orphan" }];
    const grouping = groupAndOrder(files);
    const parsed = new Map(files.map((f) => [f.fileName, { nodes: [], findings: [] }]));
    renderBody(grouping, [], parsed, buildSeriesReport(grouping, [], []));
    expect(screen.getByText("Ungrouped (1)")).toBeTruthy();
    expect(screen.getByText("orphan")).toBeTruthy();
  });
});

describe("drill-down", () => {
  async function openFirstSlice(user: ReturnType<typeof userEvent.setup>) {
    const slicesDetails = screen.getAllByText(/^Slices \(/)[0].closest("details") as HTMLElement;
    const firstRow = within(slicesDetails).getAllByRole("button")[0];
    const fileName = firstRow.textContent?.match(/IM_\d{4}/)?.[0] ?? "";
    await user.click(firstRow);
    return fileName;
  }

  it("opening a slice shows that file's own findings, not another's", async () => {
    const user = userEvent.setup();
    renderBody(fixtureGrouping, fixtureFindings, fixtureParsed, fixtureReport);
    const fileName = await openFirstSlice(user);

    expect(screen.getByRole("heading", { name: fileName })).toBeTruthy();
    const expectedCount = fixtureParsed.get(fileName)!.findings.filter((f) => f.kind !== "burned-in").length;
    expect(screen.getByText(new RegExp(`^${expectedCount} could identify a patient$`))).toBeTruthy();
  });

  it("hides the series content (not unmounting it) while a slice is open, and restores it on return, sections intact", async () => {
    const user = userEvent.setup();
    const { container } = renderBody(fixtureGrouping, fixtureFindings, fixtureParsed, fixtureReport);

    // Open "Identifying fields", which starts collapsed, before drilling in.
    const idField = screen.getByText(/^Identifying fields \(/).closest("details") as HTMLDetailsElement;
    await user.click(screen.getByText(/^Identifying fields \(/));
    expect(idField.open).toBe(true);

    await openFirstSlice(user);
    const hiddenWrapper = container.querySelector("[hidden]") as HTMLElement;
    expect(hiddenWrapper).not.toBeNull();
    expect(hiddenWrapper.contains(idField)).toBe(true);
    expect(idField.open).toBe(true); // never touched by hiding, since it was never unmounted

    await user.click(screen.getByRole("button", { name: /^Back to / }));
    expect(idField.open).toBe(true);
    expect(container.querySelector("[hidden]")).toBeNull();
  });

  it("moves focus to the slice's heading on open, and back to its row on return", async () => {
    const user = userEvent.setup();
    renderBody(fixtureGrouping, fixtureFindings, fixtureParsed, fixtureReport);

    const slicesDetails = screen.getAllByText(/^Slices \(/)[0].closest("details") as HTMLElement;
    const firstRow = within(slicesDetails).getAllByRole("button")[0];
    const fileName = firstRow.textContent?.match(/IM_\d{4}/)?.[0] ?? "";
    await user.click(firstRow);

    expect(document.activeElement).toBe(screen.getByRole("heading", { name: fileName }));

    await user.click(screen.getByRole("button", { name: /^Back to / }));
    expect(document.activeElement?.textContent).toContain(fileName);
  });
});
