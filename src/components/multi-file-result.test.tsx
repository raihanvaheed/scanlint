// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FileResult } from "../lib/parse-many";
import type { Finding } from "../model/types";
import { MultiFileList, MultiFileTotals, summariseMany } from "./multi-file-result";

afterEach(cleanup);

// One synthetic identifying finding per count: findings are read via a full ParseOutcome now, not a
// bare number, but every test here only ever needs the count `identifyingFindings` would report.
function findingsOfCount(n: number): Finding[] {
  return Array.from({ length: n }, (_, i) => ({ path: `path-${i}`, tag: "00100010", vr: "PN", kind: "annex-e" }));
}

const read = (findings: number): FileResult => ({ name: "a", outcome: { kind: "read", nodes: [], findings: findingsOfCount(findings) } });
const skipped = (reason: "not-dicom" | "dicomdir"): FileResult => ({ name: "a", outcome: { kind: "skipped", reason } });
const failed = (message: string): FileResult => ({ name: "a", outcome: { kind: "failed", message } });

describe("summariseMany", () => {
  it("counts each outcome into its own bucket, from the prompt's own example", () => {
    const results = [...Array(15).fill(0).map(() => read(0)), ...Array(3).fill(0).map(() => skipped("not-dicom")), skipped("dicomdir")];
    expect(summariseMany(results, 19)).toEqual({ selected: 19, read: 15, notDicom: 3, dicomdir: 1, failed: 0 });
  });

  it("counts a failure separately from both skip reasons", () => {
    expect(summariseMany([read(1), skipped("not-dicom"), skipped("dicomdir"), failed("x")], 4)).toEqual({
      selected: 4,
      read: 1,
      notDicom: 1,
      dicomdir: 1,
      failed: 1,
    });
  });
});

describe("MultiFileTotals", () => {
  it("renders the prompt's own example, one line per non-zero count", () => {
    render(<MultiFileTotals totals={{ selected: 19, read: 15, notDicom: 3, dicomdir: 1, failed: 0 }} cancelled={false} />);

    expect(screen.getByText("19 files selected")).toBeTruthy();
    expect(screen.getByText("15 DICOM files read")).toBeTruthy();
    expect(screen.getByText("3 skipped, not DICOM")).toBeTruthy();
    expect(screen.getByText("1 skipped, a DICOMDIR")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("omits a line whose count is zero, including every optional line at once", () => {
    render(<MultiFileTotals totals={{ selected: 1, read: 1, notDicom: 0, dicomdir: 0, failed: 0 }} cancelled={false} />);

    expect(screen.getByText("1 file selected")).toBeTruthy();
    expect(screen.getByText("1 DICOM file read")).toBeTruthy();
    expect(screen.queryByText(/skipped/)).toBeNull();
    expect(screen.queryByText(/could not be read/)).toBeNull();
  });

  it("omits the whole list when every optional count is zero", () => {
    render(<MultiFileTotals totals={{ selected: 0, read: 0, notDicom: 0, dicomdir: 0, failed: 0 }} cancelled={false} />);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("shows a cancelled note only when cancelled", () => {
    const totals = { selected: 5, read: 2, notDicom: 0, dicomdir: 0, failed: 0 };
    render(<MultiFileTotals totals={totals} cancelled />);
    expect(screen.getByText(/Cancelled/)).toBeTruthy();

    cleanup();
    render(<MultiFileTotals totals={totals} cancelled={false} />);
    expect(screen.queryByText(/Cancelled/)).toBeNull();
  });
});

describe("MultiFileList", () => {
  it("shows one row per file, in the given order, with its relative path when there is one", () => {
    const results: FileResult[] = [
      { name: "IM_0001", relativePath: "A/IM_0001", outcome: { kind: "read", nodes: [], findings: findingsOfCount(12) } },
      { name: "README.txt", outcome: { kind: "skipped", reason: "not-dicom" } },
    ];
    render(<MultiFileList results={results} />);

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("A/IM_0001");
    expect(rows[0].textContent).toContain("12 could identify a patient");
    expect(rows[1].textContent).toContain("README.txt");
    expect(rows[1].textContent).toContain("skipped");
  });

  it("shows the failure message, smaller and in --shade, beneath the status", () => {
    render(<MultiFileList results={[{ name: "bad.dcm", outcome: { kind: "failed", message: "buffer overrun" } }]} />);

    const row = screen.getByRole("listitem");
    expect(row.textContent).toContain("could not be read");
    const message = screen.getByText("buffer overrun");
    expect(message.className).toContain("text-shade");
    expect(message.className).toContain("text-sm");
  });
});
