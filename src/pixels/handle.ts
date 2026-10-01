import { toMessage } from "../lib/to-message";
import { decodeImage } from "./decode";
import type { DecodeOptions, DecodeOutcome } from "./protocol";

const FALLBACK_MESSAGE = "Could not read this file's pixel data.";

export function handleDecode(bytes: Uint8Array, options?: DecodeOptions): DecodeOutcome {
  try {
    const { width, height, rgba, window, transferSyntaxUid } = decodeImage(bytes, options);
    return { ok: true, width, height, rgba: rgba.buffer as ArrayBuffer, window, transferSyntaxUid };
  } catch (e) {
    const message = toMessage(e);
    return { ok: false, message: message === "" ? FALLBACK_MESSAGE : message };
  }
}
