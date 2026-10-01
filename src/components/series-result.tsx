"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { Ref } from "react";
import { headlineLines, seriesNumberOf } from "../lib/series-report";
import type { ParsedFile, SeriesReport } from "../lib/series-report";
import type { AggregatedField } from "../lib/series-aggregate";
import { formatFileList, plural, wordFinding } from "../lib/series-wording";
import { formatTag } from "../model/tag";
import { identifyingFindings } from "../model/tree";
import type { Finding } from "../model/types";
import type { Grouping, Instance, OrderedBy, Series } from "../model/series";
import type { DecodeOptions, DecodeOutcome } from "../pixels/protocol";
import type { SeriesFinding } from "../rules/series";
import { Reason } from "./findings-list";
import { FieldValue, useReveal } from "./field-value";
import type { Reveal } from "./field-value";
import { FOCUS_RING, FOCUS_RING_WITHIN } from "./focus";
import { BURNED_IN_CAVEAT, SingleFileResult } from "./single-file-result";

/** Re-reads one file's bytes, fresh, for the pixel path - keyed by name, the same key `parsed`
 * already uses. Defined here too (not imported from load-screen.tsx) to avoid a circular import;
 * it is a plain type alias, not worth a shared module of its own. */
type BytesByName = Map<string, () => Promise<ArrayBuffer>>;

/** Files this run didn't end up reading as part of any series - still worth a line each, exactly as
 * 2.2's flat-list totals said, so replacing that list with the series answer never silently drops
 * what happened to a skipped or failed file. Not part of section 4's four given lines: added below
 * them, never in place of one. */
export type SkipFailTotals = { notDicom: number; dicomdir: number; failed: number };

/** The headline: the part of the series view the top-level flow puts inside its live region, so a
 * batch finishing is announced without every field and finding being read aloud with it - the same
 * split, for the same reason, as `SingleFileHeader`/`SingleFileDetails`. */
