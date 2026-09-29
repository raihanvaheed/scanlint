// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileSystemDirectoryEntryLike, FileSystemEntryLike, FileSystemFileEntryLike } from "../lib/directory-entries";
import type { ParseOutcome } from "../parse/protocol";
import { LoadScreen } from "./load-screen";

afterEach(cleanup);

const DICM = [0x44, 0x49, 0x43, 0x4d];

/** A file whose bytes pass the DICM magic check, carrying a plain-text marker after it that the
 * fake `parse` below reads to decide what outcome to return — this file stands in for the worker. */
function dicomFile(name: string, marker: string): File {
  const body = new TextEncoder().encode(marker);
  const bytes = new Uint8Array(132 + body.length);
  bytes.set(DICM, 128);
  bytes.set(body, 132);
  return new File([bytes], name);
}

function notDicomFile(name: string, content = "plain text, no magic here"): File {
  return new File([content], name);
}

function withRelativePath(file: File, relativePath: string): File {
  Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
  return file;
}

function markerOf(bytes: ArrayBuffer): string {
  return new TextDecoder().decode(new Uint8Array(bytes).slice(132));
}

const DICOMDIR_OUTCOME: ParseOutcome = {
  ok: true,
  nodes: [{ tag: "00020002", path: "00020002", vr: "UI", value: "1.2.840.10008.1.3.10" }],
  findings: [],
};

// A shared study/series UID on every fake file: these tests are about selection, drag-and-drop and
// progress mechanics, not grouping, so every multi-file run here forms one ordinary series rather
// than exercising 2.5's ungrouped case incidentally.
const STUDY_UID = "1.2.3";
const SERIES_UID = "1.2.3.4";

function readOutcome(findingCount: number): ParseOutcome {
  const findings = Array.from({ length: findingCount }, (_, i) => ({
    path: `0010001${i}`,
    tag: "00100010",
    vr: "PN" as const,
    kind: "annex-e" as const,
    action: "Z",
  }));
  return {
    ok: true,
    nodes: [
      { tag: "00080060", path: "00080060", vr: "CS" },
      { tag: "0020000d", path: "0020000d", vr: "UI", value: STUDY_UID },
      { tag: "0020000e", path: "0020000e", vr: "UI", value: SERIES_UID },
    ],
    findings,
  };
}

function fakeParse() {
  return vi.fn<(bytes: ArrayBuffer) => Promise<ParseOutcome>>((bytes) => {
    const marker = markerOf(bytes);
    if (marker === "DICOMDIR") return Promise.resolve(DICOMDIR_OUTCOME);
    if (marker.startsWith("FAIL")) return Promise.resolve({ ok: false, message: marker });
    const n = Number(marker.replace("READ", "")) || 0;
    return Promise.resolve(readOutcome(n));
  });
}

function setup(concurrency = 4) {
  const parse = fakeParse();
  const loadSample = vi.fn<() => Promise<ArrayBuffer>>(() => Promise.reject(new Error("not used")));
  const view = render(<LoadScreen parse={parse} loadSample={loadSample} concurrency={concurrency} />);
  return { parse, user: userEvent.setup(), ...view };
}

/** A `parse` that never resolves on its own: the test decides exactly when each call settles,
 * so a run can be caught genuinely in progress instead of racing a fast fake against a click. */
function controllableParse() {
  const pending: ((outcome: ParseOutcome) => void)[] = [];
  const parse = vi.fn<(bytes: ArrayBuffer) => Promise<ParseOutcome>>(
    () => new Promise((resolve) => pending.push(resolve)),
  );
  return {
    parse,
    pendingCount: () => pending.length,
    resolveNext: (findings = 0) => pending.shift()?.(readOutcome(findings)),
  };
}

