import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeJpegFragment } from "./jpeg";

// Node has no JPEG decoder and is never given one (3.6): these primitives are stubbed off
// globalThis, the same seam decode.ts itself reads at call time. The real decode is exercised in
// the browser (section 11), with sips confirming the encoder independently in 3.5.

type FakeBitmap = { width: number; height: number; close: ReturnType<typeof vi.fn> };

function installStubs(opts: { width: number; height: number; imageData?: Uint8ClampedArray }) {
  const bitmap: FakeBitmap = { width: opts.width, height: opts.height, close: vi.fn() };
  const createImageBitmap = vi.fn<(blob: Blob, options?: ImageBitmapOptions) => Promise<FakeBitmap>>(async () => bitmap);
  const drawImage = vi.fn();
  const getImageData = vi.fn(() => ({ data: opts.imageData ?? new Uint8ClampedArray(opts.width * opts.height * 4) }));
  const getContext = vi.fn(() => ({ drawImage, getImageData }));

  class FakeOffscreenCanvas {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
    getContext = getContext;
  }

  vi.stubGlobal("createImageBitmap", createImageBitmap);
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  return { bitmap, createImageBitmap, drawImage, getImageData, getContext };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("decodeJpegFragment", () => {
  it("passes a Blob of type image/jpeg and colorSpaceConversion none to createImageBitmap", async () => {
    const { createImageBitmap } = installStubs({ width: 2, height: 2 });
    await decodeJpegFragment(Uint8Array.of(1, 2, 3), { width: 2, height: 2 });

    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    const [blob, options] = createImageBitmap.mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/jpeg");
    expect(options).toEqual({ colorSpaceConversion: "none" });
  });

  it("closes the bitmap after drawing it", async () => {
    const { bitmap } = installStubs({ width: 1, height: 1 });
    await decodeJpegFragment(Uint8Array.of(1), { width: 1, height: 1 });
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it("closes the bitmap even when getImageData throws", async () => {
    const { bitmap, getContext } = installStubs({ width: 1, height: 1 });
    getContext.mockReturnValueOnce({ drawImage: vi.fn(), getImageData: vi.fn(() => { throw new Error("boom"); }) });
    await expect(decodeJpegFragment(Uint8Array.of(1), { width: 1, height: 1 })).rejects.toThrow("boom");
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it("the returned RGBA has length width * height * 4", async () => {
    const expected = new Uint8ClampedArray(3 * 2 * 4).fill(9);
    installStubs({ width: 3, height: 2, imageData: expected });
    const rgba = await decodeJpegFragment(Uint8Array.of(1), { width: 3, height: 2 });
    expect(rgba.length).toBe(3 * 2 * 4);
    expect(rgba).toEqual(expected);
  });

  it("throws naming both dimensions when the decoded bitmap disagrees with Rows/Columns", async () => {
    installStubs({ width: 10, height: 10 });
    await expect(decodeJpegFragment(Uint8Array.of(1), { width: 20, height: 30 })).rejects.toThrow(/10x10/);
    installStubs({ width: 10, height: 10 });
    await expect(decodeJpegFragment(Uint8Array.of(1), { width: 20, height: 30 })).rejects.toThrow(/30x20/);
  });

  it("throws naming createImageBitmap when it is not available", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    vi.stubGlobal("OffscreenCanvas", class {});
    await expect(decodeJpegFragment(Uint8Array.of(1), { width: 1, height: 1 })).rejects.toThrow(/createImageBitmap/);
  });

  it("throws naming OffscreenCanvas when it is not available", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn());
    vi.stubGlobal("OffscreenCanvas", undefined);
    await expect(decodeJpegFragment(Uint8Array.of(1), { width: 1, height: 1 })).rejects.toThrow(/OffscreenCanvas/);
  });
});
