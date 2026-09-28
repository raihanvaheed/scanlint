import { identifyingFindings } from "../model/tree";
import type { ParseOutcome } from "../parse/protocol";
import { hasDicomMagic, isDicomDir } from "./dicom-detect";

/** The 132 bytes needed for the magic check, or the whole file. Kept separate so a large
 * non-DICOM file is never fully read just to be skipped. */
export type FileSource = {
  name: string;
  relativePath?: string;
  peek: () => Promise<ArrayBuffer>;
  read: () => Promise<ArrayBuffer>;
};

export type FileOutcome =
  | { kind: "read"; findings: number }
  | { kind: "skipped"; reason: "not-dicom" | "dicomdir" }
  | { kind: "failed"; message: string };

export type FileResult = {
  name: string;
  relativePath?: string;
  outcome: FileOutcome;
};

export type ParseManyOptions = {
  /** How many files may be read into memory and parsed at once. Matches the pool's worker count:
   * a file's bytes are read only when a worker is free to take them, never all up front. */
  concurrency: number;
  parse: (bytes: ArrayBuffer) => Promise<ParseOutcome>;
  /** Called as each file finishes, in whatever order that happens, for a progress display. */
  onResult?: (result: FileResult, index: number, total: number) => void;
  /** Polled between files. Once true, no new file starts; files already being read or parsed
   * finish normally and are still included in the result. */
  isCancelled?: () => boolean;
};

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function classify(file: FileSource, parse: ParseManyOptions["parse"]): Promise<FileOutcome> {
  let header: ArrayBuffer;
  try {
    header = await file.peek();
  } catch (e) {
    return { kind: "failed", message: messageOf(e) };
  }
  if (!hasDicomMagic(header)) return { kind: "skipped", reason: "not-dicom" };

  let bytes: ArrayBuffer;
  try {
    bytes = await file.read();
  } catch (e) {
    return { kind: "failed", message: messageOf(e) };
  }

  let outcome: ParseOutcome;
  try {
    outcome = await parse(bytes);
  } catch (e) {
    return { kind: "failed", message: messageOf(e) };
  }
  if (!outcome.ok) return { kind: "failed", message: outcome.message };
  if (isDicomDir(outcome.nodes)) return { kind: "skipped", reason: "dicomdir" };
  return { kind: "read", findings: identifyingFindings(outcome.findings).length };
}

/**
 * Reads and parses every file, at most `concurrency` at a time, and returns one result per file
 * that ran to completion, in selection order. A file whose magic check fails is never read in
 * full: `peek` alone decides that, so a large non-DICOM file costs 132 bytes, not its whole size.
 */
export async function parseMany(files: FileSource[], options: ParseManyOptions): Promise<FileResult[]> {
  const { concurrency, parse, onResult, isCancelled } = options;
  const results: (FileResult | undefined)[] = new Array(files.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (isCancelled?.()) return;
      const index = cursor++;
      if (index >= files.length) return;
      const file = files[index];
      const outcome = await classify(file, parse);
      const result: FileResult = { name: file.name, relativePath: file.relativePath, outcome };
      results[index] = result;
      onResult?.(result, index, files.length);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, files.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results.filter((r): r is FileResult => r !== undefined);
}
