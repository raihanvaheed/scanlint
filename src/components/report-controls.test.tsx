// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Grouping } from "../model/series";
import { ReportControls } from "./report-controls";

afterEach(cleanup);

const grouping: Grouping = {
  studies: [{ studyInstanceUid: "1", series: [{ seriesInstanceUid: "1.1", modality: "MR", orderedBy: "position", orientationConsistent: true, instances: [] }] }],
  ungrouped: [],
};
const report = { totalRead: 1, seriesCount: 1, aggregatedFields: [], notConsistentFindings: [], structuralFindings: [], burnedIn: "No file declares burned-in annotation." };

function setup(overrides: Partial<Parameters<typeof ReportControls>[0]> = {}) {
  const props = {
    folderName: "my-study",
    totals: { selected: 1, read: 1, notDicom: 0, dicomdir: 0, failed: 0 },
    grouping,
    findings: [],
    parsed: new Map(),
    report,
    failedFiles: [],
    ...overrides,
  };
  return { user: userEvent.setup(), ...render(<ReportControls {...props} />) };
}

// happy-dom doesn't implement a real download; the Blob passed to `createObjectURL` is kept and
// its own text() read back (a Blob's content is only available asynchronously) to see exactly what
// would have been written to disk, and the anchor's `download` attribute is read before it's removed.
function captureDownload() {
  const captured: { filename?: string; blob?: Blob; mimeType?: string } = {};
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    captured.mimeType = blob.type;
    captured.blob = blob;
    return "blob:mock";
  });
  URL.revokeObjectURL = vi.fn();
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    captured.filename = this.download;
  };
  return {
    captured,
    content: () => captured.blob!.text(),
    restore: () => {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevoke;
      HTMLAnchorElement.prototype.click = originalClick;
    },
  };
}

describe("the checkbox", () => {
  it("is unchecked by default, and properly labelled", () => {
    setup();
    const checkbox = screen.getByLabelText("Include field values") as HTMLInputElement;
    expect(checkbox.type).toBe("checkbox");
    expect(checkbox.checked).toBe(false);
  });

  it("toggles on click", async () => {
    const { user } = setup();
    const checkbox = screen.getByLabelText("Include field values") as HTMLInputElement;
    await user.click(checkbox);
    expect(checkbox.checked).toBe(true);
  });

  // A visible checkbox (unlike the sr-only file inputs elsewhere) shows its own focus ring, so it
  // needs the signal-coloured one directly - relying on the wrapping label alone left the browser's
  // default blue ring showing instead, caught only by focusing it in a real browser.
  it("carries its own visible --signal focus ring, not just the label's", () => {
    setup();
    const checkbox = screen.getByLabelText("Include field values");
    expect(checkbox.className).toContain("outline-signal");
  });
});

describe("downloads", () => {
  let capture: ReturnType<typeof captureDownload>;
  beforeEach(() => {
    capture = captureDownload();
  });
  afterEach(() => capture.restore());

  it("Download report produces Markdown, without values, when the checkbox is unchecked", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Download report" }));
    expect(capture.captured.mimeType).toBe("text/markdown");
    expect(capture.captured.filename).toMatch(/^scanlint-my-study-\d{4}-\d{2}-\d{2}\.md$/);
    const content = await capture.content();
    expect(content).toContain("# ScanLint report");
    expect(content).not.toContain("Handle it as you would the file itself.");
  });

  it("Download JSON produces JSON with the same filename stem", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Download JSON" }));
    expect(capture.captured.mimeType).toBe("application/json");
    expect(capture.captured.filename).toMatch(/^scanlint-my-study-\d{4}-\d{2}-\d{2}\.json$/);
    const content = await capture.content();
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("checking the box includes the warning line in the next download", async () => {
    const { user } = setup();
    await user.click(screen.getByLabelText("Include field values"));
    await user.click(screen.getByRole("button", { name: "Download report" }));
    expect(await capture.content()).toContain("Handle it as you would the file itself.");
  });

  it("unchecking the box again produces a report without values - the checkbox state is read fresh each time, not cached from the first download", async () => {
    const { user } = setup();
    const checkbox = screen.getByLabelText("Include field values");
    await user.click(checkbox); // on
    await user.click(screen.getByRole("button", { name: "Download report" }));
    expect(await capture.content()).toContain("Handle it as you would the file itself.");

    await user.click(checkbox); // off again
    await user.click(screen.getByRole("button", { name: "Download report" }));
    expect(await capture.content()).not.toContain("Handle it as you would the file itself.");
  });

  it("falls back to 'files' in the filename when there is no folder name", async () => {
    const { user } = setup({ folderName: undefined });
    await user.click(screen.getByRole("button", { name: "Download report" }));
    expect(capture.captured.filename).toMatch(/^scanlint-files-\d{4}-\d{2}-\d{2}\.md$/);
  });
});
