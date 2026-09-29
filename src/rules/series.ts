import { normalizeTag } from "../model/tag";
import { identifyingFindings } from "../model/tree";
import type { Finding, TagNode } from "../model/types";
import type { Grouping, Series } from "../model/series";

export type SeriesFindingKind =
  | "position-gap"
  | "duplicate-position"
  | "inconsistent-pixel-spacing"
  | "inconsistent-orientation"
  | "inconsistent-identifier"
  | "mixed-modality"
  | "varying-value"
  | "extra-field";

/**
 * One series-level (or folder-level) consistency finding. A single flat type with mostly-optional
 * fields, the same pattern `Instance`/`Finding` already use elsewhere: only the fields a given
 * `kind` needs are ever set, the rest omitted.
 */
export type SeriesFinding = {
  kind: SeriesFindingKind;
  scope: "folder" | "study" | "series";
  seriesInstanceUid?: string;
  files?: string[];
  tag?: string;
  path?: string;
  values?: Record<string, string>;
  otherFiles?: string;
  expectedMm?: number;
  actualMm?: number;
  expectedSpacing?: [number, number];
  spacingValues?: Record<string, [number, number]>;
  modalities?: Record<string, string[]>;
};

/** One file's parsed tree and the findings the PHI rules engine already classified on it. */
export type ParsedFile = { nodes: TagNode[]; findings: Finding[] };

const POSITION_TOLERANCE_MM = 0.01;
const PIXEL_SPACING_TOLERANCE_MM = 1e-4;

const MODALITY_TAG = normalizeTag("00080060");
const PIXEL_SPACING_TAG = normalizeTag("00280030");

// Tags that vary from slice to slice by design (instance identity, per-slice timestamps, per-slice
// geometry) and would flood a "value varies across the series" report with noise a reader can't act
// on. This is a judgement call, not something derivable from the rules engine, and it stays short on
// purpose: SeriesDescription and PatientID are deliberately not here, since both are meant to be
// caught when they vary.
//
// 00020003 (MediaStorageSOPInstanceUID) is added to the step's own list: it is the file-meta
// group's copy of the same per-instance identity SOPInstanceUID (00080018) already carries, varies
// on every slice by the same design, and floods both fixture series with UID noise if left in - a
// deviation from the literal list, flagged here and in the PR description rather than made silently.
const VALUE_EXEMPT_TAGS = new Set(
  ["00080018", "00080013", "00080032", "00080033", "0008002A", "00200012", "00201041", "00020003"].map(normalizeTag),
);

function topLevelValue(nodes: TagNode[], tag: string): string | undefined {
  return nodes.find((n) => n.tag === tag)?.value;
}

function parsePair(raw: string): [number, number] {
  const [a, b] = raw.split("\\").map(Number);
  return [a, b];
}

function pairsAgree(a: [number, number], b: [number, number], tolerance: number): boolean {
  return Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance;
}

// The most frequent value, ties broken by the value itself rather than by which file happened to
// come first - same reasoning, and same shape, as `mostCommon` in model/series.ts, but kept local
// here since it serves a different need (a majority value to report the minority against).
function mostCommonValue(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort(([av, ac], [bv, bc]) => bc - ac || (av < bv ? -1 : av > bv ? 1 : 0))[0][0];
}

// The most frequent numeric value, within `tolerance` of itself, among a list of measurements. Used
// as "the expected spacing" for a series: real positions carry float noise far below `tolerance`, so
// bucketing by rounding to a grid that fine merges the noise without merging a genuinely different
// value. Ties break on the smaller value, for the same order-independence reason as `mostCommonValue`.
function modalMeasurement(values: number[], tolerance: number): number {
  const decimals = Math.max(0, Math.round(-Math.log10(tolerance)));
  const buckets = new Map<string, { value: number; count: number }>();
  for (const v of values) {
    const key = v.toFixed(decimals);
    const bucket = buckets.get(key);
    if (bucket) bucket.count++;
    else buckets.set(key, { value: v, count: 1 });
  }
  return [...buckets.values()].sort((a, b) => b.count - a.count || a.value - b.value)[0].value;
}

