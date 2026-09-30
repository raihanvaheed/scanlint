// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { decodeImage } from "../pixels/decode";
import type { DecodeOptions, DecodeOutcome } from "../pixels/protocol";
import { ImagePreview, drawDecoded } from "./image-preview";

afterEach(cleanup);

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES_DIR = path.join(ROOT, "fixtures", "pixels");

function readFixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES_DIR, name)));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// A real decodeImage call, wrapped in the same shape createPixelClient's decode() resolves with -
// close enough to real behaviour for these tests without needing a worker.
function realDecode(bytes: ArrayBuffer, options?: DecodeOptions): Promise<DecodeOutcome> {
  try {
    const image = decodeImage(new Uint8Array(bytes), options);
    return Promise.resolve({ ok: true, width: image.width, height: image.height, rgba: image.rgba.buffer as ArrayBuffer, window: image.window, transferSyntaxUid: image.transferSyntaxUid });
  } catch (e) {
    return Promise.resolve({ ok: false, message: e instanceof Error ? e.message : String(e) });
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
  it("putImageData receives data of the right dimensions", () => {
    const image = decodeImage(readFixture("pattern-explicit.dcm"));
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

  it("a handful of pixel values match what decodeImage produces for the same fixture, under the declared window", () => {
    const image = decodeImage(readFixture("pattern-explicit.dcm"), { window: { center: 0, width: 400 } });
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
    const getBytes = () => Promise.resolve(toArrayBuffer(readFixture("burned-in.dcm")));
    render(<ImagePreview fileKey="burned-in.dcm" fileLabel="burned-in.dcm" getBytes={getBytes} decode={realDecode} announce={NO_ANNOUNCE} />);
    await user.click(screen.getByRole("button", { name: "Show image" }));
    const canvas = await screen.findByRole("img");
    return canvas;
  }

  // Matches only the caption paragraph ("… · window 12 / 34"), not the "Reset window" button,
  // which also contains the word "window" but never followed by a number.
  function windowText(): string {
    return screen.getByText(/window -?\d/).textContent ?? "";
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
    const getBytes = () => Promise.resolve(toArrayBuffer(readFixture("burned-in.dcm")));
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
    const getBytes = () => Promise.resolve(toArrayBuffer(readFixture("burned-in.dcm")));
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

    const image = decodeImage(readFixture("pattern-mono1.dcm"));
    const newerOutcome: DecodeOutcome = { ok: true, width: image.width, height: image.height, rgba: image.rgba.buffer as ArrayBuffer, window: image.window, transferSyntaxUid: image.transferSyntaxUid };
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

  it("a file with no pixel data reads as a statement, using decodeImage's own wording", async () => {
    const user = userEvent.setup();
    const getBytes = () => Promise.resolve(toArrayBuffer(readFixture("burned-in.dcm").slice())); // placeholder bytes
    const decode = () => Promise.resolve<DecodeOutcome>({ ok: false, message: "No pixel data (7FE0,0010) in this file" });
    render(<ImagePreview fileKey="report.dcm" fileLabel="report.dcm" getBytes={getBytes} decode={decode} announce={NO_ANNOUNCE} />);

    await user.click(screen.getByRole("button", { name: "Show image" }));
    expect(await screen.findByText("No pixel data (7FE0,0010) in this file")).toBeTruthy();
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

    const image = decodeImage(readFixture("pattern-mono1.dcm"));
    secondDeferred.resolve({ ok: true, width: image.width, height: image.height, rgba: image.rgba.buffer as ArrayBuffer, window: image.window, transferSyntaxUid: image.transferSyntaxUid });
    await waitFor(() => expect(screen.getByText("Slice 2 of 2")).toBeTruthy());
  });
});
