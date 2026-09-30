"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { collectEntries, extractEntries } from "../lib/directory-entries";
import { parseMany } from "../lib/parse-many";
import type { FileResult, FileSource } from "../lib/parse-many";
import type { FailedFile } from "../lib/report";
import { deriveFolderName } from "../lib/series-aggregate";
import { toParsedInstance } from "../lib/series-input";
import { buildSeriesReport } from "../lib/series-report";
import type { ParsedFile, SeriesReport } from "../lib/series-report";
import type { Grouping } from "../model/series";
import { groupAndOrder } from "../model/series";
import type { Finding, TagNode } from "../model/types";
import type { ParseOutcome } from "../parse/protocol";
import type { DecodeOptions, DecodeOutcome } from "../pixels/protocol";
import { checkSeries } from "../rules/series";
import type { SeriesFinding } from "../rules/series";
import { FOCUS_RING, FOCUS_RING_WITHIN } from "./focus";
import { MultiFileList, MultiFileTotals, summariseMany } from "./multi-file-result";
import { ReportControls } from "./report-controls";
import { SeriesBody, SeriesHeader } from "./series-result";
import { SingleFileDetails, SingleFileHeader } from "./single-file-result";

type LoadScreenProps = {
  parse: (bytes: ArrayBuffer) => Promise<ParseOutcome>;
  loadSample: () => Promise<ArrayBuffer>;
  /** How many files may be read and parsed at once. Pass the pool's own worker count, so a
   * folder's files are never all read into memory ahead of the workers that will handle them. */
  concurrency: number;
  /** Decodes one file's pixels. Never called until a preview is opened - see ImagePreview. */
  decodePixels: (bytes: ArrayBuffer, options?: DecodeOptions) => Promise<DecodeOutcome>;
};

type PickedFile = { file: File; relativePath?: string };

/** Re-reads one file's bytes, fresh, for the pixel path - independent of (and never reusing) the
 * bytes already transferred away into the metadata parser. Keyed by name, the same key `parsed`
 * already uses. */
type BytesByName = Map<string, () => Promise<ArrayBuffer>>;

/** Built only when more than one file was actually read as DICOM - the series answer replaces the
 * flat list exactly then, per section 3; zero or one real file keeps the plain list from 2.2. */
type SeriesData = {
  folderName?: string;
  grouping: Grouping;
  findings: SeriesFinding[];
  parsed: Map<string, ParsedFile>;
  report: SeriesReport;
  failedFiles: FailedFile[];
  getBytesByName: BytesByName;
};

type View =
  | { kind: "idle" }
  | { kind: "loading"; name: string }
  | { kind: "loaded"; name: string; nodes: TagNode[]; findings: Finding[]; getBytes: () => Promise<ArrayBuffer> }
  | { kind: "error"; headline: string; detail: string }
  | { kind: "loading-many"; done: number; total: number }
  | { kind: "loaded-many"; selected: number; results: FileResult[]; cancelled: boolean; series?: SeriesData };

function buildSeriesData(results: FileResult[], getBytesByName: BytesByName): SeriesData {
  const read = results.filter((r): r is FileResult & { outcome: { kind: "read"; nodes: TagNode[]; findings: Finding[] } } => r.outcome.kind === "read");
  const parsed = new Map(read.map((r) => [r.name, { nodes: r.outcome.nodes, findings: r.outcome.findings }]));
  const instances = read.map((r) => toParsedInstance(r.name, r.relativePath, r.outcome.nodes));
  const grouping = groupAndOrder(instances);
  const findings = checkSeries(grouping, parsed);
  const report = buildSeriesReport(grouping, findings, read.map((r) => ({ fileName: r.name, findings: r.outcome.findings })));
  const folderName = deriveFolderName(results);
  const failedFiles: FailedFile[] = results
    .filter((r): r is FileResult & { outcome: { kind: "failed"; message: string } } => r.outcome.kind === "failed")
    .map((r) => ({ name: r.relativePath ?? r.name, message: r.outcome.message }));
  return folderName === undefined
    ? { grouping, findings, parsed, report, failedFiles, getBytesByName }
    : { folderName, grouping, findings, parsed, report, failedFiles, getBytesByName };
}

