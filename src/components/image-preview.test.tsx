// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { decodeImage } from "../pixels/decode";
import { buildDicom, bytes8 } from "../pixels/build-dicom";
import type { DecodeOptions, DecodeOutcome } from "../pixels/protocol";
import { ImagePreview, drawDecoded } from "./image-preview";

afterEach(cleanup);

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES_DIR = path.join(ROOT, "fixtures", "pixels");
const SAMPLES_DIR = path.join(ROOT, "public", "samples");

function readFixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES_DIR, name)));
}

// burned-in.dcm ships as a second sample (3.4a), not a fixture.
function readBurnedIn(): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(SAMPLES_DIR, "burned-in.dcm")));
}

// Matches only the caption paragraph ("… · window 12 / 34"), not the "Reset window" button, which
// also contains the word "window" but never followed by a number.
function windowText(): string {
  return screen.getByText(/window -?\d/).textContent ?? "";
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// A real decodeImage call, wrapped in the same shape createPixelClient's decode() resolves with -
// close enough to real behaviour for these tests without needing a worker.
async function realDecode(bytes: ArrayBuffer, options?: DecodeOptions): Promise<DecodeOutcome> {
  try {
    const image = await decodeImage(new Uint8Array(bytes), options);
    return { ok: true, width: image.width, height: image.height, rgba: image.rgba.buffer as ArrayBuffer, window: image.window, transferSyntaxUid: image.transferSyntaxUid, frame: image.frame, numberOfFrames: image.numberOfFrames };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const NO_ANNOUNCE = () => {};

describe("closed by default", () => {
  it("renders closed, and does not call decode", () => {
    const decode = vi.fn();
    const getBytes = vi.fn();
    render(<ImagePreview fileKey="a.dcm" fileLabel="a.dcm" getBytes={getBytes} decode={decode} announce={NO_ANNOUNCE} />);

    expect(screen.getByRole("button", { name: "Show image" })).toBeTruthy();
    expect(decode).not.toHaveBeenCalled();
    expect(getBytes).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("opening calls decode exactly once", async () => {
    const user = userEvent.setup();
    const getBytes = () => Promise.resolve(toArrayBuffer(readFixture("pattern-explicit.dcm")));
    const decode = vi.fn(realDecode);
    render(<ImagePreview fileKey="pattern-explicit.dcm" fileLabel="pattern-explicit.dcm" getBytes={getBytes} decode={decode} announce={NO_ANNOUNCE} />);

    await user.click(screen.getByRole("button", { name: "Show image" }));
    await screen.findByRole("img");

    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("closing and reopening does not decode again if the image is already in hand", async () => {
    const user = userEvent.setup();
    const getBytes = () => Promise.resolve(toArrayBuffer(readFixture("pattern-explicit.dcm")));
    const decode = vi.fn(realDecode);
    render(<ImagePreview fileKey="pattern-explicit.dcm" fileLabel="pattern-explicit.dcm" getBytes={getBytes} decode={decode} announce={NO_ANNOUNCE} />);

    await user.click(screen.getByRole("button", { name: "Show image" }));
    await screen.findByRole("img");
    await user.click(screen.getByRole("button", { name: "Hide image" }));
    expect(screen.queryByRole("img")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show image" }));
    expect(await screen.findByRole("img")).toBeTruthy();

    expect(decode).toHaveBeenCalledTimes(1);
  });
});

describe("drawing (drawDecoded)", () => {
  it("putImageData receives data of the right dimensions", async () => {
    const image = await decodeImage(readFixture("pattern-explicit.dcm"));
    const ctx = { putImageData: vi.fn() } as unknown as CanvasRenderingContext2D;
    drawDecoded(ctx, image);

    expect(ctx.putImageData).toHaveBeenCalledTimes(1);
    const call = (ctx.putImageData as ReturnType<typeof vi.fn>).mock.calls[0];
    const [imageData, x, y] = call;
    expect(imageData.width).toBe(64);
    expect(imageData.height).toBe(64);
    expect(imageData.data.length).toBe(64 * 64 * 4);
    expect(x).toBe(0);
    expect(y).toBe(0);
  });

  it("a handful of pixel values match what decodeImage produces for the same fixture, under the declared window", async () => {
    const image = await decodeImage(readFixture("pattern-explicit.dcm"), { window: { center: 0, width: 400 } });
    const ctx = { putImageData: vi.fn() } as unknown as CanvasRenderingContext2D;
    drawDecoded(ctx, image);

    const imageData = (ctx.putImageData as ReturnType<typeof vi.fn>).mock.calls[0][0] as ImageData;
    const greyAt = (x: number, y: number) => imageData.data[(y * image.width + x) * 4];
    expect(greyAt(0, 0)).toBe(0);
    expect(greyAt(63, 63)).toBe(255);
    expect(greyAt(0, 7)).toBe(46);
  });
});

describe("window adjustment", () => {
  async function openWithFallback() {
    const user = userEvent.setup();
    const getBytes = () => Promise.resolve(toArrayBuffer(readBurnedIn()));
    render(<ImagePreview fileKey="burned-in.dcm" fileLabel="burned-in.dcm" getBytes={getBytes} decode={realDecode} announce={NO_ANNOUNCE} />);
    await user.click(screen.getByRole("button", { name: "Show image" }));
    const canvas = await screen.findByRole("img");
    return canvas;
  }

  it("a horizontal drag of 256px roughly doubles the width", async () => {
    const canvas = await openWithFallback();
    const before = windowText();
    const initialWidth = Number(/window -?\d+ \/ (\d+)/.exec(before)?.[1]);
    expect(initialWidth).toBeGreaterThan(0);

    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0, pointerId: 1 }));
    canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 256, clientY: 0, pointerId: 1 }));
    await waitFor(() => {
      const after = Number(/window -?\d+ \/ (\d+)/.exec(windowText())?.[1]);
      expect(after).toBeCloseTo(initialWidth * 2, -1);
    });
  });

  it("a vertical drag changes the centre by the specified amount", async () => {
    const canvas = await openWithFallback();
    const before = windowText();
    const [initialCenter, initialWidth] = (/window (-?\d+) \/ (\d+)/.exec(before) ?? []).slice(1).map(Number);

    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0, pointerId: 1 }));
    canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 0, clientY: 100, pointerId: 1 }));
    const expectedCenter = initialCenter + 100 * (initialWidth / 256);
    await waitFor(() => {
      const after = Number(/window (-?\d+) \//.exec(windowText())?.[1]);
      expect(after).toBeCloseTo(expectedCenter, -1);
    });
  });

  it("width clamps at 1 rather than reaching 0 or going negative", async () => {
    const canvas = await openWithFallback();
    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0, pointerId: 1 }));
    canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: -100000, clientY: 0, pointerId: 1 }));
    await waitFor(() => {
      const after = Number(/window -?\d+ \/ (\d+)/.exec(windowText())?.[1]);
      expect(after).toBe(1);
    });
  });

  it("Reset window restores the file's declared values (pattern-explicit) and the computed fallback (burned-in)", async () => {
    const user = userEvent.setup();
    const getBytes = () => Promise.resolve(toArrayBuffer(readFixture("pattern-explicit.dcm")));
    render(<ImagePreview fileKey="pattern-explicit.dcm" fileLabel="pattern-explicit.dcm" getBytes={getBytes} decode={realDecode} announce={NO_ANNOUNCE} />);
    await user.click(screen.getByRole("button", { name: "Show image" }));
    const canvas = await screen.findByRole("img");
    expect(windowText()).toContain("window 0 / 400"); // pattern-explicit's own declared window

    canvas.focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(windowText()).not.toContain("window 0 / 400"));

    await user.click(screen.getByRole("button", { name: "Reset window" }));
    await waitFor(() => expect(windowText()).toContain("window 0 / 400"));
  });

  it("arrow keys move by initialWidth/64, shift by ten times that", async () => {
    const canvas = await openWithFallback();
    const before = /window (-?\d+) \/ (\d+)/.exec(windowText());
    const [initialCenter, initialWidth] = (before ?? []).slice(1).map(Number);

    canvas.focus();
    await userEvent.setup().keyboard("{ArrowDown}");
    await waitFor(() => {
      const after = Number(/window (-?\d+) \//.exec(windowText())?.[1]);
      expect(after).toBeCloseTo(initialCenter + initialWidth / 64, -1);
    });

    await userEvent.setup().keyboard("{Shift>}{ArrowDown}{/Shift}");
    await waitFor(() => {
      const after = Number(/window (-?\d+) \//.exec(windowText())?.[1]);
      expect(after).toBeCloseTo(initialCenter + initialWidth / 64 + 10 * (initialWidth / 64), -1);
    });
  });

  it("each adjustment issues a decode", async () => {
    const getBytes = () => Promise.resolve(toArrayBuffer(readBurnedIn()));
    const decode = vi.fn(realDecode);
    const user = userEvent.setup();
    render(<ImagePreview fileKey="burned-in.dcm" fileLabel="burned-in.dcm" getBytes={getBytes} decode={decode} announce={NO_ANNOUNCE} />);
    await user.click(screen.getByRole("button", { name: "Show image" }));
    const canvas = await screen.findByRole("img");
    const before = decode.mock.calls.length;

    canvas.focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(decode.mock.calls.length).toBe(before + 1));
  });
});

