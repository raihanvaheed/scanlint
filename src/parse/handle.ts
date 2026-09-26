import { classify } from "../rules/phi";
import type { ParseOutcome } from "./protocol";
import { parseMetadata } from "./walk";

const FALLBACK_MESSAGE = "Could not read this file as DICOM.";

// dicom-parser throws plain strings, so `e.message` is undefined for most failures.
export function toMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e === undefined || e === null) return "";
  return String(e);
}

export function handleParse(bytes: Uint8Array): ParseOutcome {
  try {
    const nodes = parseMetadata(bytes);
    return { ok: true, nodes, findings: classify(nodes) };
  } catch (e) {
    const message = toMessage(e);
    return { ok: false, message: message === "" ? FALLBACK_MESSAGE : message };
  }
}
