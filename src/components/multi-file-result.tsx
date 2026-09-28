import type { Ref } from "react";
import type { FileResult } from "../lib/parse-many";

export type MultiTotals = { selected: number; read: number; notDicom: number; dicomdir: number; failed: number };

export function summariseMany(results: FileResult[], selected: number): MultiTotals {
  const totals: MultiTotals = { selected, read: 0, notDicom: 0, dicomdir: 0, failed: 0 };
  for (const { outcome } of results) {
    if (outcome.kind === "read") totals.read += 1;
    else if (outcome.kind === "skipped" && outcome.reason === "not-dicom") totals.notDicom += 1;
    else if (outcome.kind === "skipped") totals.dicomdir += 1;
    else totals.failed += 1;
  }
  return totals;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function MultiFileTotals({
  totals,
  cancelled,
  headingRef,
}: {
  totals: MultiTotals;
  cancelled: boolean;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const lines = [
    totals.read > 0 && `${plural(totals.read, "DICOM file")} read`,
    totals.notDicom > 0 && `${totals.notDicom} skipped, not DICOM`,
    totals.dicomdir > 0 && `${totals.dicomdir} skipped, a DICOMDIR`,
    totals.failed > 0 && `${totals.failed} could not be read`,
  ].filter((line): line is string => line !== false);

  return (
    <div>
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="rounded text-2xl font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal"
      >
        {plural(totals.selected, "file")} selected
      </h2>
      {lines.length > 0 && (
        <ul className="mt-4 space-y-2 text-ink">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {cancelled && <p className="mt-4 text-ink">Cancelled: showing the files read before then.</p>}
    </div>
  );
}

function FileRow({ result }: { result: FileResult }) {
  const path = result.relativePath ?? result.name;
  const status =
    result.outcome.kind === "read"
      ? `${result.outcome.findings} could identify a patient`
      : result.outcome.kind === "skipped"
        ? "skipped"
        : "could not be read";

  return (
    <li className="py-3">
      <p className="break-all text-ink">{path}</p>
      <p className="text-sm text-shade">{status}</p>
      {result.outcome.kind === "failed" && <p className="mt-0.5 break-words text-sm text-shade">{result.outcome.message}</p>}
    </li>
  );
}

export function MultiFileList({ results }: { results: FileResult[] }) {
  return (
    <section className="mt-10 border-t-2 border-signal pt-5">
      <h2 className="text-xl font-semibold text-ink">Files</h2>
      <ul className="mt-4 divide-y divide-rule">
        {results.map((result, index) => (
          // Selection order can repeat a filename (the same name in two folders), so the index,
          // not the name, is the identity React needs here.
          <FileRow key={index} result={result} />
        ))}
      </ul>
    </section>
  );
}
