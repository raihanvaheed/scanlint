import type { WindowSetting } from "./decode";

export type DecodeOptions = { frame?: number; window?: WindowSetting };

export type DecodeRequest = {
  id: number;
  bytes: ArrayBuffer;
  options?: DecodeOptions;
};

// rgba travels as a plain ArrayBuffer, transferred rather than an ImageBitmap - the main thread
// reconstructs it with `new Uint8ClampedArray(buffer)` and `new ImageData(array, width, height)`.
// `window` is absent for a colour image, which is not windowed at all - see DecodedImage.
export type DecodeResult =
  | { id: number; ok: true; width: number; height: number; rgba: ArrayBuffer; window?: WindowSetting; transferSyntaxUid: string }
  | { id: number; ok: false; message: string };

/**
 * What `createPixelClient`'s `decode()` resolves with - richer than the wire message `DecodeResult`
 * carries, because "superseded" is a client-side concept the worker never knows about (see
 * client.ts). The two real outcomes match `DecodeResult`'s shape exactly, minus `id`; `superseded`
 * is a client-only third case, present only on that one variant - a caller checking `outcome.message`
 * on a real failure never sees it, by construction, not by convention.
 */
export type DecodeOutcome =
  | { ok: true; width: number; height: number; rgba: ArrayBuffer; window?: WindowSetting; transferSyntaxUid: string }
  | { ok: false; message: string }
  | { ok: false; superseded: true; message: string };
