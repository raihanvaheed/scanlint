import { PRIVATE_REASON } from "../components/findings-list";
import { plainText } from "../components/field-value";
import { BURNED_IN_CAVEAT } from "../components/single-file-result";
import { ACTION_GLOSS } from "../model/actions";
import type { Grouping } from "../model/series";
import { formatTag } from "../model/tag";
import { VALUE_EXEMPT_TAGS } from "../rules/series";
import type { SeriesFinding } from "../rules/series";
import type { AggregatedField } from "./series-aggregate";
import { groupFindingsBySeries, headlineLines, seriesNumberOf } from "./series-report";
import type { ParsedFile, SeriesReport } from "./series-report";
import { formatFileList, IDENTIFYING_KINDS, plural, STRUCTURAL_KINDS, wordFinding } from "./series-wording";

const SITE = "scanlint.raihanvaheed.dev";

const VALUES_WARNING = "This report contains identifying information copied from the file. Handle it as you would the file itself.";

const CAVEATS = [
  "ScanLint reads metadata. It cannot see text printed into the image itself; where a file declares burned-in annotation, that declaration is reported above and is unreliable in both directions.",
  "Flagging is not anonymising. This report describes what a de-identification profile would act on. No file has been changed.",
];

export type ReportTotals = { selected: number; read: number; notDicom: number; dicomdir: number; failed: number };
export type FailedFile = { name: string; message: string };