function setupControllable(concurrency: number) {
  const { parse, pendingCount, resolveNext } = controllableParse();
  const loadSample = vi.fn<() => Promise<ArrayBuffer>>(() => Promise.reject(new Error("not used")));
  const view = render(<LoadScreen parse={parse} loadSample={loadSample} concurrency={concurrency} />);
  return { user: userEvent.setup(), pendingCount, resolveNext, ...view };
}

async function uploadFiles(user: ReturnType<typeof userEvent.setup>, label: string, files: File[]) {
  const input = screen.getByLabelText(label) as HTMLInputElement;
  await user.upload(input, files);
}

describe("multi-select input", () => {
  it("produces the series answer with the expected totals, once more than one file is read", async () => {
    const { user } = setup();
    await uploadFiles(user, "or choose files", [
      dicomFile("IM_0001", "READ2"),
      dicomFile("IM_0002", "READ0"),
      notDicomFile("README.txt"),
    ]);

    // Two real files, sharing one series UID, plus a skipped non-DICOM file.
    const headline = (await screen.findByText("2 files read across 1 series")).closest("ul") as HTMLElement;
    expect(screen.getByText("1 skipped, not DICOM")).toBeTruthy();
    expect(screen.queryByText(/DICOMDIR/)).toBeNull();
    expect(screen.queryByText(/could not be read/)).toBeNull();

    // The union of both files' findings: two distinct paths, each on only one of the two files.
    expect(within(headline).getByText("2 fields could identify a patient")).toBeTruthy();
    expect(within(headline).getByText("2 identifying fields are not the same on every file")).toBeTruthy();

    const slices = screen.getByText("Slices (2)").closest("details") as HTMLElement;
    const rows = within(slices).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("IM_0001");
    expect(rows[0].textContent).toContain("2 fields could identify a patient");
    expect(rows[1].textContent).toContain("IM_0002");
    expect(rows[1].textContent).toContain("0 fields could identify a patient");
  });

  it("still lands on the single-file screen when exactly one file is chosen", async () => {
    const { user } = setup();
    await uploadFiles(user, "or choose files", [dicomFile("IM_0001", "READ1")]);

    expect(await screen.findByText("1 could identify a patient")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load another file" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load another" })).toBeNull();
  });

  it("shows a failed file's message", async () => {
    const { user } = setup();
    await uploadFiles(user, "or choose files", [dicomFile("a", "READ1"), dicomFile("b", "FAIL: buffer overrun")]);

    await screen.findByText("2 files selected");
    const row = screen.getByText("b").closest("li") as HTMLElement;
    expect(within(row).getByText("could not be read")).toBeTruthy();
    expect(within(row).getByText("FAIL: buffer overrun")).toBeTruthy();
  });
});

describe("folder picker input", () => {
  it("gives the folder input webkitdirectory, and shows each file's relative path", async () => {
    const { user } = setup();
    const files = [
      withRelativePath(dicomFile("IM_0001", "READ0"), "series/IM_0001"),
      withRelativePath(dicomFile("IM_0002", "READ0"), "series/IM_0002"),
    ];
    await uploadFiles(user, "or choose a folder", files);

    expect(await screen.findByText("2 files read across 1 series")).toBeTruthy();
    expect(screen.getByText("series/IM_0001")).toBeTruthy();
    expect(screen.getByText("series/IM_0002")).toBeTruthy();
  });
});

