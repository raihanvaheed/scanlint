import type { Finding, TagNode } from "../model/types";
import type { Grouping } from "../model/series";
import type { SeriesFinding } from "../rules/series";
import type { AggregatedField } from "./series-aggregate";
import { aggregateIdentifyingFields } from "./series-aggregate";
import { IDENTIFYING_KINDS, STRUCTURAL_KINDS } from "./series-wording";

export type ParsedFile = { nodes: TagNode[]; findings: Finding[] };

/** Everything the series view's headline counts and sections are built from, computed once so the
 * component layer stays a render and the numbers stay independently checkable. */
export type SeriesReport = {
  totalRead: number;
  seriesCount: number;
  aggregatedFields: AggregatedField[];
  notConsistentFindings: SeriesFinding[];
  structuralFindings: SeriesFinding[];
};

export function buildSeriesReport(grouping: Grouping, findings: SeriesFinding[], readFiles: { fileName: string; findings: Finding[] }[]): SeriesReport {
  const seriesCount = grouping.studies.reduce((sum, s) => sum + s.series.length, 0);
  return {
    totalRead: readFiles.length,
    seriesCount,
    aggregatedFields: aggregateIdentifyingFields(readFiles),
    notConsistentFindings: findings.filter((f) => IDENTIFYING_KINDS.has(f.kind)),
    structuralFindings: findings.filter((f) => STRUCTURAL_KINDS.has(f.kind)),
  };
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