describe("superseding", () => {
  it("two adjustments in flight: the older resolves superseded, nothing renders for it", async () => {
    const user = userEvent.setup();
    const getBytes = () => Promise.resolve(toArrayBuffer(readBurnedIn()));
    const older = deferred<DecodeOutcome>();
    const newer = deferred<DecodeOutcome>();
    // Call 1: the initial open, resolved for real so the canvas (and its keyboard handler) exists.
    // Calls 2 and 3: the two adjustments below, controlled by hand.
    const decode = vi.fn().mockImplementationOnce(realDecode).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    render(<ImagePreview fileKey="burned-in.dcm" fileLabel="burned-in.dcm" getBytes={getBytes} decode={decode} announce={NO_ANNOUNCE} />);
    await user.click(screen.getByRole("button", { name: "Show image" }));
    const canvas = await screen.findByRole("img");
    canvas.focus();

    await user.keyboard("{ArrowRight}"); // issues the older, still-pending request
    await user.keyboard("{ArrowRight}"); // issues the newer request

    const image = await decodeImage(readFixture("pattern-mono1.dcm"));
    const newerOutcome: DecodeOutcome = { ok: true, width: image.width, height: image.height, rgba: image.rgba.buffer as ArrayBuffer, window: image.window, transferSyntaxUid: image.transferSyntaxUid, frame: image.frame, numberOfFrames: image.numberOfFrames };
    newer.resolve(newerOutcome);
    await waitFor(() => expect(screen.getByRole("img").getAttribute("width")).toBe(String(image.width)));

    // The older request lands afterwards, marked superseded - it must change nothing.
    older.resolve({ ok: false, superseded: true, message: "Superseded by a newer request." });
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByText(/[Ss]uperseded/)).toBeNull();
    expect(screen.getByRole("img").getAttribute("width")).toBe(String(image.width));
  });
});

