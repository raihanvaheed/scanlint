import { toMessage } from "../lib/to-message";
import { decodeImage } from "./decode";
import { NoPixelDataError, UnsupportedFormatError, UnsupportedSyntaxError } from "./errors";
import type { DecodeOptions, DecodeOutcome } from "./protocol";

const FALLBACK_MESSAGE = "Could not read this file's pixel data.";

// Three error classes, one `reason` each - no message comparison anywhere below. 3.6a: a shared
// message constant compared by equality was tried for no-pixel-data and rejected, because its
// message is user-facing text in a step that reworded five other user-facing strings; the next
// person improving that wording would silently break dispatch. All three classes and decodeImage
// run inside the same worker module graph, so `instanceof` is sound - only plain data (DecodeOutcome)
// ever crosses the worker/main-thread message boundary, never one of these instances itself.
export async function handleDecode(bytes: Uint8Array, options?: DecodeOptions): Promise<DecodeOutcome> {
  try {
    const { width, height, rgba, window, transferSyntaxUid, frame, numberOfFrames } = await decodeImage(bytes, options);
    return { ok: true, width, height, rgba: rgba.buffer as ArrayBuffer, window, transferSyntaxUid, frame, numberOfFrames };
  } catch (e) {
    if (e instanceof UnsupportedSyntaxError) {
      return { ok: false, reason: "unsupported-syntax", transferSyntaxUid: e.transferSyntaxUid, message: e.message };
    }
    if (e instanceof UnsupportedFormatError) {
      return { ok: false, reason: "unsupported-format", message: e.message };
    }
    if (e instanceof NoPixelDataError) {
      return { ok: false, reason: "no-pixel-data", message: e.message };
    }
    const message = toMessage(e);
    return { ok: false, message: message === "" ? FALLBACK_MESSAGE : message };
  }
}
