import { lookupAttribute } from "../model/dictionary";
import { formatTag } from "../model/tag";
import type { SeriesFinding } from "../rules/series";

/** A finding worded as a sentence a reader is owed, plus the files it concerns and, for a nested
 * finding, the canonical path Stage 1 would also show. */
export type WordedFinding = { text: string; files: string[]; path?: string };

function fieldName(tag: string): string {
  return lookupAttribute(tag)?.name ?? formatTag(tag);
}

function filesOf(finding: SeriesFinding): string[] {
  return finding.files ?? Object.values(finding.modalities ?? {}).flat();
}

// Trims float noise (a subtraction like 6.02 - 3 can print as 3.0199999999999996) without hiding a
// genuine fraction of a millimetre.
function formatMm(n: number): string {
  return `${Math.round(n * 1000) / 1000}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Section 6's wording table, verbatim. `totalInSeries` is only read for `extra-field`, which needs
 * the series' own instance count - `SeriesFinding` carries how many files have the field, not how
 * many the series has in total.
 */
export function wordFinding(finding: SeriesFinding, context: { totalInSeries?: number } = {}): WordedFinding {
  const files = filesOf(finding);
  const path = finding.path;

  switch (finding.kind) {
    case "varying-value":
      return { text: `${fieldName(finding.tag!)} is not the same on every file`, files, path };
    case "extra-field": {
      const total = context.totalInSeries ?? files.length;
      return { text: `${fieldName(finding.tag!)} appears on ${files.length} of ${total} files only`, files, path };
    }
    case "position-gap":
      return {
        text: `A slice may be missing — ${formatMm(finding.actualMm!)} mm between two slices where ${formatMm(finding.expectedMm!)} mm is expected`,
        files,
      };
    case "duplicate-position":
      return { text: "Two slices occupy the same position", files };
    case "inconsistent-pixel-spacing":
      return { text: `${plural(files.length, "file")} ${files.length === 1 ? "has" : "have"} different pixel dimensions from the rest`, files };
    case "inconsistent-orientation":
      return { text: "Slices in this series are not all in the same plane", files };
    case "inconsistent-identifier":
      return { text: "Slices in this series belong to different studies", files };
    case "mixed-modality":
      return {
        text: finding.scope === "folder" ? "This folder holds more than one kind of scan" : "This series contains a file from a different kind of scan",
        files,
      };
    default: {
      const exhaustive: never = finding.kind;
      throw new Error(`No wording for finding kind "${exhaustive}"`);
    }
  }
}

/** Section 4's split: which of 2.4's finding kinds concern identifying information, and which are
 * structural observations about the file set. */
export const IDENTIFYING_KINDS = new Set<SeriesFinding["kind"]>(["varying-value", "extra-field"]);
export const STRUCTURAL_KINDS = new Set<SeriesFinding["kind"]>([
  "position-gap",
  "duplicate-position",
  "inconsistent-pixel-spacing",
  "inconsistent-orientation",
  "inconsistent-identifier",
  "mixed-modality",
]);