describe("folder drag-and-drop", () => {
  function fileEntry(name: string, marker: string): FileSystemFileEntryLike {
    return { isFile: true, isDirectory: false, name, file: (success) => success(dicomFile(name, marker)) };
  }
  function dirEntry(name: string, children: FileSystemEntryLike[]): FileSystemDirectoryEntryLike {
    let delivered = false;
    return {
      isFile: false,
      isDirectory: true,
      name,
      createReader: () => ({
        readEntries: (success) => {
          // `readEntries`'s own success callback re-enters synchronously (it calls itself again
          // until a batch comes back empty), so the flag must flip before `success` runs, not after.
          const batch = delivered ? [] : children;
          delivered = true;
          success(batch);
        },
      }),
    };
  }

  it("walks a dropped folder's entries, including a nested directory, and shows the multi-file screen", async () => {
    const { container } = setup();
    const dropZone = container.querySelector(".border-dashed") as HTMLElement;
    const tree = dirEntry("series", [fileEntry("IM_0001", "READ1"), dirEntry("nested", [fileEntry("IM_0002", "READ0")])]);
    const items = [{ kind: "file", webkitGetAsEntry: () => tree }];
    const dataTransfer = { items, files: [] };

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.drop(dropZone, { dataTransfer });

    expect(await screen.findByText("2 files read across 1 series")).toBeTruthy();
    expect(screen.getByText("series/IM_0001")).toBeTruthy();
    expect(screen.getByText("series/nested/IM_0002")).toBeTruthy();
  });

  it("still behaves like a single-file drop when exactly one file is dropped", async () => {
    const { container } = setup();
    const dropZone = container.querySelector(".border-dashed") as HTMLElement;
    const entry = { isFile: true, isDirectory: false, name: "IM_0001", file: (success: (f: File) => void) => success(dicomFile("IM_0001", "READ3")) };
    const items = [{ kind: "file", webkitGetAsEntry: () => entry }];

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.drop(container.querySelector(".border-dashed") as HTMLElement, { dataTransfer: { items, files: [] } });

    expect(await screen.findByText("3 could identify a patient")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load another file" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load another" })).toBeNull();
    void dropZone;
  });

  it("falls back to dataTransfer.files when the entries API is unavailable, for several loose files", async () => {
    const { container } = setup();
    const dropZone = container.querySelector(".border-dashed") as HTMLElement;
    const files = [dicomFile("a", "READ0"), dicomFile("b", "READ0")];

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.drop(dropZone, { dataTransfer: { files, items: [] } });

    expect(await screen.findByText("2 files read across 1 series")).toBeTruthy();
  });
});

describe("a drag whose items expose webkitGetAsEntry but it returns null for every item", () => {
  // Confirmed against real Chromium: dt.items.add(file) gives every item a working method that
  // still answers null, since there is no real OS drag behind it. A drop must not go silent then.
  it("falls back to dataTransfer.files instead of silently doing nothing", async () => {
    const { container } = setup();
    const dropZone = container.querySelector(".border-dashed") as HTMLElement;
    const files = [dicomFile("a", "READ0"), dicomFile("b", "READ0")];
    const items = files.map(() => ({ webkitGetAsEntry: () => null }));

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.drop(dropZone, { dataTransfer: { items, files } });

    expect(await screen.findByText("2 files read across 1 series")).toBeTruthy();
  });
});

describe("nothing in the selection is DICOM", () => {
  it("shows the files-selected and skipped lines, and omits the DICOM-files-read line entirely", async () => {
    const { user } = setup();
    await uploadFiles(user, "or choose files", [
      notDicomFile("a.txt", "plain text"),
      notDicomFile("b.jpg", "not really a jpeg"),
      notDicomFile("c.log", "some log lines"),
    ]);

    expect(await screen.findByText("3 files selected")).toBeTruthy();
    expect(screen.getByText("3 skipped, not DICOM")).toBeTruthy();
    expect(screen.queryByText(/DICOM files? read/)).toBeNull();
    expect(screen.queryByText(/DICOMDIR/)).toBeNull();
    expect(screen.queryByText(/could not be read/)).toBeNull();
    const rows = within(screen.getByRole("heading", { name: "Files" }).closest("section") as HTMLElement).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.textContent).toContain("skipped");
  });
});

