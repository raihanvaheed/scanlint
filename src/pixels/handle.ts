import { toMessage } from "../lib/to-message";
import { decodeImage } from "./decode";
import type { DecodeOptions, DecodeOutcome } from "./protocol";

const FALLBACK_MESSAGE = "Could not read this file's pixel data.";

export function handleDecode(bytes: Uint8Array, options?: DecodeOptions): DecodeOutcome {
  try {
    const { width, height, rgba } = decodeImage(bytes, options);
    return { ok: true, width, height, rgba: rgba.buffer as ArrayBuffer };
  } catch (e) {
    const message = toMessage(e);
    return { ok: false, message: message === "" ? FALLBACK_MESSAGE : message };
  }
}