export type ReportInput = {
  folderName?: string;
  totals: ReportTotals;
  grouping: Grouping;
  findings: SeriesFinding[];
  parsed: Map<string, ParsedFile>;
  report: SeriesReport;
  failedFiles: FailedFile[];
  includeValues: boolean;
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Hand-formatted from the Date object's own local-time getters, never `toLocaleString` (whose
// output depends on the running machine's ICU data and locale) and never `toISOString` (UTC, not
// local) - the same value, on any machine, for the same injected `now`.
function formatLocalDate(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function formatLocalTime(now: Date): string {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** Lowercase, non-alphanumerics collapsed to single hyphens, no leading or trailing hyphen. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "files"
  );
}

export function reportFilename(folderName: string | undefined, extension: "md" | "json", now: Date): string {
  const slug = folderName === undefined ? "files" : slugify(folderName);
  return `scanlint-${slug}-${formatLocalDate(now)}.${extension}`;
}

function fieldValueLines(field: AggregatedField, includeValues: boolean): string[] {
  const lines: string[] = [];
  // A tag on the varying-value exempt list (per-instance UIDs, timestamps, geometry) is guaranteed
  // to differ on every file by design - the count is true and tells a reader nothing, so it's
  // suppressed here the same way 2.4 already suppresses it as a "varying-value" finding.
  if (field.values.length > 1 && !VALUE_EXEMPT_TAGS.has(field.tag)) lines.push(`- Distinct values: ${field.values.length}`);
  if (!includeValues) return lines;

  if (field.values.length === 1) {
    lines.push(`- Value: ${plainText(field.values[0])}`);
  } else {
    for (const v of field.values) {
      lines.push(`  - ${plainText(v)} (in ${plural(v.files.length, "file")})`);
    }
  }
  return lines;
}

function identifyingFieldSection(field: AggregatedField, includeValues: boolean): string {
  const label = field.name ?? formatTag(field.tag);
  const presence = field.presentIn === field.total ? `in all ${field.total} files` : `in ${field.presentIn} of ${field.total} files`;
  const lines = [`### ${label}`, `- Tag: ${formatTag(field.tag)}`];
  // The same tag can occur at more than one depth (a nested copy of a field the top level also
  // carries) - the canonical path is what tells two otherwise-identical-looking entries apart,
  // exactly as the screen's own row does.
  if (field.path.includes("/")) lines.push(`- Path: \`${field.path}\``);
  lines.push(field.kind === "private" ? `- ${PRIVATE_REASON}` : `- Action: ${field.action} — ${ACTION_GLOSS[field.action ?? ""] ?? field.action}`);
  lines.push(`- Present: ${presence}`);
  lines.push(...fieldValueLines(field, includeValues));
  return lines.join("\n");
}

function findingSection(finding: SeriesFinding, totalInSeries: number | undefined): string {
  const { text, files, path } = wordFinding(finding, { totalInSeries });
  const lines = [`- ${text}`];
  if (files.length > 0) lines.push(`  ${formatFileList(files)}`);
  // Shown for every finding that carries one, nested or not - a top-level path is just the tag
  // itself, which is what tells two same-named findings apart with no special case for depth.
  if (path !== undefined) lines.push(`  \`${path}\``);
  return lines.join("\n");
}

function seriesSection(grouping: Grouping, parsed: Map<string, ParsedFile>, includeValues: boolean): string {
  const blocks = grouping.studies
    .flatMap((study) => study.series)
    .map((series, index) => {
      const fileNames = series.instances.map((i) => i.fileName);
      const number = seriesNumberOf(fileNames, parsed) ?? String(index + 1);
      const orderedBy =
        series.orderedBy === "position"
          ? "Ordered by position"
          : series.orderedBy === "instance-number"
            ? "Ordered by instance number — position data missing"
            : "Ordered by file name — no position or instance number";
      const lines = [`### Series ${number} · ${series.modality ?? "unknown modality"} · ${plural(series.instances.length, "slice")}`, "", orderedBy];
      // A masked value reads as noise in a static document - there's no reveal control here to act
      // on, unlike the screen, so the line is omitted entirely rather than saying there's something
      // hidden. Shown only once the opt-in actually puts the value on the page.
      if (series.description !== undefined && includeValues) lines.push(`Description: ${series.description}`);
      return lines.join("\n");
    });
  return blocks.join("\n\n");
}

function ungroupedSection(grouping: Grouping): string {
  const reasonText: Record<string, string> = { "missing-study": "no study identifier", "missing-series": "no series identifier", "missing-both": "neither identifier" };
  if (grouping.ungrouped.length === 0) return "None.";
  return grouping.ungrouped.map((i) => `- ${i.fileName}: ${reasonText[i.ungroupedReason ?? "missing-both"]}`).join("\n");
}

function failedSection(failedFiles: FailedFile[]): string {
  if (failedFiles.length === 0) return "None.";
  return failedFiles.map((f) => `- ${f.name}: ${f.message}`).join("\n");
}

/** The Markdown report. Takes `now` as a parameter rather than reading the clock, so it can be
 * snapshot-tested against a fixed expected value - the same reason `createPool` and `vrCallback`
 * take their dependencies as parameters instead of reaching for them. */
export function buildMarkdownReport(input: ReportInput, now: Date): string {
  const { folderName, totals, grouping, findings, parsed, report, failedFiles, includeValues } = input;

  const parts: string[] = ["# ScanLint report", ""];
  if (includeValues) parts.push(VALUES_WARNING, "");
  parts.push(`Checked ${formatLocalDate(now)} at ${formatLocalTime(now)} · ${SITE}`, "");

  parts.push(
    "## What was checked",
    "",
    `- Folder: ${folderName ?? "(none — individual files were selected)"}`,
    `- ${plural(totals.selected, "file")} selected`,
    `- ${plural(totals.read, "DICOM file")} read`,
    `- ${totals.notDicom} skipped, not DICOM`,
    `- ${totals.dicomdir} skipped, a DICOMDIR`,
    `- ${totals.failed} could not be read`,
    `- ${report.seriesCount} series`,
    "",
  );

  parts.push("## Summary", "", ...headlineLines(report).map((l) => `- ${l}`), "", report.burnedIn, "", BURNED_IN_CAVEAT, "");

  parts.push(`## Identifying fields (${report.aggregatedFields.length})`, "");
  if (report.aggregatedFields.length === 0) parts.push("None.", "");
  else {
    for (const field of report.aggregatedFields) parts.push(identifyingFieldSection(field, includeValues), "");
  }

  // Grouped by series, per 2.6a: a series-scoped finding's "of N files" is meaningless without
  // knowing which series it's a fraction of, and the screen gets that for free from sitting inside
  // the series' own block - the report's flat sections don't, so the grouping is made explicit here.
  const seriesTotals = new Map(grouping.studies.flatMap((s) => s.series).map((s) => [s.seriesInstanceUid, s.instances.length]));
  const findingGroupLines = (group: { label: string; findings: SeriesFinding[] }) => [
    `### ${group.label}`,
    "",
    ...group.findings.flatMap((f) => [findingSection(f, seriesTotals.get(f.seriesInstanceUid ?? "")), ""]),
  ];

  const notConsistent = findings.filter((f) => IDENTIFYING_KINDS.has(f.kind));
  parts.push(`## Not consistent across files (${notConsistent.length})`, "");
  if (notConsistent.length === 0) parts.push("None.", "");
  else {
    for (const group of groupFindingsBySeries(notConsistent, grouping, parsed)) parts.push(...findingGroupLines(group));
  }

  const structural = findings.filter((f) => STRUCTURAL_KINDS.has(f.kind));
  parts.push(`## Structural inconsistencies (${structural.length})`, "");
  if (structural.length === 0) parts.push("None.", "");
  else {
    for (const group of groupFindingsBySeries(structural, grouping, parsed)) parts.push(...findingGroupLines(group));
  }

  parts.push(`## Series (${report.seriesCount})`, "");
  parts.push(report.seriesCount === 0 ? "None." : seriesSection(grouping, parsed, includeValues), "");

  parts.push(`## Ungrouped files (${grouping.ungrouped.length})`, "", ungroupedSection(grouping), "");
  parts.push(`## Failed files (${failedFiles.length})`, "", failedSection(failedFiles), "");

  parts.push("## Caveats", "", CAVEATS.join("\n\n"));

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** The JSON report - the same information the Markdown report carries, structured for a script.
 * File lists are never truncated here: `formatFileList`'s "and N more" is a prose readability
 * concern for the Markdown report and the screen, not something a program consuming this should
 * ever see instead of the real list. */
export function buildJsonReport(input: ReportInput, now: Date): string {
  const { folderName, totals, grouping, findings, parsed, report, failedFiles, includeValues } = input;
  const reasonText: Record<string, string> = { "missing-study": "no study identifier", "missing-series": "no series identifier", "missing-both": "neither identifier" };

  const identifyingFields = report.aggregatedFields.map((field) => ({
    path: field.path,
    tag: formatTag(field.tag),
    name: field.name,
    kind: field.kind,
    action: field.action,
    actionGloss: field.action !== undefined ? ACTION_GLOSS[field.action] : undefined,
    presentIn: field.presentIn,
    total: field.total,
    distinctValues: field.values.length,
    values: includeValues ? field.values.map((v) => ({ value: plainText(v), files: v.files })) : undefined,
  }));

  // SeriesInstanceUID is itself an Annex E "U" (identifying) field, so it never appears as a bare
  // value by default - series are correlated by their display number instead, the same label the
  // screen and the rest of this report use, and the real UID is included only under the opt-in.
  const allSeries = grouping.studies.flatMap((s) => s.series);
  const seriesNumbers = new Map(allSeries.map((s, index) => [s.seriesInstanceUid, seriesNumberOf(s.instances.map((i) => i.fileName), parsed) ?? String(index + 1)]));

  const toFindingJson = (f: SeriesFinding) => {
    const worded = wordFinding(f, { totalInSeries: allSeries.find((s) => s.seriesInstanceUid === f.seriesInstanceUid)?.instances.length });
    return {
      kind: f.kind,
      text: worded.text,
      files: worded.files,
      path: worded.path,
      series: f.seriesInstanceUid !== undefined ? seriesNumbers.get(f.seriesInstanceUid) : undefined,
      seriesInstanceUid: includeValues ? f.seriesInstanceUid : undefined,
    };
  };

  const series = allSeries.map((s) => ({
    number: seriesNumbers.get(s.seriesInstanceUid),
    seriesInstanceUid: includeValues ? s.seriesInstanceUid : undefined,
    modality: s.modality,
    sliceCount: s.instances.length,
    orderedBy: s.orderedBy,
    orientationConsistent: s.orientationConsistent,
    description: includeValues ? s.description : undefined,
  }));

  const body = {
    provenance: { tool: SITE, generatedAt: now.toISOString() },
    whatWasChecked: {
      folderName,
      filesSelected: totals.selected,
      dicomFilesRead: totals.read,
      skippedNotDicom: totals.notDicom,
      skippedDicomdir: totals.dicomdir,
      failed: totals.failed,
      seriesCount: report.seriesCount,
    },
    headline: {
      filesRead: report.totalRead,
      seriesCount: report.seriesCount,
      identifyingFieldCount: report.aggregatedFields.length,
      notConsistentCount: findings.filter((f) => IDENTIFYING_KINDS.has(f.kind)).length,
      structuralCount: findings.filter((f) => STRUCTURAL_KINDS.has(f.kind)).length,
    },
    burnedIn: report.burnedIn,
    identifyingFields,
    notConsistent: findings.filter((f) => IDENTIFYING_KINDS.has(f.kind)).map(toFindingJson),
    structural: findings.filter((f) => STRUCTURAL_KINDS.has(f.kind)).map(toFindingJson),
    series,
    ungrouped: grouping.ungrouped.map((i) => ({ fileName: i.fileName, reason: reasonText[i.ungroupedReason ?? "missing-both"] })),
    failed: failedFiles,
    includesValues: includeValues,
    caveats: CAVEATS,
  };

  return JSON.stringify(body, null, 2);
}
