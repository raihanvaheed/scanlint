import type { Finding, TagNode } from "../model/types";
import type { Grouping } from "../model/series";
import type { SeriesFinding } from "../rules/series";
import type { AggregatedField } from "./series-aggregate";
import { aggregateIdentifyingFields } from "./series-aggregate";
import { IDENTIFYING_KINDS, plural, STRUCTURAL_KINDS } from "./series-wording";

export type ParsedFile = { nodes: TagNode[]; findings: Finding[] };

/** Everything the series view's headline counts and sections are built from, computed once so the
 * component layer stays a render and the numbers stay independently checkable. */
export type SeriesReport = {
  totalRead: number;
  seriesCount: number;
  aggregatedFields: AggregatedField[];
  notConsistentFindings: SeriesFinding[];
  structuralFindings: SeriesFinding[];
  /** Worded once here so the series view and the report can never disagree, and so the report's
   * caveat about burned-in annotation is never left describing content that isn't actually there. */
  burnedIn: string;
};

// A statement about the image, not a field holding patient data - excluded from the identifying
// count by `identifyingFindings()` already (1.6a's decision), computed independently here from the
// same raw findings.
function burnedInSummary(readFiles: { fileName: string; findings: Finding[] }[]): string {
  const total = readFiles.length;
  if (total === 0) return "No file declares burned-in annotation.";

  let absent = 0;
  const byValue = new Map<string, number>();
  for (const file of readFiles) {
    const finding = file.findings.find((f) => f.kind === "burned-in");
    if (finding === undefined) {
      absent++;
      continue;
    }
    const value = finding.value ?? "";
    byValue.set(value, (byValue.get(value) ?? 0) + 1);
  }

  if (absent === total) return "No file declares burned-in annotation.";
  if (byValue.size === 1 && absent === 0) {
    const [[value]] = byValue;
    return `All ${plural(total, "file")} declare${total === 1 ? "s" : ""} burned-in annotation: ${value}`;
  }

  // Majority first, ties broken by the value itself - same reasoning as everywhere else that picks
  // a representative from a set without caring which file happened to come first.
  const declareClauses = [...byValue.entries()]
    .sort(([av, ac], [bv, bc]) => bc - ac || (av < bv ? -1 : av > bv ? 1 : 0))
    .map(([value, count], index) => (index === 0 ? `${plural(count, "file")} declare${count === 1 ? "s" : ""} ${value}` : `${count} declare${count === 1 ? "s" : ""} ${value}`));

  const parts = [declareClauses.join(", ")];
  if (absent > 0) parts.push(`${absent} do${absent === 1 ? "es" : ""} not carry the field`);
  return `Burned-in annotation: ${parts.join("; ")}`;
}

export function buildSeriesReport(grouping: Grouping, findings: SeriesFinding[], readFiles: { fileName: string; findings: Finding[] }[]): SeriesReport {
  const seriesCount = grouping.studies.reduce((sum, s) => sum + s.series.length, 0);
  return {
    totalRead: readFiles.length,
    seriesCount,
    aggregatedFields: aggregateIdentifyingFields(readFiles),
    notConsistentFindings: findings.filter((f) => IDENTIFYING_KINDS.has(f.kind)),
    structuralFindings: findings.filter((f) => STRUCTURAL_KINDS.has(f.kind)),
    burnedIn: burnedInSummary(readFiles),
  };
}

/**
 * The four headline lines, worded exactly as the screen words them - used by `SeriesHeader` and by
 * 2.6's report generator, so the two can never drift apart. The third and fourth lines are omitted
 * when there is nothing to say, matching the screen's own section-hiding behaviour.
 */
export function headlineLines(report: SeriesReport): string[] {
  const lines = [
    `${plural(report.totalRead, "file")} read across ${report.seriesCount} series`,
    `${plural(report.aggregatedFields.length, "field")} could identify a patient`,
  ];
  if (report.notConsistentFindings.length > 0) {
    lines.push(`${report.notConsistentFindings.length} identifying field${report.notConsistentFindings.length === 1 ? " is" : "s are"} not the same on every file`);
  }
  if (report.structuralFindings.length > 0) {
    lines.push(`${report.structuralFindings.length} structural inconsistenc${report.structuralFindings.length === 1 ? "y" : "ies"} between files`);
  }
  return lines;
}

const SERIES_NUMBER_TAG = "00200011";

/** The series' own declared SeriesNumber, read from any one of its instances - they should all
 * agree, and if none carries it, the caller falls back to the series' position in the list. */
export function seriesNumberOf(fileNames: string[], parsed: Map<string, ParsedFile>): string | undefined {
  for (const fileName of fileNames) {
    const value = parsed.get(fileName)?.nodes.find((n) => n.tag === SERIES_NUMBER_TAG)?.value;
    if (value !== undefined) return value;
  }
  return undefined;
}

export type FindingGroup = { label: string; findings: SeriesFinding[] };

/**
 * A finding list grouped by the series it belongs to, in the grouping's own order, with any
 * folder-scoped findings last under "Whole folder" - a series-scoped finding is meaningless without
 * knowing which series' instance count it's a fraction of, and the report's flat sections have no
 * other way to show that. A series with nothing to report gets no heading at all.
 */
export function groupFindingsBySeries(findings: SeriesFinding[], grouping: Grouping, parsed: Map<string, ParsedFile>): FindingGroup[] {
  const groups: FindingGroup[] = grouping.studies
    .flatMap((study) => study.series)
    .map((series, index) => ({
      label: `Series ${seriesNumberOf(series.instances.map((i) => i.fileName), parsed) ?? String(index + 1)}`,
      findings: findings.filter((f) => f.seriesInstanceUid === series.seriesInstanceUid),
    }))
    .filter((group) => group.findings.length > 0);

  const folderFindings = findings.filter((f) => f.seriesInstanceUid === undefined);
  if (folderFindings.length > 0) groups.push({ label: "Whole folder", findings: folderFindings });

  return groups;
}
