import { applyNames, lookupAttribute } from "../model/dictionary";
import { normalizeTag } from "../model/tag";
import { splitVr } from "../model/vr";
import { classify } from "../rules/phi";
import { toMessage } from "../lib/to-message";
import type { ParseOutcome } from "./protocol";
import { parseMetadata } from "./walk";

const FALLBACK_MESSAGE = "Could not read this file as DICOM.";

// dicom-parser asks for a VR only in implicit-VR data, where the stream carries none. It passes its own
// tag format ("x00100010"). An unknown tag, private ones included, gets undefined, and the parser
// then uses UN: a VR that cannot be known is not guessed.
function vrForTag(tag: string): string | undefined {
  const vr = lookupAttribute(normalizeTag(tag))?.vr;
  return vr === undefined ? undefined : splitVr(vr);
}

export function handleParse(bytes: Uint8Array): ParseOutcome {
  try {
    const nodes = applyNames(parseMetadata(bytes, { vrCallback: vrForTag }));
    return { ok: true, nodes, findings: classify(nodes) };
  } catch (e) {
    const message = toMessage(e);
    return { ok: false, message: message === "" ? FALLBACK_MESSAGE : message };
  }
}