const SAMPLE_NAME = "single.dcm";

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function LoadScreen({ parse, loadSample, concurrency, decodePixels }: LoadScreenProps) {
  const [view, setView] = useState<View>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const sampleButton = useRef<HTMLButtonElement>(null);
  const anotherButton = useRef<HTMLButtonElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  const previousKind = useRef(view.kind);

  // webkitdirectory has no JSX prop: it is a non-standard, lowercase HTML attribute, set
  // imperatively instead. The input only exists while idle, so this must re-run on every return
  // to idle, not just once — an empty dependency array would miss every input after the first.
  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  });

  useEffect(() => {
    if (previousKind.current !== view.kind) {
      if (view.kind === "idle") sampleButton.current?.focus();
      // The result is long, so focus goes to its top. The button is at the bottom, after every row.
      if (view.kind === "loaded" || view.kind === "loaded-many") resultHeading.current?.focus();
      if (view.kind === "error") anotherButton.current?.focus();
    }
    previousKind.current = view.kind;
  }, [view.kind]);

  // The buffer is transferred to the worker by `parse` and must not be used afterwards.
  async function analyse(name: string, readBytes: () => Promise<ArrayBuffer>, readFailure: string) {
    setAnnouncement("");
    setView({ kind: "loading", name });

    let bytes: ArrayBuffer;
    try {
      bytes = await readBytes();
    } catch (e) {
      setView({ kind: "error", headline: readFailure, detail: messageOf(e) });
      return;
    }

    try {
      const outcome = await parse(bytes);
      setView(
        outcome.ok
          ? { kind: "loaded", name, nodes: outcome.nodes, findings: outcome.findings, getBytes: readBytes }
          : { kind: "error", headline: "This file could not be read as DICOM.", detail: outcome.message },
      );
    } catch (e) {
      setView({ kind: "error", headline: "Something went wrong while reading this file.", detail: messageOf(e) });
    }
  }

  function readFile(file: File) {
    void analyse(file.name, () => file.arrayBuffer(), "This file could not be read.");
  }

  // One file, through any of the three inputs or a drop, is still the single-file flow above.
  // Only two or more files bring up the multi-file screen.
  async function handleFiles(picked: PickedFile[]) {
    if (picked.length === 0) return;
    if (picked.length === 1) {
      readFile(picked[0].file);
      return;
    }

    cancelledRef.current = false;
    setAnnouncement(`Reading ${picked.length} files…`);
    setView({ kind: "loading-many", done: 0, total: picked.length });

    const sources: FileSource[] = picked.map(({ file, relativePath }) => ({
      name: file.name,
      relativePath,
      peek: () => file.slice(0, 132).arrayBuffer(),
      read: () => file.arrayBuffer(),
    }));

    const results = await parseMany(sources, {
      concurrency,
      parse,
      onResult: () => {
        setView((v) => (v.kind === "loading-many" ? { ...v, done: v.done + 1 } : v));
      },
      isCancelled: () => cancelledRef.current,
    });

    // Keyed by name, the same key `parsed` uses - a fresh read each time, independent of the bytes
    // already transferred away into the metadata parser above.
    const getBytesByName: BytesByName = new Map(picked.map(({ file }) => [file.name, () => file.arrayBuffer()]));

    const readCount = results.filter((r) => r.outcome.kind === "read").length;
    setView({
      kind: "loaded-many",
      selected: picked.length,
      results,
      cancelled: cancelledRef.current,
      series: readCount > 1 ? buildSeriesData(results, getBytesByName) : undefined,
    });
  }

  function cancelMany() {
    cancelledRef.current = true;
  }

  function onChoose(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files) return;
    void handleFiles(
      Array.from(files, (file) => ({
        file,
        relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || undefined,
      })),
    );
    event.target.value = "";
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);

    // DataTransferItemList is only valid synchronously, inside this handler: entries are
    // extracted here, before any await, and walked afterwards.
    const items = event.dataTransfer.items;
    const canWalk = items && items.length > 0 && typeof (items[0] as unknown as { webkitGetAsEntry?: unknown }).webkitGetAsEntry === "function";
    const entries = canWalk ? extractEntries(items) : [];
    // webkitGetAsEntry exists on every item yet can still return null for one, so a drag with
    // the method present is not guaranteed to yield any entry: fall back to the plain file list
    // whenever the walk would otherwise hand back nothing.
    const files = Array.from(event.dataTransfer.files);

    if (entries.length > 0) {
      void collectEntries(entries).then((collected) => handleFiles(collected.map(({ file, relativePath }) => ({ file, relativePath }))));
    } else {
      void handleFiles(files.map((file) => ({ file })));
    }
  }

  return (
    <main className="mx-auto max-w-160 px-6 py-16 sm:py-24">
      <header>
        <h1 className="text-[2.5rem] font-bold text-ink">ScanLint</h1>
        <div className="mt-3 h-0.75 w-16 bg-signal" />
        <p className="mt-5 text-xl text-ink">Find identifying information hidden in medical image files.</p>
      </header>

      <div className="mt-10">
        {view.kind === "idle" && (
          <div
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={`flex flex-col items-center rounded-lg border-2 border-dashed px-6 py-10 text-center ${
              dragging ? "border-signal bg-paper" : "border-shade bg-surface"
            }`}
          >
            <p className="text-xl text-ink">Drop a DICOM file here</p>
            <label className={`mt-2 cursor-pointer rounded text-ink underline underline-offset-4 ${FOCUS_RING_WITHIN}`}>
              or choose files
              <input type="file" multiple onChange={onChoose} className="sr-only" />
            </label>
            <label className={`mt-2 cursor-pointer rounded text-ink underline underline-offset-4 ${FOCUS_RING_WITHIN}`}>
              or choose a folder
              <input ref={folderInput} type="file" multiple onChange={onChoose} className="sr-only" />
            </label>
            <button
              ref={sampleButton}
              type="button"
              onClick={() => void analyse(SAMPLE_NAME, loadSample, "The sample file could not be loaded.")}
              className={`mt-8 cursor-pointer rounded-md border-2 border-transparent bg-signal px-[30px] py-2.5 text-lg font-semibold text-paper hover:brightness-110 ${FOCUS_RING}`}
            >
              Load sample
            </button>
          </div>
        )}

        <div aria-live="polite" role="status">
          {/* Always present, so an explicit announcement (start, or a multi-file completion) fires
              the moment it is set, whatever view is on screen at the time. */}
          <p className="sr-only">{announcement}</p>

          {view.kind === "loading" && (
            <div>
              <p className="text-ink">
                Reading <span className="font-semibold">{view.name}</span>…
              </p>
              <div aria-hidden="true" className="mt-4 h-1 w-full overflow-hidden rounded bg-rule">
                <div className="h-full w-1/3 bg-signal motion-safe:animate-pulse" />
              </div>
            </div>
          )}

          {view.kind === "loaded" && (
            <SingleFileHeader name={view.name} nodes={view.nodes} findings={view.findings} headingRef={resultHeading} />
          )}

          {view.kind === "error" && (
            <div>
              <p className="text-xl text-ink">{view.headline}</p>
              <p className="mt-2 break-words text-sm text-shade">{view.detail}</p>
            </div>
          )}

          {view.kind === "loaded-many" &&
            (view.series ? (
              <SeriesHeader
                folderName={view.series.folderName}
                report={view.series.report}
                skipFail={summariseMany(view.results, view.selected)}
                headingRef={resultHeading}
              />
            ) : (
              <MultiFileTotals totals={summariseMany(view.results, view.selected)} cancelled={view.cancelled} headingRef={resultHeading} />
            ))}
        </div>

        {/* Outside the live region: a bar redrawn on every file would be announced every time,
            which is exactly the per-file spam section 8 rules out. */}
        {view.kind === "loading-many" && (
          <div>
            <p className="text-ink">{`${view.done} of ${view.total} files read…`}</p>
            <div aria-hidden="true" className="mt-4 h-1 w-full overflow-hidden rounded bg-rule">
              <div
                className="h-full bg-signal motion-safe:transition-[width]"
                style={{ width: `${view.total === 0 ? 0 : Math.round((view.done / view.total) * 100)}%` }}
              />
            </div>
            <button
              type="button"
              onClick={cancelMany}
              className={`mt-4 cursor-pointer rounded-md border-2 border-shade px-5 py-2 text-ink hover:border-signal ${FOCUS_RING}`}
            >
              Cancel
            </button>
          </div>
        )}

        {view.kind === "loaded" && (
          <SingleFileDetails
            name={view.name}
            nodes={view.nodes}
            findings={view.findings}
            announce={setAnnouncement}
            image={{ fileKey: view.name, getBytes: view.getBytes, decode: decodePixels }}
          />
        )}

        {view.kind === "loaded-many" &&
          (view.series ? (
            <SeriesBody
              grouping={view.series.grouping}
              findings={view.series.findings}
              parsed={view.series.parsed}
              report={view.series.report}
              announce={setAnnouncement}
              getBytesByName={view.series.getBytesByName}
              decodePixels={decodePixels}
            />
          ) : (
            <MultiFileList results={view.results} />
          ))}

        {view.kind === "loaded-many" && view.series && (
          <ReportControls
            folderName={view.series.folderName}
            totals={summariseMany(view.results, view.selected)}
            grouping={view.series.grouping}
            findings={view.series.findings}
            parsed={view.series.parsed}
            report={view.series.report}
            failedFiles={view.series.failedFiles}
          />
        )}

        {(view.kind === "loaded" || view.kind === "error" || view.kind === "loaded-many") && (
          <button
            ref={anotherButton}
            type="button"
            onClick={() => setView({ kind: "idle" })}
            className={`mt-8 cursor-pointer rounded-md border-2 border-shade px-5 py-2 text-ink hover:border-signal ${FOCUS_RING}`}
          >
            {view.kind === "loaded-many" ? "Load another" : "Load another file"}
          </button>
        )}
      </div>

      <p className="mt-6 text-sm text-shade">Files are read in your browser. Nothing is uploaded.</p>
    </main>
  );
}