// Position gaps and duplicate positions both read consecutive distances along the series' own
// normal; neither applies to a series that fell back to instance-number or filename order, because
// 2.3 leaves `distance` unset there - a distance computed against a normal that doesn't represent
// the whole series would be meaningless.
function positionFindings(series: Series): SeriesFinding[] {
  if (series.orderedBy !== "position") return [];
  const findings: SeriesFinding[] = [];
  const distances = series.instances.map((i) => i.distance!);

  // Duplicates: instances are sorted ascending by distance, so any tied run is a contiguous slice.
  let i = 0;
  while (i < distances.length) {
    let j = i;
    while (j + 1 < distances.length && distances[j + 1] - distances[j] <= POSITION_TOLERANCE_MM) j++;
    if (j > i) {
      findings.push({
        kind: "duplicate-position",
        scope: "series",
        seriesInstanceUid: series.seriesInstanceUid,
        files: series.instances.slice(i, j + 1).map((inst) => inst.fileName),
      });
    }
    i = j + 1;
  }

  // Gaps: need at least two consecutive differences before "the most common one" means anything.
  if (series.instances.length >= 3) {
    const diffs: number[] = [];
    for (let k = 1; k < distances.length; k++) diffs.push(distances[k] - distances[k - 1]);
    const expected = modalMeasurement(diffs, POSITION_TOLERANCE_MM);
    for (let k = 1; k < distances.length; k++) {
      const actual = distances[k] - distances[k - 1];
      if (Math.abs(actual - expected) > POSITION_TOLERANCE_MM) {
        findings.push({
          kind: "position-gap",
          scope: "series",
          seriesInstanceUid: series.seriesInstanceUid,
          files: [series.instances[k - 1].fileName, series.instances[k].fileName],
          expectedMm: expected,
          actualMm: actual,
        });
      }
    }
  }

  return findings;
}

function pixelSpacingFindings(series: Series, parsed: Map<string, ParsedFile>): SeriesFinding[] {
  const withSpacing = series.instances
    .map((i) => {
      const raw = topLevelValue(parsed.get(i.fileName)?.nodes ?? [], PIXEL_SPACING_TAG);
      return raw === undefined ? undefined : { fileName: i.fileName, spacing: parsePair(raw) };
    })
    .filter((e): e is { fileName: string; spacing: [number, number] } => e !== undefined);
  if (withSpacing.length < 2) return [];

  const groups: { spacing: [number, number]; fileNames: string[] }[] = [];
  for (const entry of withSpacing) {
    const group = groups.find((g) => pairsAgree(g.spacing, entry.spacing, PIXEL_SPACING_TOLERANCE_MM));
    if (group) group.fileNames.push(entry.fileName);
    else groups.push({ spacing: entry.spacing, fileNames: [entry.fileName] });
  }
  if (groups.length < 2) return [];

  groups.sort(
    (a, b) => b.fileNames.length - a.fileNames.length || JSON.stringify(a.spacing).localeCompare(JSON.stringify(b.spacing)),
  );
  const [majority, ...minorities] = groups;

  return minorities.map((group) => ({
    kind: "inconsistent-pixel-spacing",
    scope: "series",
    seriesInstanceUid: series.seriesInstanceUid,
    files: group.fileNames,
    spacingValues: Object.fromEntries(group.fileNames.map((f) => [f, group.spacing])),
    expectedSpacing: majority.spacing,
  }));
}

// 2.3 already decided whether a series' orientations agree; this just surfaces that decision as a
// finding, naming every slice in the series rather than trying to single out which one is the odd
// one out - `orientationConsistent` doesn't record that, and guessing would be worse than not.
function orientationFindings(series: Series): SeriesFinding[] {
  if (series.orientationConsistent) return [];
  return [
    {
      kind: "inconsistent-orientation",
      scope: "series",
      seriesInstanceUid: series.seriesInstanceUid,
      files: series.instances.map((i) => i.fileName),
    },
  ];
}

