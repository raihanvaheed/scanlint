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

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const FILE_LIST_LIMIT = 5;

/**
 * A finding's file list, for both the screen and the report: up to five names, then how many more.
 * A duplicated position or a mixed-modality series can affect dozens of files at real-world scale
 * (2.5's own 760-file check found a 40-name line), which is readable but not something a line of
 * text should have to be. Fixed once, here, so neither surface can drift from the other.
 */
export function formatFileList(files: string[]): string {
  if (files.length <= FILE_LIST_LIMIT) return files.join(", ");
  return `${files.slice(0, FILE_LIST_LIMIT).join(", ")}, and ${files.length - FILE_LIST_LIMIT} more`;
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
    case "mixed-modality": {
      // The majority is whichever modality has the most files (ties broken alphabetically, for the
      // same order-independence reason as everywhere else); everything else is the minority that
      // actually caused the finding, and is what gets named and listed - not the whole series.
      const entries = Object.entries(finding.modalities ?? {}).sort(([am, af], [bm, bf]) => bf.length - af.length || (am < bm ? -1 : 1));
      const [majorityModality] = entries[0] ?? ["", []];
      const minorityEntries = entries.slice(1);
      const minorityFiles = minorityEntries.flatMap(([, fileNames]) => fileNames);

      if (finding.scope === "folder") {
        const summary = entries.map(([modality, fileNames]) => `${modality} (${plural(fileNames.length, "file")})`).join(", ");
        return { text: `This folder holds more than one kind of scan — ${summary}`, files: [] };
      }

      const minorityLabel = minorityEntries.map(([modality]) => modality).join(" and ");
      return {
        text: `This series contains ${plural(minorityFiles.length, "file")} from a different kind of scan — ${minorityLabel} among ${majorityModality}`,
        files: minorityFiles,
      };
    }
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
