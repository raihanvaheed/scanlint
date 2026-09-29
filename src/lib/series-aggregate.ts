import { identifyingFindings } from "../model/tree";
import type { Finding, FindingKind } from "../model/types";
import type { FileResult } from "./parse-many";

/** One distinct value a field holds, and which files hold it. `value`/`vr`/`length` come straight
 * off one of that value's own findings, so `FieldValue` renders it exactly as Stage 1 would. */
export type AggregatedValue = { value?: string; vr: string; length?: number; files: string[] };

/** One field's union across every read file: present in some or all of them, holding one value
 * everywhere it appears, or more than one. */
export type AggregatedField = {
  path: string;
  tag: string;
  name?: string;
  action?: string;
  kind: FindingKind;
  presentIn: number;
  total: number;
  values: AggregatedValue[];
};

/**
 * The union of every read file's identifying findings (Annex E and private; burned-in is a
 * statement about the image, not a field, and is excluded the same way Stage 1 excludes it),
 * grouped by canonical path - never by tag alone, since the same tag can occur at several depths.
 */
export function aggregateIdentifyingFields(files: { fileName: string; findings: Finding[] }[]): AggregatedField[] {
  const total = files.length;
  type Entry = { tag: string; name?: string; action?: string; kind: FindingKind; byValue: Map<string, AggregatedValue> };
  const byPath = new Map<string, Entry>();

  for (const file of files) {
    for (const finding of identifyingFindings(file.findings)) {
      let entry = byPath.get(finding.path);
      if (!entry) {
        entry = { tag: finding.tag, name: finding.name, action: finding.action, kind: finding.kind, byValue: new Map() };
        byPath.set(finding.path, entry);
      }
      const key = finding.value ?? "\u0000undefined";
      let bucket = entry.byValue.get(key);
      if (!bucket) {
        bucket = { value: finding.value, vr: finding.vr, length: finding.length, files: [] };
        entry.byValue.set(key, bucket);
      }
      bucket.files.push(file.fileName);
    }
  }

  return [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, entry]) => {
      const values = [...entry.byValue.values()];
      const presentIn = values.reduce((sum, v) => sum + v.files.length, 0);
      const field: AggregatedField = { path, tag: entry.tag, kind: entry.kind, presentIn, total, values };
      if (entry.name !== undefined) field.name = entry.name;
      if (entry.action !== undefined) field.action = entry.action;
      return field;
    });
}

/**
 * The folder name a selection came from, when every file was selected inside one - the shared
 * first segment of every `relativePath`. `undefined` for a plain multi-file selection (no folder
 * was ever involved) or a folder walk that somehow disagreed on its own root.
 */
export function deriveFolderName(results: FileResult[]): string | undefined {
  if (results.length === 0) return undefined;
  const roots = new Set(
    results.map((r) => {
      const path = r.relativePath;
      if (path === undefined) return undefined;
      const slash = path.indexOf("/");
      return slash === -1 ? undefined : path.slice(0, slash);
    }),
  );
  if (roots.size !== 1) return undefined;
  return [...roots][0];
}