function modalitiesOf(fileNames: string[], parsed: Map<string, ParsedFile>): Map<string, string[]> {
  const byModality = new Map<string, string[]>();
  for (const fileName of fileNames) {
    const modality = topLevelValue(parsed.get(fileName)?.nodes ?? [], MODALITY_TAG);
    if (modality === undefined) continue;
    const list = byModality.get(modality) ?? [];
    list.push(fileName);
    byModality.set(modality, list);
  }
  return byModality;
}

function sortedModalities(byModality: Map<string, string[]>): Record<string, string[]> {
  return Object.fromEntries([...byModality.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// Within one series: 2.3 groups by SeriesInstanceUID alone, so a misfiled slice that carries the
// right series UID but wrong content (the A-9 fault) still lands here, and this is what catches it.
function modalityWithinSeries(series: Series, parsed: Map<string, ParsedFile>): SeriesFinding[] {
  const byModality = modalitiesOf(
    series.instances.map((i) => i.fileName),
    parsed,
  );
  if (byModality.size < 2) return [];
  return [
    {
      kind: "mixed-modality",
      scope: "series",
      seriesInstanceUid: series.seriesInstanceUid,
      modalities: sortedModalities(byModality),
    },
  ];
}

// Across the whole folder: unusual rather than wrong on its own (a folder can legitimately hold an
// MR series and a CT series from the same visit), so this is reported as an observation regardless
// of whether any single series is internally consistent.
function modalityAcrossFolder(grouping: Grouping, parsed: Map<string, ParsedFile>): SeriesFinding | undefined {
  const allFiles = [
    ...grouping.studies.flatMap((s) => s.series.flatMap((series) => series.instances.map((i) => i.fileName))),
    ...grouping.ungrouped.map((i) => i.fileName),
  ];
  const byModality = modalitiesOf(allFiles, parsed);
  if (byModality.size < 2) return undefined;
  return { kind: "mixed-modality", scope: "folder", modalities: sortedModalities(byModality) };
}

// A SeriesInstanceUID is supposed to be unique to one series in one study. If the same one turns up
// under two different studies, 2.3's grouping - study first, then series - has already split it into
// two separate `Series` entries; this looks across that split to say so.
function identifierFindings(grouping: Grouping): SeriesFinding[] {
  const occurrences = new Map<string, { studyInstanceUid: string; files: string[] }[]>();
  for (const study of grouping.studies) {
    for (const series of study.series) {
      if (series.seriesInstanceUid === undefined) continue;
      const list = occurrences.get(series.seriesInstanceUid) ?? [];
      list.push({ studyInstanceUid: study.studyInstanceUid ?? "", files: series.instances.map((i) => i.fileName) });
      occurrences.set(series.seriesInstanceUid, list);
    }
  }

  const findings: SeriesFinding[] = [];
  for (const [seriesInstanceUid, entries] of occurrences) {
    const distinctStudies = new Set(entries.map((e) => e.studyInstanceUid));
    if (distinctStudies.size > 1) {
      findings.push({
        kind: "inconsistent-identifier",
        scope: "series",
        seriesInstanceUid,
        files: entries.flatMap((e) => e.files),
      });
    }
  }
  return findings.sort((a, b) => (a.seriesInstanceUid! < b.seriesInstanceUid! ? -1 : 1));
}

function findingsByPath(parsed: Map<string, ParsedFile>, fileName: string): Map<string, Finding> {
  return new Map((parsed.get(fileName)?.findings ?? []).map((f) => [f.path, f]));
}

// A finding present on some slices of a series and absent on others, compared by canonical path so
// a nested finding is only ever compared against a nested finding at the same depth in the same
// sequence. Includes private tags: their contents can't be read, but a private block appearing on
// one slice and not the rest is informative on its own.
function extraFieldFindings(series: Series, parsed: Map<string, ParsedFile>): SeriesFinding[] {
  const perFile = series.instances.map((i) => findingsByPath(parsed, i.fileName));
  if (perFile.length < 2) return [];

  const allPaths = new Set<string>();
  for (const byPath of perFile) for (const path of byPath.keys()) allPaths.add(path);

  const findings: SeriesFinding[] = [];
  for (const path of [...allPaths].sort()) {
    const withPath = series.instances.filter((_, idx) => perFile[idx].has(path));
    if (withPath.length > 0 && withPath.length < perFile.length) {
      const sample = perFile.find((byPath) => byPath.has(path))!.get(path)!;
      findings.push({
        kind: "extra-field",
        scope: "series",
        seriesInstanceUid: series.seriesInstanceUid,
        tag: sample.tag,
        path,
        files: withPath.map((i) => i.fileName),
      });
    }
  }
  return findings;
}

// A finding present on every slice of a series but holding a different value on at least one.
// Restricted to identifying findings - the rules engine's own classification, minus private tags,
// whose values vary legitimately and are already covered by the extra-field check above - and to
// tags not on the per-instance exemption list, since those are expected to vary by design.
function varyingValueFindings(series: Series, parsed: Map<string, ParsedFile>): SeriesFinding[] {
  const perFile = series.instances.map((i) => {
    const identifying = identifyingFindings(parsed.get(i.fileName)?.findings ?? []).filter((f) => f.kind !== "private");
    return new Map(identifying.map((f) => [f.path, f]));
  });
  if (perFile.length < 2) return [];

  const allPaths = new Set<string>();
  for (const byPath of perFile) for (const path of byPath.keys()) allPaths.add(path);

  const findings: SeriesFinding[] = [];
  for (const path of [...allPaths].sort()) {
    if (!perFile.every((byPath) => byPath.has(path))) continue;
    const sample = perFile[0].get(path)!;
    if (VALUE_EXEMPT_TAGS.has(sample.tag)) continue;

    const fileValues = series.instances.map((i, idx) => ({ fileName: i.fileName, value: perFile[idx].get(path)!.value ?? "" }));
    if (new Set(fileValues.map((fv) => fv.value)).size < 2) continue;

    const majority = mostCommonValue(fileValues.map((fv) => fv.value));
    const minority = fileValues.filter((fv) => fv.value !== majority);

    findings.push({
      kind: "varying-value",
      scope: "series",
      seriesInstanceUid: series.seriesInstanceUid,
      tag: sample.tag,
      path,
      files: minority.map((fv) => fv.fileName),
      values: Object.fromEntries(minority.map((fv) => [fv.fileName, fv.value])),
      otherFiles: majority,
    });
  }
  return findings;
}

/**
 * The series-level consistency checks: everything that can only be seen by comparing slices of one
 * series (or series across one folder) against each other, rather than by reading one file alone.
 * Returns findings in a stable order - per series, in the order the checks are listed above, series
 * in the grouping's own study/series order, then folder-wide checks last - so repeated runs on the
 * same input always agree.
 */
export function checkSeries(grouping: Grouping, parsed: Map<string, ParsedFile>): SeriesFinding[] {
  const findings: SeriesFinding[] = [];

  for (const study of grouping.studies) {
    for (const series of study.series) {
      findings.push(...positionFindings(series));
      findings.push(...pixelSpacingFindings(series, parsed));
      findings.push(...orientationFindings(series));
      findings.push(...modalityWithinSeries(series, parsed));
      findings.push(...varyingValueFindings(series, parsed));
      findings.push(...extraFieldFindings(series, parsed));
    }
  }

  findings.push(...identifierFindings(grouping));

  const folderModality = modalityAcrossFolder(grouping, parsed);
  if (folderModality) findings.push(folderModality);

  return findings;
}