export function SeriesHeader({
  folderName,
  report,
  skipFail,
  headingRef,
}: {
  folderName?: string;
  report: SeriesReport;
  skipFail: SkipFailTotals;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <div>
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="break-all rounded text-lg font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal"
      >
        {folderName ?? plural(report.totalRead, "file")}
      </h2>
      <ul className="mt-4 space-y-1 text-2xl font-semibold text-ink">
        {headlineLines(report).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="mt-4 text-ink">{report.burnedIn}</p>
      <p className="mt-1 text-sm text-shade">{BURNED_IN_CAVEAT}</p>
      {(skipFail.notDicom > 0 || skipFail.dicomdir > 0 || skipFail.failed > 0) && (
        <ul className="mt-4 space-y-2 text-ink">
          {skipFail.notDicom > 0 && <li>{`${skipFail.notDicom} skipped, not DICOM`}</li>}
          {skipFail.dicomdir > 0 && <li>{`${skipFail.dicomdir} skipped, a DICOMDIR`}</li>}
          {skipFail.failed > 0 && <li>{`${skipFail.failed} could not be read`}</li>}
        </ul>
      )}
    </div>
  );
}

function orderedBySentence(orderedBy: OrderedBy): string {
  if (orderedBy === "position") return "Ordered by position";
  if (orderedBy === "instance-number") return "Ordered by instance number — position data missing";
  return "Ordered by file name — no position or instance number";
}

const UNGROUPED_REASON_TEXT: Record<string, string> = {
  "missing-study": "no study identifier",
  "missing-series": "no series identifier",
  "missing-both": "neither identifier",
};

function InconsistencyRow({ finding, totalInSeries }: { finding: SeriesFinding; totalInSeries?: number }) {
  const { text, files, path } = wordFinding(finding, { totalInSeries });
  return (
    <li className="py-3">
      <p className="text-ink">{text}</p>
      {files.length > 0 && <p className="mt-1 text-sm text-shade">{formatFileList(files)}</p>}
      {/* Shown for every finding that carries one, nested or not: a top-level path is just the tag
          itself, which disambiguates two same-named findings with no special case for depth. */}
      {path !== undefined && <p className="break-all font-mono text-xs text-shade">{path}</p>}
    </li>
  );
}

function IdentifyingFieldRow({ field, reveal }: { field: AggregatedField; reveal: Reveal }) {
  const label = field.name ?? formatTag(field.tag);
  const presence = field.presentIn === field.total ? `in all ${field.total} files` : `in ${field.presentIn} of ${field.total} files`;
  const reasonFinding: Finding = { path: field.path, tag: field.tag, vr: field.values[0]?.vr ?? "", kind: field.kind, action: field.action };

  return (
    <li className="py-3">
      <p className="break-words text-lg font-semibold text-ink">{label}</p>
      {field.name !== undefined && <p className="font-mono text-sm text-shade">{formatTag(field.tag)}</p>}
      {field.path.includes("/") && <p className="break-all font-mono text-xs text-shade">{field.path}</p>}
      <p className="mt-1 text-sm text-shade">{presence}</p>
      {field.values.length === 1 ? (
        <p className="mt-1">
          <FieldValue
            name={label}
            value={field.values[0].value}
            vr={field.values[0].vr}
            length={field.values[0].length}
            flagged
            revealed={reveal.revealed.has(field.path)}
            onToggle={() => reveal.toggle(field.path, label)}
          />
        </p>
      ) : (
        <details className="group mt-1">
          <summary className={`cursor-pointer text-ink underline underline-offset-4 ${FOCUS_RING}`}>{`${field.values.length} different values`}</summary>
          <ul className="mt-2 space-y-2 pl-4">
            {field.values.map((v, i) => {
              const key = `${field.path}#${i}`;
              return (
                <li key={key}>
                  <FieldValue name={label} value={v.value} vr={v.vr} length={v.length} flagged revealed={reveal.revealed.has(key)} onToggle={() => reveal.toggle(key, label)} />
                  <span className="ml-3 text-sm text-shade">{`in ${plural(v.files.length, "file")}`}</span>
                </li>
              );
            })}
          </ul>
        </details>
      )}
      <p className="mt-1 text-sm">
        <Reason finding={reasonFinding} />
      </p>
    </li>
  );
}

function SliceRow({
  instance,
  findingCount,
  onOpen,
  rowRef,
}: {
  instance: Instance;
  findingCount: number;
  onOpen: () => void;
  rowRef: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <li>
      <button
        type="button"
        ref={rowRef}
        onClick={onOpen}
        className={`flex w-full cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 rounded py-2 text-left hover:text-signal ${FOCUS_RING}`}
      >
        <span className="break-all text-ink">{instance.relativePath ?? instance.fileName}</span>
        {instance.distance !== undefined && <span className="text-sm text-shade">{`${instance.distance.toFixed(1)} mm`}</span>}
        {instance.instanceNumber !== undefined && <span className="text-sm text-shade">{`instance ${instance.instanceNumber}`}</span>}
        <span className="text-sm text-shade">{`${plural(findingCount, "field")} could identify a patient`}</span>
      </button>
    </li>
  );
}

function SeriesBlock({
  series,
  ordinal,
  findings,
  parsed,
  reveal,
  onOpenSlice,
  registerRow,
}: {
  series: Series;
  /** 1-based position in the series list. Used only when the file itself carries no SeriesNumber
   * (0020,0011) - a SeriesInstanceUID is a UID, not a short label, so it is never shown as one. */
  ordinal: number;
  findings: SeriesFinding[];
  parsed: Map<string, ParsedFile>;
  reveal: Reveal;
  onOpenSlice: (fileName: string, displayName: string, label: string, instances: Instance[]) => void;
  registerRow: (fileName: string, el: HTMLButtonElement | null) => void;
}) {
  const fileNames = series.instances.map((i) => i.fileName);
  const seriesInconsistencies = findings.filter((f) => f.seriesInstanceUid === series.seriesInstanceUid);
  const number = seriesNumberOf(fileNames, parsed) ?? String(ordinal);
  const label = `Series ${number}`;
  const descriptionKey = `series:${series.seriesInstanceUid}:description`;
  const descriptionNode = series.description !== undefined ? fileNames.map((f) => parsed.get(f)?.nodes.find((n) => n.tag === "0008103e")).find((n) => n !== undefined) : undefined;

  return (
    <details className="group border-t-2 border-rule py-4 first:border-t-0" open>
      <summary className={`cursor-pointer list-none rounded [&::-webkit-details-marker]:hidden ${FOCUS_RING}`}>
        <span className="text-lg font-semibold text-ink">
          {label} · {series.modality ?? "unknown modality"} · {plural(series.instances.length, "slice")}
        </span>
      </summary>
      <div className="mt-2 pl-1">
        <p className="text-sm text-shade">{orderedBySentence(series.orderedBy)}</p>
        {series.description !== undefined && (
          <p className="mt-1">
            <FieldValue
              name="Series description"
              value={series.description}
              vr={descriptionNode?.vr ?? "LO"}
              flagged
              revealed={reveal.revealed.has(descriptionKey)}
              onToggle={() => reveal.toggle(descriptionKey, "Series description")}
            />
          </p>
        )}

        {seriesInconsistencies.length > 0 && (
          <ul className="mt-3 divide-y divide-rule">
            {seriesInconsistencies.map((finding, i) => (
              <InconsistencyRow key={i} finding={finding} totalInSeries={series.instances.length} />
            ))}
          </ul>
        )}

        <details className="group mt-3">
          <summary className={`cursor-pointer list-none rounded text-ink [&::-webkit-details-marker]:hidden ${FOCUS_RING}`}>
            {`Slices (${series.instances.length})`}
          </summary>
          <ul className="mt-2 divide-y divide-rule pl-1">
            {series.instances.map((instance) => (
              <SliceRow
                key={instance.fileName}
                instance={instance}
                findingCount={identifyingFindings(parsed.get(instance.fileName)?.findings ?? []).length}
                onOpen={() => onOpenSlice(instance.fileName, instance.relativePath ?? instance.fileName, label, series.instances)}
                rowRef={(el) => registerRow(instance.fileName, el)}
              />
            ))}
          </ul>
        </details>
      </div>
    </details>
  );
}

function UngroupedBlock({ instances }: { instances: Instance[] }) {
  if (instances.length === 0) return null;
  return (
    <section className="mt-10 border-t-2 border-signal pt-5">
      <h3 className="text-xl font-semibold text-ink">{`Ungrouped (${instances.length})`}</h3>
      <p className="mt-1 text-sm text-shade">Could not be placed in a series.</p>
      <ul className="mt-4 divide-y divide-rule">
        {instances.map((instance) => (
          <li key={instance.fileName} className="py-3">
            <p className="break-all text-ink">{instance.fileName}</p>
            <p className="text-sm text-shade">{UNGROUPED_REASON_TEXT[instance.ungroupedReason ?? "missing-both"]}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** `instances` is the opened slice's own series, in 2.3's geometric order (never filename order) -
 * kept alongside so stepping can move through it without re-deriving which series it came from. */
type OpenSlice = { fileName: string; displayName: string; label: string; instances: Instance[] };

/**
 * The series view's body: the reveal-all control and the four sections, kept mounted (hidden, not
 * unmounted) while a slice is drilled into, so every `<details>` section's open state and the
 * page's scroll position are exactly as the reader left them on return.
 */
export function SeriesBody({
  grouping,
  findings,
  parsed,
  report,
  announce,
  getBytesByName,
  decodePixels,
}: {
  grouping: Grouping;
  findings: SeriesFinding[];
  parsed: Map<string, ParsedFile>;
  report: SeriesReport;
  announce: (message: string) => void;
  getBytesByName: BytesByName;
  decodePixels: (bytes: ArrayBuffer, options?: DecodeOptions) => Promise<DecodeOutcome>;
}) {
  const [openSlice, setOpenSlice] = useState<OpenSlice | null>(null);
  const scrollPosition = useRef(0);
  const returningTo = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const drillHeadingRef = useRef<HTMLHeadingElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);

  // extra-field's wording needs the series' own instance count, not just how many files have the
  // field - looked up once here so the folder-wide "Not consistent" list reads the same as the
  // identical finding does inside its own series block, rather than defaulting to its own file count.
  const seriesTotals = new Map(grouping.studies.flatMap((study) => study.series).map((series) => [series.seriesInstanceUid, series.instances.length]));

  const syntheticFindings: Finding[] = report.aggregatedFields.flatMap((field) =>
    field.values.length === 1
      ? [{ path: field.path, tag: field.tag, name: field.name, kind: field.kind, vr: field.values[0].vr, value: field.values[0].value, length: field.values[0].length }]
      : field.values.map((v, i) => ({ path: `${field.path}#${i}`, tag: field.tag, name: field.name, kind: field.kind, vr: v.vr, value: v.value, length: v.length })),
  );
  for (const study of grouping.studies) {
    for (const series of study.series) {
      if (series.description !== undefined) {
        syntheticFindings.push({ path: `series:${series.seriesInstanceUid}:description`, tag: "0008103e", kind: "annex-e", vr: "LO", value: series.description });
      }
    }
  }
  const reveal = useReveal(syntheticFindings, announce);

  function registerRow(fileName: string, el: HTMLButtonElement | null) {
    if (el) rowRefs.current.set(fileName, el);
    else rowRefs.current.delete(fileName);
  }

  function openSliceRow(fileName: string, displayName: string, label: string, instances: Instance[]) {
    scrollPosition.current = window.scrollY;
    setOpenSlice({ fileName, displayName, label, instances });
  }

  function goBack() {
    returningTo.current = openSlice?.fileName ?? null;
    setOpenSlice(null);
  }

  // Section 6: geometric order (2.3's own), never filename order - `instances` already is that
  // order, so stepping is just walking it.
  function stepTo(index: number) {
    if (!openSlice) return;
    const target = openSlice.instances[index];
    if (!target) return;
    setOpenSlice({ ...openSlice, fileName: target.fileName, displayName: target.relativePath ?? target.fileName });
  }

  useLayoutEffect(() => {
    if (openSlice) {
      drillHeadingRef.current?.focus();
    } else if (returningTo.current) {
      const fileName = returningTo.current;
      returningTo.current = null;
      window.scrollTo(0, scrollPosition.current);
      rowRefs.current.get(fileName)?.focus();
    }
  }, [openSlice]);

  const openFile = openSlice ? parsed.get(openSlice.fileName) : undefined;
  const openIndex = openSlice ? openSlice.instances.findIndex((i) => i.fileName === openSlice.fileName) : -1;

  return (
    <div>
      <div hidden={openSlice !== null}>
        {reveal.hasMaskable && (
          <button
            type="button"
            onClick={reveal.toggleAll}
            className={`mt-2 cursor-pointer rounded-md border-2 border-shade px-4 py-1.5 text-ink hover:border-signal ${FOCUS_RING}`}
          >
            {reveal.allRevealed ? "Hide all" : "Reveal all"}
          </button>
        )}

        {report.aggregatedFields.length > 0 && (
          <details className="group mt-8 border-t-2 border-signal pt-5">
            <summary className={`cursor-pointer list-none rounded [&::-webkit-details-marker]:hidden ${FOCUS_RING}`}>
              <span className="text-xl font-semibold text-ink">{`Identifying fields (${report.aggregatedFields.length})`}</span>
            </summary>
            <ul className="mt-4 divide-y divide-rule">
              {report.aggregatedFields.map((field) => (
                <IdentifyingFieldRow key={field.path} field={field} reveal={reveal} />
              ))}
            </ul>
          </details>
        )}

        {report.notConsistentFindings.length > 0 && (
          <details className="group mt-8 border-t-2 border-signal pt-5" open>
            <summary className={`cursor-pointer list-none rounded [&::-webkit-details-marker]:hidden ${FOCUS_RING}`}>
              <span className="text-xl font-semibold text-ink">{`Not consistent across files (${report.notConsistentFindings.length})`}</span>
            </summary>
            <ul className="mt-4 divide-y divide-rule">
              {report.notConsistentFindings.map((finding, i) => (
                <InconsistencyRow key={i} finding={finding} totalInSeries={seriesTotals.get(finding.seriesInstanceUid ?? "")} />
              ))}
            </ul>
          </details>
        )}

        {report.structuralFindings.length > 0 && (
          <details className="group mt-8 border-t-2 border-signal pt-5">
            <summary className={`cursor-pointer list-none rounded [&::-webkit-details-marker]:hidden ${FOCUS_RING}`}>
              <span className="text-xl font-semibold text-ink">{`Structural inconsistencies (${report.structuralFindings.length})`}</span>
            </summary>
            <ul className="mt-4 divide-y divide-rule">
              {report.structuralFindings.map((finding, i) => (
                <InconsistencyRow key={i} finding={finding} totalInSeries={seriesTotals.get(finding.seriesInstanceUid ?? "")} />
              ))}
            </ul>
          </details>
        )}

        <details className="group mt-8 border-t-2 border-signal pt-5" open>
          <summary className={`cursor-pointer list-none rounded [&::-webkit-details-marker]:hidden ${FOCUS_RING}`}>
            <span className="text-xl font-semibold text-ink">{`Series (${report.seriesCount})`}</span>
          </summary>
          <div className="mt-2">
            {grouping.studies
              .flatMap((study) => study.series)
              .map((series, index) => (
                <SeriesBlock
                  key={series.seriesInstanceUid}
                  series={series}
                  ordinal={index + 1}
                  findings={findings}
                  parsed={parsed}
                  reveal={reveal}
                  onOpenSlice={openSliceRow}
                  registerRow={registerRow}
                />
              ))}
          </div>
        </details>

        <UngroupedBlock instances={grouping.ungrouped} />
      </div>

      {openSlice && openFile && (
        <div className="mt-8 border-t-2 border-signal pt-5">
          <button
            ref={backButtonRef}
            type="button"
            onClick={goBack}
            className={`cursor-pointer rounded text-ink underline underline-offset-4 ${FOCUS_RING_WITHIN}`}
          >
            {`Back to ${openSlice.label}`}
          </button>
          <div className="mt-6">
            <SingleFileResult
              name={openSlice.displayName}
              nodes={openFile.nodes}
              findings={openFile.findings}
              announce={announce}
              headingRef={drillHeadingRef}
              image={{
                fileKey: openSlice.fileName,
                getBytes: getBytesByName.get(openSlice.fileName) ?? (() => Promise.reject(new Error(`No bytes available for ${openSlice.fileName}`))),
                decode: decodePixels,
                stepping: {
                  label: `Slice ${openIndex + 1} of ${openSlice.instances.length}`,
                  hasPrevious: openIndex > 0,
                  hasNext: openIndex >= 0 && openIndex < openSlice.instances.length - 1,
                  onPrevious: () => stepTo(openIndex - 1),
                  onNext: () => stepTo(openIndex + 1),
                },
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