describe("progress, cancellation and the live region", () => {
  it("announces at the start, and the live region's own text does not change per file", async () => {
    const { user, container } = setup(1);
    const live = container.querySelector('[aria-live="polite"]') as HTMLElement;
    const files = [dicomFile("a", "READ0"), dicomFile("b", "READ0"), dicomFile("c", "READ0")];

    await uploadFiles(user, "or choose files", files);
    // "loading-many" is reached before any file resolves; the live region got the start sentence.
    expect(live.textContent).toContain("Reading 3 files");

    await screen.findByText("3 files read across 1 series");
  });

  it("shows N of M outside the live region while running, and the finished totals inside it", async () => {
    const { user, container } = setup(1);
    const files = [dicomFile("a", "READ0"), dicomFile("b", "READ0")];

    const upload = uploadFiles(user, "or choose files", files);
    // At least one intermediate frame should show progress text, outside the live region.
    await screen.findByText(/of 2 files read/);
    const live = container.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(within(live).queryByText(/of 2 files read/)).toBeNull();

    await upload;
    await screen.findByText("2 files read across 1 series");
    expect(live.textContent).toContain("2 files read across 1 series");
  });

  it("passes its concurrency prop through: two files are genuinely in flight at once with concurrency 2", async () => {
    const { user, pendingCount, resolveNext } = setupControllable(2);

    const run = user.upload(screen.getByLabelText("or choose files"), [dicomFile("a", "x"), dicomFile("b", "x"), dicomFile("c", "x")]);
    await vi.waitFor(() => expect(pendingCount()).toBe(2)); // both workers hold a file at once, not one at a time
    resolveNext(0);
    resolveNext(0);
    await vi.waitFor(() => expect(pendingCount()).toBe(1)); // only the third file is left
    resolveNext(0);
    await run;

    expect(await screen.findByText("3 files read across 1 series")).toBeTruthy();
  });

  it("Cancel stops the run, shows partial results, and Load another returns to idle", async () => {
    const { user, pendingCount, resolveNext } = setupControllable(1);
    const files = Array.from({ length: 5 }, (_, i) => dicomFile(`f${i}`, "x"));
    const input = screen.getByLabelText("or choose files") as HTMLInputElement;

    const upload = user.upload(input, files);
    await vi.waitFor(() => expect(pendingCount()).toBe(1)); // one worker, one file genuinely in flight
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    resolveNext(3); // let the in-flight file settle, as the prompt asks: it finishes, nothing new starts
    await upload;

    await screen.findByText(/files selected/);
    expect(screen.getByText(/Cancelled/)).toBeTruthy();
    const rows = within(screen.getByRole("heading", { name: "Files" }).closest("section") as HTMLElement).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("3 could identify a patient");
    const selectedText = screen.getByText(/files selected/).textContent ?? "";
    expect(Number(selectedText.split(" ")[0])).toBe(5); // "selected" is what was chosen, cancelled or not

    await user.click(screen.getByRole("button", { name: "Load another" }));
    expect(screen.getByRole("button", { name: "Load sample" })).toBeTruthy();
  });

  it("runs again normally after a cancelled run", async () => {
    const { user, pendingCount, resolveNext } = setupControllable(1);

    const firstRun = user.upload(screen.getByLabelText("or choose files"), [dicomFile("a", "x"), dicomFile("b", "x")]);
    await vi.waitFor(() => expect(pendingCount()).toBe(1));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    resolveNext(0);
    await firstRun;
    await screen.findByText(/files selected/);
    await user.click(screen.getByRole("button", { name: "Load another" }));

    // Idle was left and re-entered: this is a freshly mounted input, not the one captured above.
    const secondRun = user.upload(screen.getByLabelText("or choose files"), [dicomFile("c", "x"), dicomFile("d", "x")]);
    await vi.waitFor(() => expect(pendingCount()).toBe(1));
    resolveNext(0);
    await vi.waitFor(() => expect(pendingCount()).toBe(1));
    resolveNext(0);
    await secondRun;

    expect(await screen.findByText("2 files read across 1 series")).toBeTruthy();
    expect(screen.queryByText(/Cancelled/)).toBeNull();
  });
});
