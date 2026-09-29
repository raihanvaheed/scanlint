"use client";

import { useId, useState } from "react";
import type { Grouping } from "../model/series";
import { buildJsonReport, buildMarkdownReport, reportFilename } from "../lib/report";
import type { FailedFile, ReportTotals } from "../lib/report";
import type { ParsedFile, SeriesReport } from "../lib/series-report";
import type { SeriesFinding } from "../rules/series";
import { FOCUS_RING } from "./focus";

export type ReportControlsProps = {
  folderName?: string;
  totals: ReportTotals;
  grouping: Grouping;
  findings: SeriesFinding[];
  parsed: Map<string, ParsedFile>;
  report: SeriesReport;
  failedFiles: FailedFile[];
};

// Nothing is uploaded: a Blob and an anchor's `download` attribute both stay inside the browser.
// `URL.createObjectURL` is not a network API, so this needs no change to the network invariant's
// allowlist.
function download(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * The report download controls: beside "Load another", never on the single-file view (one file's
 * answer is readable on screen; a folder's is not). The checkbox governs both formats, and its
 * state is read at the moment of download, not cached - unchecking it before a second download
 * must produce a report without values, with no stale state left over from the first.
 */
export function ReportControls({ folderName, totals, grouping, findings, parsed, report, failedFiles }: ReportControlsProps) {
  const [includeValues, setIncludeValues] = useState(false);
  const checkboxId = useId();

  function handleDownload(format: "md" | "json") {
    const now = new Date();
    const input = { folderName, totals, grouping, findings, parsed, report, failedFiles, includeValues };
    const content = format === "md" ? buildMarkdownReport(input, now) : buildJsonReport(input, now);
    const mimeType = format === "md" ? "text/markdown" : "application/json";
    download(reportFilename(folderName, format, now), content, mimeType);
  }

  return (
    <div className="mt-8 border-t-2 border-signal pt-5">
      <label htmlFor={checkboxId} className="flex w-fit cursor-pointer items-center gap-2 rounded text-ink">
        <input
          id={checkboxId}
          type="checkbox"
          checked={includeValues}
          onChange={(event) => setIncludeValues(event.target.checked)}
          className={`h-4 w-4 cursor-pointer accent-signal ${FOCUS_RING}`}
        />
        Include field values
      </label>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => handleDownload("md")}
          className={`cursor-pointer rounded-md border-2 border-shade px-5 py-2 text-ink hover:border-signal ${FOCUS_RING}`}
        >
          Download report
        </button>
        <button
          type="button"
          onClick={() => handleDownload("json")}
          className={`cursor-pointer rounded-md border-2 border-shade px-5 py-2 text-ink hover:border-signal ${FOCUS_RING}`}
        >
          Download JSON
        </button>
      </div>
    </div>
  );
}
