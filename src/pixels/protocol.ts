import type { WindowSetting } from "./decode";

export type DecodeOptions = { frame?: number; window?: WindowSetting };

export type DecodeRequest = {
  id: number;
  bytes: ArrayBuffer;
  options?: DecodeOptions;
};

// rgba travels as a plain ArrayBuffer, transferred rather than an ImageBitmap - the main thread
// reconstructs it with `new Uint8ClampedArray(buffer)` and `new ImageData(array, width, height)`.
export type DecodeResult =
  | { id: number; ok: true; width: number; height: number; rgba: ArrayBuffer }
  | { id: number; ok: false; message: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type DecodeOutcome = DistributiveOmit<DecodeResult, "id">;
