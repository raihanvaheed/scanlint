// The one place the pixel-decoding path touches a browser image-decoding primitive, so it is the
// one place a test has to stub (`globalThis.createImageBitmap`, `globalThis.OffscreenCanvas`) and
// the one place that primitive dependency can ever be. DICOM semantics (PhotometricInterpretation,
// windowing, rescale) are decode.ts's job, not this file's - this just turns compressed JPEG bytes
// into RGBA.

/**
 * Decodes one JPEG Baseline (Process 1) fragment into RGBA, via the browser's own JPEG decoder -
 * this project does not carry one of its own. Length is always `expected.width * expected.height *
 * 4`.
 */
export async function decodeJpegFragment(fragment: Uint8Array, expected: { width: number; height: number }): Promise<Uint8ClampedArray> {
  // Read off globalThis at call time, not at module load: a stub installed in a test's setup after
  // this module was imported would never be seen by a reference captured at the top of the file.
  const createBitmap = globalThis.createImageBitmap;
  if (typeof createBitmap !== "function") {
    throw new Error("createImageBitmap is not available: JPEG decoding needs a browser");
  }
  const OffscreenCanvasCtor = globalThis.OffscreenCanvas;
  if (typeof OffscreenCanvasCtor !== "function") {
    throw new Error("OffscreenCanvas is not available: JPEG decoding needs a browser");
  }

  // The type hint matters to some engines' sniffing. `.slice()` (not just for a safe copy of a
  // fragment that may be a subarray view): TypedArray.prototype.slice()'s return type is always
  // backed by a plain ArrayBuffer, which is what BlobPart requires - `fragment` itself is typed as
  // possibly SharedArrayBuffer-backed, which Blob's constructor does not accept.
  const blob = new Blob([fragment.slice()], { type: "image/jpeg" });
  // colorSpaceConversion "none" is what stops the browser applying a colour-management transform to
  // an untagged JPEG - without it the greyscale oracle drifts by a few levels, for a reason that is
  // not obvious from the result alone.
  const bitmap = await createBitmap(blob, { colorSpaceConversion: "none" });

  try {
    if (bitmap.width !== expected.width || bitmap.height !== expected.height) {
      throw new Error(`Decoded JPEG is ${bitmap.width}x${bitmap.height}, but Rows/Columns declare ${expected.height}x${expected.width}`);
    }

    const canvas = new OffscreenCanvasCtor(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error("Could not get a 2D context to decode this JPEG");
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  } finally {
    // Stepping through a series otherwise accumulates decoded bitmaps until the collector gets
    // round to them.
    bitmap.close();
  }
}
