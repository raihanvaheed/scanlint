import type { WindowSetting } from "./decode";

export type DecodeOptions = { frame?: number; window?: WindowSetting };

export type DecodeRequest = {
  id: number;
  bytes: ArrayBuffer;
  options?: DecodeOptions;
};

// Why a `reason` exists at all (3.6): without it, "ScanLint doesn't decode this format" and "this
// file's pixel data is malformed" were both a plain `{ ok: false, message }`, indistinguishable by
// type - a reader could not tell a gap in the tool from a defect in their file, and the UI could
// only have told them apart by pattern-matching message text, which breaks silently the first time
// someone edits a string. `reason` absent means a genuine failure - that default is deliberate and
// is the safe direction: an unclassified case must read as an error, never as a reassuring note
// about scope. Never widen the fallback to make an unknown case look benign.
export type DecodeReason = "unsupported-syntax" | "unsupported-format" | "no-pixel-data";

// rgba travels as a plain ArrayBuffer, transferred rather than an ImageBitmap - the main thread
// reconstructs it with `new Uint8ClampedArray(buffer)` and `new ImageData(array, width, height)`.
// `window` is absent for a colour image, or a JPEG one, neither of which is windowed at all - see
// DecodedImage.
export type DecodeResult =
  | { id: number; ok: true; width: number; height: number; rgba: ArrayBuffer; window?: WindowSetting; transferSyntaxUid: string }
  | { id: number; ok: false; reason: "unsupported-syntax"; transferSyntaxUid: string; message: string }
  | { id: number; ok: false; reason: "unsupported-format" | "no-pixel-data"; message: string }
  | { id: number; ok: false; message: string };

/**
 * What `createPixelClient`'s `decode()` resolves with - richer than the wire message `DecodeResult`
 * carries, because "superseded" is a client-side concept the worker never knows about (see
 * client.ts). The real outcomes match `DecodeResult`'s shape exactly, minus `id`; `superseded` is a
 * client-only extra case, present only on that one variant - a caller checking `outcome.message` on
 * a real failure never sees it, by construction, not by convention. `superseded` stays its own
 * boolean rather than folding into `reason`: it is a different kind of thing (the request was
 * pre-empted, not that decoding reached any particular conclusion), and the two have never needed to
 * interact.
 */
export type DecodeOutcome =
  | { ok: true; width: number; height: number; rgba: ArrayBuffer; window?: WindowSetting; transferSyntaxUid: string }
  | { ok: false; superseded: true; message: string }
  | { ok: false; reason: "unsupported-syntax"; transferSyntaxUid: string; message: string }
  | { ok: false; reason: "unsupported-format" | "no-pixel-data"; message: string }
  | { ok: false; message: string };