describe("failures", () => {
  it("a not-ok outcome renders its message in place of the canvas", async () => {
    const user = userEvent.setup();
    const getBytes = () => Promise.resolve(new ArrayBuffer(0));
    const decode = () => Promise.resolve<DecodeOutcome>({ ok: false, message: "bad file, could not be read" });
    render(<ImagePreview fileKey="bad.dcm" fileLabel="bad.dcm" getBytes={getBytes} decode={decode} announce={NO_ANNOUNCE} />);

    await user.click(screen.getByRole("button", { name: "Show image" }));
    expect(await screen.findByText("bad file, could not be read")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("a file with no pixel data reads as a statement, using decodeImage's own wording, with the no-pixel-data appended sentence", async () => {
    const user = userEvent.setup();
    const getBytes = () => Promise.resolve(toArrayBuffer(readBurnedIn().slice())); // placeholder bytes
    const decode = () => Promise.resolve<DecodeOutcome>({ ok: false, reason: "no-pixel-data", message: "No pixel data (7FE0,0010) in this file" });
    render(<ImagePreview fileKey="report.dcm" fileLabel="report.dcm" getBytes={getBytes} decode={decode} announce={NO_ANNOUNCE} />);

    await user.click(screen.getByRole("button", { name: "Show image" }));
    expect(await screen.findByText("No pixel data (7FE0,0010) in this file")).toBeTruthy();
    expect(await screen.findByText("The findings above are complete.")).toBeTruthy();
    // The shorter line, not the "only the preview is unavailable" one - 3.4's wording distinction.
    expect(screen.queryByText(/only the preview is unavailable/)).toBeNull();
  });

  it("an unsupported-syntax outcome carries the longer appended sentence", async () => {
    const user = userEvent.setup();
    const getBytes = () => Promise.resolve(new ArrayBuffer(0));
    const decode = () => Promise.resolve<DecodeOutcome>({ ok: false, reason: "unsupported-syntax", transferSyntaxUid: "1.2.840.10008.1.2.4.90", message: "This image is stored as JPEG 2000 Image Compression (Lossless Only) (1.2.840.10008.1.2.4.90). ScanLint shows uncompressed, RLE and JPEG baseline images." });
    render(<ImagePreview fileKey="jp2.dcm" fileLabel="jp2.dcm" getBytes={getBytes} decode={decode} announce={NO_ANNOUNCE} />);

    await user.click(screen.getByRole("button", { name: "Show image" }));
    expect(await screen.findByText(/JPEG 2000/)).toBeTruthy();
    expect(await screen.findByText("The findings above are complete — only the preview is unavailable.")).toBeTruthy();
  });

  it("an unsupported-format outcome also carries the longer appended sentence", async () => {
    const user = userEvent.setup();
    const getBytes = () => Promise.resolve(new ArrayBuffer(0));
    const decode = () => Promise.resolve<DecodeOutcome>({ ok: false, reason: "unsupported-format", message: "This image is stored as PALETTE COLOR, which ScanLint does not render. ScanLint renders greyscale and interleaved RGB images." });
    render(<ImagePreview fileKey="pal.dcm" fileLabel="pal.dcm" getBytes={getBytes} decode={decode} announce={NO_ANNOUNCE} />);

    await user.click(screen.getByRole("button", { name: "Show image" }));
    expect(await screen.findByText(/PALETTE COLOR/)).toBeTruthy();
    expect(await screen.findByText("The findings above are complete — only the preview is unavailable.")).toBeTruthy();
  });

  it("a plain failure (no reason) carries no appended sentence", async () => {
    const user = userEvent.setup();
    const getBytes = () => Promise.resolve(new ArrayBuffer(0));
    const decode = () => Promise.resolve<DecodeOutcome>({ ok: false, message: "bad file, could not be read" });
    render(<ImagePreview fileKey="bad.dcm" fileLabel="bad.dcm" getBytes={getBytes} decode={decode} announce={NO_ANNOUNCE} />);

    await user.click(screen.getByRole("button", { name: "Show image" }));
    expect(await screen.findByText("bad file, could not be read")).toBeTruthy();
    expect(screen.queryByText(/findings above are complete/)).toBeNull();
  });

  // The whole point of typing `reason` (3.6): a scope limitation and a genuine defect must not look
  // the same, or the type bought nothing.
  it("a reason-carrying outcome and a plain failure render with different styling", async () => {
    const user = userEvent.setup();
    const getBytes = () => Promise.resolve(new ArrayBuffer(0));

    const plainDecode = () => Promise.resolve<DecodeOutcome>({ ok: false, message: "a genuine defect" });
    render(<ImagePreview fileKey="a.dcm" fileLabel="a.dcm" getBytes={getBytes} decode={plainDecode} announce={NO_ANNOUNCE} />);
    await user.click(screen.getByRole("button", { name: "Show image" }));
    const plainMessage = await screen.findByText("a genuine defect");
    cleanup();

    const reasonDecode = () => Promise.resolve<DecodeOutcome>({ ok: false, reason: "unsupported-format", message: "a stated limitation" });
    render(<ImagePreview fileKey="b.dcm" fileLabel="b.dcm" getBytes={getBytes} decode={reasonDecode} announce={NO_ANNOUNCE} />);
    await user.click(screen.getByRole("button", { name: "Show image" }));
    const reasonMessage = await screen.findByText("a stated limitation");

    expect(plainMessage.className).not.toBe(reasonMessage.className);
  });
});

describe("windowless images (3.6)", () => {
  function rgbBytes(): Uint8Array {
    return buildDicom({
      rows: 1,
      columns: 2,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      samplesPerPixel: 3,
      photometricInterpretation: "RGB",
      planarConfiguration: 0,
      pixelData: bytes8([10, 20, 30, 40, 50, 60]),
    });
  }

  it("hides the window segment of the caption, the Reset window button, and the arrow-key hint - and shows the 'no window' line instead", async () => {
    const user = userEvent.setup();
    const getBytes = () => Promise.resolve(toArrayBuffer(rgbBytes()));
    render(<ImagePreview fileKey="rgb.dcm" fileLabel="rgb.dcm" getBytes={getBytes} decode={realDecode} announce={NO_ANNOUNCE} />);
    await user.click(screen.getByRole("button", { name: "Show image" }));
    const img = await screen.findByRole("img");

    expect(screen.getByText(/2 × 1 · uncompressed/).textContent).not.toMatch(/window/);
    expect(screen.queryByRole("button", { name: "Reset window" })).toBeNull();
    expect(screen.getByText("no window to adjust — these pixels are shown as stored")).toBeTruthy();
    expect(img.getAttribute("aria-label")).not.toMatch(/arrow keys/);
  });

  it("a windowed image still shows all three: the window segment, Reset window, and the arrow-key hint", async () => {
    const user = userEvent.setup();
    const getBytes = () => Promise.resolve(toArrayBuffer(readFixture("pattern-explicit.dcm")));
    render(<ImagePreview fileKey="pattern-explicit.dcm" fileLabel="pattern-explicit.dcm" getBytes={getBytes} decode={realDecode} announce={NO_ANNOUNCE} />);
    await user.click(screen.getByRole("button", { name: "Show image" }));
    const img = await screen.findByRole("img");

    expect(windowText()).toMatch(/window -?\d/);
    expect(screen.getByRole("button", { name: "Reset window" })).toBeTruthy();
    expect(img.getAttribute("aria-label")).toMatch(/arrow keys/);
    expect(screen.queryByText("no window to adjust — these pixels are shown as stored")).toBeNull();
  });
});

describe("stepping between slices", () => {
  it("shows the counter, disables at each end, and calls the right callback", async () => {
    const user = userEvent.setup();
    const getBytes = () => Promise.resolve(toArrayBuffer(readFixture("pattern-explicit.dcm")));
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    render(
      <ImagePreview
        fileKey="a.dcm"
        fileLabel="a.dcm"
        getBytes={getBytes}
        decode={realDecode}
        announce={NO_ANNOUNCE}
        stepping={{ label: "Slice 1 of 3", hasPrevious: false, hasNext: true, onPrevious, onNext }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Show image" }));

    expect(await screen.findByText("Slice 1 of 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous slice" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Next slice" })).toHaveProperty("disabled", false);

    await user.click(screen.getByRole("button", { name: "Next slice" }));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrevious).not.toHaveBeenCalled();
  });

  it("keeps the previous image on the canvas while the next slice decodes", async () => {
    const user = userEvent.setup();
    const first = toArrayBuffer(readFixture("pattern-explicit.dcm"));
    const secondDeferred = deferred<DecodeOutcome>();
    const decode = vi.fn().mockImplementationOnce(realDecode).mockReturnValueOnce(secondDeferred.promise);
    const getBytes = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(new ArrayBuffer(0));

    const { rerender } = render(
      <ImagePreview fileKey="a.dcm" fileLabel="a.dcm" getBytes={getBytes} decode={decode} announce={NO_ANNOUNCE} stepping={{ label: "Slice 1 of 2", hasPrevious: false, hasNext: true, onPrevious: () => {}, onNext: () => {} }} />,
    );
    await user.click(screen.getByRole("button", { name: "Show image" }));
    const canvas = await screen.findByRole("img");
    const widthBefore = canvas.getAttribute("width");

    rerender(
      <ImagePreview fileKey="b.dcm" fileLabel="b.dcm" getBytes={getBytes} decode={decode} announce={NO_ANNOUNCE} stepping={{ label: "Slice 2 of 2", hasPrevious: true, hasNext: false, onPrevious: () => {}, onNext: () => {} }} />,
    );

    // Still decoding the new slice: the old image's canvas is untouched.
    expect(screen.getByRole("img").getAttribute("width")).toBe(widthBefore);
    expect(screen.queryByText("Decoding…")).toBeNull();

    const image = await decodeImage(readFixture("pattern-mono1.dcm"));
    secondDeferred.resolve({ ok: true, width: image.width, height: image.height, rgba: image.rgba.buffer as ArrayBuffer, window: image.window, transferSyntaxUid: image.transferSyntaxUid, frame: image.frame, numberOfFrames: image.numberOfFrames });
    await waitFor(() => expect(screen.getByText("Slice 2 of 2")).toBeTruthy());
  });

  // 3.4a: someone stepping through a series to find faint text would otherwise have to find the
  // window again on every slice. pattern-explicit.dcm (declared 0/400) and burned-in.dcm (no
  // declared window, so its own fallback is a very different ~2150/3891) make an adjustment and a
  // reset observably different, which a same-window pair of fixtures could not.
  it("carries an adjusted window across a step, and Reset returns to the new slice's own value", async () => {
    const user = userEvent.setup();
    const getBytes = vi
      .fn()
      .mockResolvedValueOnce(toArrayBuffer(readFixture("pattern-explicit.dcm"))) // the initial open
      .mockResolvedValueOnce(toArrayBuffer(readFixture("pattern-explicit.dcm"))) // the arrow-key adjustment re-reads it
      .mockResolvedValueOnce(toArrayBuffer(readBurnedIn())) // stepping to the next slice
      .mockResolvedValueOnce(toArrayBuffer(readBurnedIn())); // Reset re-reads the (current) file fresh

    const { rerender } = render(
      <ImagePreview
        fileKey="pattern-explicit.dcm"
        fileLabel="pattern-explicit.dcm"
        getBytes={getBytes}
        decode={realDecode}
        announce={NO_ANNOUNCE}
        stepping={{ label: "Slice 1 of 2", hasPrevious: false, hasNext: true, onPrevious: () => {}, onNext: () => {} }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Show image" }));
    const canvas = await screen.findByRole("img");
    expect(windowText()).toContain("window 0 / 400");

    canvas.focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(windowText()).toContain("window 0 / 406"));

    // Step to the next slice: the adjusted window (0 / 406) must survive, not reset to burned-in's
    // own fallback (~2150 / 3891).
    rerender(
      <ImagePreview
        fileKey="burned-in.dcm"
        fileLabel="burned-in.dcm"
        getBytes={getBytes}
        decode={realDecode}
        announce={NO_ANNOUNCE}
        stepping={{ label: "Slice 2 of 2", hasPrevious: true, hasNext: false, onPrevious: () => {}, onNext: () => {} }}
      />,
    );
    await waitFor(() => expect(screen.getByText("Slice 2 of 2")).toBeTruthy());
    expect(windowText()).toContain("window 0 / 406");

    // Reset returns to this (new) slice's own value, not pattern-explicit's and not the carried one.
    await user.click(screen.getByRole("button", { name: "Reset window" }));
    await waitFor(() => expect(windowText()).toContain("window 2150 / 3891"));
  });
});

// 3.8: frames. multiframe-burned-in.dcm is native (real decode, real window, real distinguishable
// frames) and is used for almost everything below; multiframe-jpeg.dcm (no window, by design) covers
// the one thing it cannot: a multi-frame file with no window segment at all.
describe("frames (3.8)", () => {
  function stubJpegDecoder() {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 64, height: 64, close: vi.fn() })),
    );
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext() {
          return { drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4) }) };
        }
      },
    );
  }
  afterEach(() => vi.unstubAllGlobals());

  // Anchored and case-sensitive so it matches only the stepping counter's own span ("Frame 3 of 3"),
  // not the caption's lowercase "· frame 3 of 3" segment - both contain the same digits.
  function frameText(): string {
    return screen.getByText(/^Frame \d+ of \d+$/).textContent ?? "";
  }

  // windowText() returns the whole caption, which also carries the frame number - comparing two
  // whole captions to check "the window didn't change" would fail the moment the frame does. This
  // pulls out just the window segment.
  function windowOnly(): string {
    return windowText().match(/window -?\d+ \/ -?\d+/)?.[0] ?? "";
  }

  describe("the caption", () => {
    it("a multi-frame file shows the frame segment, between the dimensions and the transfer syntax", async () => {
      const user = userEvent.setup();
      const getBytes = () => Promise.resolve(toArrayBuffer(readFixture("multiframe-burned-in.dcm")));
      render(<ImagePreview fileKey="multiframe-burned-in.dcm" fileLabel="multiframe-burned-in.dcm" getBytes={getBytes} decode={realDecode} announce={NO_ANNOUNCE} />);
      await user.click(screen.getByRole("button", { name: "Show image" }));
      await screen.findByRole("img");

      const caption = screen.getByText(/128 × 128/).textContent ?? "";
      const dimIdx = caption.indexOf("128 × 128");
      const frameIdx = caption.indexOf("frame 1 of 3");
      const syntaxIdx = caption.indexOf("uncompressed");
      expect(dimIdx).toBeGreaterThanOrEqual(0);
      expect(frameIdx).toBeGreaterThan(dimIdx);
      expect(syntaxIdx).toBeGreaterThan(frameIdx);
    });

    it("a single-frame file shows no frame segment", async () => {
      const user = userEvent.setup();
      const getBytes = () => Promise.resolve(toArrayBuffer(readFixture("pattern-explicit.dcm")));
      render(<ImagePreview fileKey="pattern-explicit.dcm" fileLabel="pattern-explicit.dcm" getBytes={getBytes} decode={realDecode} announce={NO_ANNOUNCE} />);
      await user.click(screen.getByRole("button", { name: "Show image" }));
      await screen.findByRole("img");

      expect(screen.queryByText(/frame \d+ of \d+/i)).toBeNull();
    });

    it("a multi-frame file with no window shows no window segment and still shows the frame segment", async () => {
      stubJpegDecoder();
      const user = userEvent.setup();
      const getBytes = () => Promise.resolve(toArrayBuffer(readFixture("multiframe-jpeg.dcm")));
      render(<ImagePreview fileKey="multiframe-jpeg.dcm" fileLabel="multiframe-jpeg.dcm" getBytes={getBytes} decode={realDecode} announce={NO_ANNOUNCE} />);
      await user.click(screen.getByRole("button", { name: "Show image" }));
      await screen.findByRole("img");

      expect(screen.getByText(/frame 1 of 3/)).toBeTruthy();
      expect(screen.queryByText(/· window/)).toBeNull(); // the "no window to adjust" line below also says "window"
      expect(screen.getByText("no window to adjust — these pixels are shown as stored")).toBeTruthy();
    });
  });

  describe("stepping", () => {
    async function openMultiframeBurnedIn(decode = realDecode) {
      const user = userEvent.setup();
      const getBytes = () => Promise.resolve(toArrayBuffer(readFixture("multiframe-burned-in.dcm")));
      render(<ImagePreview fileKey="multiframe-burned-in.dcm" fileLabel="multiframe-burned-in.dcm" getBytes={getBytes} decode={decode} announce={NO_ANNOUNCE} />);
      await user.click(screen.getByRole("button", { name: "Show image" }));
      const canvas = await screen.findByRole("img");
      return { user, canvas };
    }

    it("the counter reads correctly, disables at each end, and neither wraps", async () => {
      const { user } = await openMultiframeBurnedIn();
      expect(frameText()).toBe("Frame 1 of 3");
      expect(screen.getByRole("button", { name: "Previous frame" })).toHaveProperty("disabled", true);
      expect(screen.getByRole("button", { name: "Next frame" })).toHaveProperty("disabled", false);

      await user.click(screen.getByRole("button", { name: "Next frame" }));
      await waitFor(() => expect(frameText()).toBe("Frame 2 of 3"));
      await user.click(screen.getByRole("button", { name: "Next frame" }));
      await waitFor(() => expect(frameText()).toBe("Frame 3 of 3"));
      expect(screen.getByRole("button", { name: "Next frame" })).toHaveProperty("disabled", true);

      // Clicking a disabled button is a no-op, not a wrap to frame 1.
      await user.click(screen.getByRole("button", { name: "Next frame" }));
      expect(frameText()).toBe("Frame 3 of 3");

      await user.click(screen.getByRole("button", { name: "Previous frame" }));
      await waitFor(() => expect(frameText()).toBe("Frame 2 of 3"));
    });

    it("each step issues exactly one decode, with the right frame", async () => {
      const decode = vi.fn(realDecode);
      const { user } = await openMultiframeBurnedIn(decode);
      const before = decode.mock.calls.length;

      await user.click(screen.getByRole("button", { name: "Next frame" }));
      await waitFor(() => expect(frameText()).toBe("Frame 2 of 3"));
      expect(decode.mock.calls.length).toBe(before + 1);
      expect(decode.mock.calls.at(-1)?.[1]).toMatchObject({ frame: 1 });
    });

    it("the previous frame stays on the canvas while the next decodes", async () => {
      const getBytes = () => Promise.resolve(toArrayBuffer(readFixture("multiframe-burned-in.dcm")));
      const user = userEvent.setup();
      const next = deferred<DecodeOutcome>();
      const decode = vi.fn().mockImplementationOnce(realDecode).mockReturnValueOnce(next.promise);
      render(<ImagePreview fileKey="multiframe-burned-in.dcm" fileLabel="multiframe-burned-in.dcm" getBytes={getBytes} decode={decode} announce={NO_ANNOUNCE} />);
      await user.click(screen.getByRole("button", { name: "Show image" }));
      await screen.findByRole("img");

      await user.click(screen.getByRole("button", { name: "Next frame" }));
      expect(frameText()).toBe("Frame 1 of 3"); // still decoding frame 2 - the old frame's own label stays
      expect(screen.queryByText("Decoding…")).toBeNull(); // 3.4's own rule: no spinner while an image is already in hand

      const image = await decodeImage(readFixture("multiframe-burned-in.dcm"), { frame: 1 });
      next.resolve({ ok: true, width: image.width, height: image.height, rgba: image.rgba.buffer as ArrayBuffer, window: image.window, transferSyntaxUid: image.transferSyntaxUid, frame: image.frame, numberOfFrames: image.numberOfFrames });
      await waitFor(() => expect(frameText()).toBe("Frame 2 of 3"));
    });

    it("PageDown, PageUp, Home and End move frames and do not adjust the window", async () => {
      const { user, canvas } = await openMultiframeBurnedIn();
      const windowBefore = windowOnly();
      canvas.focus();

      await user.keyboard("{PageDown}");
      await waitFor(() => expect(frameText()).toBe("Frame 2 of 3"));
      expect(windowOnly()).toBe(windowBefore);

      await user.keyboard("{End}");
      await waitFor(() => expect(frameText()).toBe("Frame 3 of 3"));
      expect(windowOnly()).toBe(windowBefore);

      await user.keyboard("{PageUp}");
      await waitFor(() => expect(frameText()).toBe("Frame 2 of 3"));

      await user.keyboard("{Home}");
      await waitFor(() => expect(frameText()).toBe("Frame 1 of 3"));
      expect(windowOnly()).toBe(windowBefore);
    });

    it("the arrow keys still adjust the window and do not move frames", async () => {
      const { user, canvas } = await openMultiframeBurnedIn();
      canvas.focus();

      await user.keyboard("{ArrowRight}");
      await waitFor(() => expect(windowText()).not.toBe("window 2150 / 3891"));
      expect(frameText()).toBe("Frame 1 of 3");
    });
  });

  describe("both axes", () => {
    const STEPPING = { label: "Slice 1 of 2", hasPrevious: false, hasNext: true, onPrevious: () => {}, onNext: () => {} };

    it("a multi-frame file reached from a series renders both control pairs", async () => {
      const user = userEvent.setup();
      const getBytes = () => Promise.resolve(toArrayBuffer(readFixture("multiframe-burned-in.dcm")));
      render(<ImagePreview fileKey="multiframe-burned-in.dcm" fileLabel="multiframe-burned-in.dcm" getBytes={getBytes} decode={realDecode} announce={NO_ANNOUNCE} stepping={STEPPING} />);
      await user.click(screen.getByRole("button", { name: "Show image" }));
      await screen.findByRole("img");

      expect(screen.getByRole("button", { name: "Previous frame" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Next frame" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Previous slice" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Next slice" })).toBeTruthy();
      expect(screen.getByText("Frame 1 of 3")).toBeTruthy();
      expect(screen.getByText("Slice 1 of 2")).toBeTruthy();
    });

    it("a single-frame file in a series renders only the slice pair", async () => {
      const user = userEvent.setup();
      const getBytes = () => Promise.resolve(toArrayBuffer(readFixture("pattern-explicit.dcm")));
      render(<ImagePreview fileKey="pattern-explicit.dcm" fileLabel="pattern-explicit.dcm" getBytes={getBytes} decode={realDecode} announce={NO_ANNOUNCE} stepping={STEPPING} />);
      await user.click(screen.getByRole("button", { name: "Show image" }));
      await screen.findByRole("img");

      expect(screen.queryByRole("button", { name: "Previous frame" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Next frame" })).toBeNull();
      expect(screen.getByRole("button", { name: "Previous slice" })).toBeTruthy();
    });

    it("a standalone multi-frame file (no stepping prop) renders only the frame pair", async () => {
      const user = userEvent.setup();
      const getBytes = () => Promise.resolve(toArrayBuffer(readFixture("multiframe-burned-in.dcm")));
      render(<ImagePreview fileKey="multiframe-burned-in.dcm" fileLabel="multiframe-burned-in.dcm" getBytes={getBytes} decode={realDecode} announce={NO_ANNOUNCE} />);
      await user.click(screen.getByRole("button", { name: "Show image" }));
      await screen.findByRole("img");

      expect(screen.getByRole("button", { name: "Next frame" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Next slice" })).toBeNull();
    });

  });

  // 3.8a: the step 3.8 shipped clamped the *displayed* frame for a shorter file correctly, but also
  // overwrote the *requested* one with the clamped value - so the original request was gone for
  // good the moment a reader passed through one shorter file, including a single-frame file with no
  // control on screen to even show the clamp happened. These tests cover the fix: requestedFrame is
  // written only by the frame controls themselves (always from what's displayed, never from the old
  // request), and the slice-step effect only ever reads it.
  describe("what a slice step remembers about the requested frame (3.8a)", () => {
    function multiFrameBytes(frames: number[]): Uint8Array {
      return buildDicom({
        rows: 1,
        columns: 1,
        bitsAllocated: 8,
        bitsStored: 8,
        highBit: 7,
        samplesPerPixel: 1,
        photometricInterpretation: "MONOCHROME2",
        numberOfFrames: frames.length,
        windowCenter: 128,
        windowWidth: 256,
        pixelData: bytes8(frames),
      });
    }

    function singleFrameBytes(value: number): Uint8Array {
      return buildDicom({
        rows: 1,
        columns: 1,
        bitsAllocated: 8,
        bitsStored: 8,
        highBit: 7,
        samplesPerPixel: 1,
        photometricInterpretation: "MONOCHROME2",
        windowCenter: 128,
        windowWidth: 256,
        pixelData: bytes8([value]),
      });
    }

    it("a shorter file in between clamps the display but not the request - the next long-enough file restores it", async () => {
      const user = userEvent.setup();
      const fileA = multiFrameBytes([0, 1, 2, 3, 4]); // 5 frames
      const fileB = multiFrameBytes([10, 20]); // 2 frames
      const getBytes = vi
        .fn()
        .mockResolvedValueOnce(toArrayBuffer(fileA)) // open: frame 1 of 5
        .mockResolvedValueOnce(toArrayBuffer(fileA)) // Next frame x3 -> frame 4 of 5
        .mockResolvedValueOnce(toArrayBuffer(fileA))
        .mockResolvedValueOnce(toArrayBuffer(fileA))
        .mockResolvedValueOnce(toArrayBuffer(fileB)) // step to B: learn its count (2)
        .mockResolvedValueOnce(toArrayBuffer(fileB)) // corrective decode, clamped to frame 2 of 2
        .mockResolvedValueOnce(toArrayBuffer(fileA)) // step back to A: learn its count (5)
        .mockResolvedValueOnce(toArrayBuffer(fileA)); // corrective decode, restored to frame 4 of 5

      const { rerender } = render(<ImagePreview fileKey="a.dcm" fileLabel="a.dcm" getBytes={getBytes} decode={realDecode} announce={NO_ANNOUNCE} />);
      await user.click(screen.getByRole("button", { name: "Show image" }));
      await screen.findByRole("img");
      for (let i = 0; i < 3; i++) {
        await user.click(screen.getByRole("button", { name: "Next frame" }));
        await waitFor(() => expect(frameText()).toBe(`Frame ${i + 2} of 5`));
      }
      expect(frameText()).toBe("Frame 4 of 5"); // requested = 3 (0-indexed)

      rerender(<ImagePreview fileKey="b.dcm" fileLabel="b.dcm" getBytes={getBytes} decode={realDecode} announce={NO_ANNOUNCE} />);
      await waitFor(() => expect(frameText()).toBe("Frame 2 of 2")); // clamped display; request still 3

      rerender(<ImagePreview fileKey="a.dcm" fileLabel="a.dcm" getBytes={getBytes} decode={realDecode} announce={NO_ANNOUNCE} />);
      await waitFor(() => expect(frameText()).toBe("Frame 4 of 5")); // restored, not stuck at 2
    });

    it("using a frame control while clamped collapses the request to the display - a later file does not restore the old one", async () => {
      const user = userEvent.setup();
      const fileA = multiFrameBytes([0, 1, 2, 3, 4]); // 5 frames
      const fileB = multiFrameBytes([10, 20]); // 2 frames
      const getBytes = vi
        .fn()
        .mockResolvedValueOnce(toArrayBuffer(fileA)) // open: frame 1 of 5
        .mockResolvedValueOnce(toArrayBuffer(fileA)) // Next frame x3 -> frame 4 of 5
        .mockResolvedValueOnce(toArrayBuffer(fileA))
        .mockResolvedValueOnce(toArrayBuffer(fileA))
        .mockResolvedValueOnce(toArrayBuffer(fileB)) // step to B: learn its count (2)
        .mockResolvedValueOnce(toArrayBuffer(fileB)) // corrective decode, clamped to frame 2 of 2
        .mockResolvedValueOnce(toArrayBuffer(fileB)) // Previous frame on B -> frame 1 of 2, request now 0
        .mockResolvedValueOnce(toArrayBuffer(fileA)); // step back to A: request is 0, single direct decode

      const { rerender } = render(<ImagePreview fileKey="a.dcm" fileLabel="a.dcm" getBytes={getBytes} decode={realDecode} announce={NO_ANNOUNCE} />);
      await user.click(screen.getByRole("button", { name: "Show image" }));
      await screen.findByRole("img");
      for (let i = 0; i < 3; i++) {
        await user.click(screen.getByRole("button", { name: "Next frame" }));
      }
      await waitFor(() => expect(frameText()).toBe("Frame 4 of 5"));

      rerender(<ImagePreview fileKey="b.dcm" fileLabel="b.dcm" getBytes={getBytes} decode={realDecode} announce={NO_ANNOUNCE} />);
      await waitFor(() => expect(frameText()).toBe("Frame 2 of 2"));

      await user.click(screen.getByRole("button", { name: "Previous frame" }));
      await waitFor(() => expect(frameText()).toBe("Frame 1 of 2")); // the reader's own choice: request is now 0

      rerender(<ImagePreview fileKey="a.dcm" fileLabel="a.dcm" getBytes={getBytes} decode={realDecode} announce={NO_ANNOUNCE} />);
      await waitFor(() => expect(frameText()).toBe("Frame 1 of 5")); // not restored to 4 - the control reset the request
    });

    it("a single-frame slice in between - with no frame control on screen to show the clamp - still does not erase the request", async () => {
      const user = userEvent.setup();
      const fileA = multiFrameBytes([0, 1, 2]); // 3 frames
      const single = singleFrameBytes(99);
      const getBytes = vi
        .fn()
        .mockResolvedValueOnce(toArrayBuffer(fileA)) // open: frame 1 of 3
        .mockResolvedValueOnce(toArrayBuffer(fileA)) // Next frame x2 -> frame 3 of 3
        .mockResolvedValueOnce(toArrayBuffer(fileA))
        .mockResolvedValueOnce(toArrayBuffer(single)) // step to the single-frame file: clamps to 0, no corrective decode needed
        .mockResolvedValueOnce(toArrayBuffer(fileA)) // step back to A: learn its count (3)
        .mockResolvedValueOnce(toArrayBuffer(fileA)); // corrective decode, restored to frame 3 of 3

      const { rerender } = render(<ImagePreview fileKey="a.dcm" fileLabel="a.dcm" getBytes={getBytes} decode={realDecode} announce={NO_ANNOUNCE} />);
      await user.click(screen.getByRole("button", { name: "Show image" }));
      await screen.findByRole("img");
      await user.click(screen.getByRole("button", { name: "Next frame" }));
      await user.click(screen.getByRole("button", { name: "Next frame" }));
      await waitFor(() => expect(frameText()).toBe("Frame 3 of 3"));

      rerender(<ImagePreview fileKey="single.dcm" fileLabel="single.dcm" getBytes={getBytes} decode={realDecode} announce={NO_ANNOUNCE} />);
      await waitFor(() => expect(screen.queryByText(/^Frame \d+ of \d+$/)).toBeNull()); // no control at all
      expect(screen.queryByText(/frame \d+ of \d+/)).toBeNull(); // no caption segment either

      rerender(<ImagePreview fileKey="a.dcm" fileLabel="a.dcm" getBytes={getBytes} decode={realDecode} announce={NO_ANNOUNCE} />);
      await waitFor(() => expect(frameText()).toBe("Frame 3 of 3")); // restored, even though nothing showed the clamp
    });
  });
});
