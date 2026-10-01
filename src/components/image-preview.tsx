"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import type { DecodedImage, WindowSetting } from "../pixels/decode";
import type { DecodeOptions, DecodeOutcome, DecodeReason } from "../pixels/protocol";
import { FOCUS_RING } from "./focus";

export type SteppingProps = {
  /** e.g. "Slice 4 of 10". */
  label: string;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
};

export type ImagePreviewProps = {
  /** A stable identity for the file currently open - the map key a series drill-down already uses,
   * or the top-level flow's file name. Changing it (stepping to a different slice) is what tells
   * the preview to decode a new file while keeping the old image on screen until that finishes. */
  fileKey: string;
  /** The name shown in the canvas's accessible name. May differ from `fileKey` (a relative path vs
   * a bare name), but identifies the same file. */
  fileLabel: string;
  /** Re-reads the file fresh. Called again for every decode - the pixel path re-parses independently
   * each time (see 3.2/3.3), so nothing here is ever reused across calls. */
  getBytes: () => Promise<ArrayBuffer>;
  decode: (bytes: ArrayBuffer, options?: DecodeOptions) => Promise<DecodeOutcome>;
  announce: (message: string) => void;
  /** Only when this slice was reached from a series (section 6). */
  stepping?: SteppingProps;
};

type Phase = "idle" | "decoding" | "ready" | "error";

// Section 8's debounce for the window announcement: long enough to swallow a drag's flurry of
// updates, short enough that the announcement still feels tied to the gesture that ended it.
const ANNOUNCE_DEBOUNCE_MS = 400;

const TRANSFER_SYNTAX_WORDS: Record<string, string> = {
  "1.2.840.10008.1.2": "uncompressed",
  "1.2.840.10008.1.2.1": "uncompressed",
  "1.2.840.10008.1.2.5": "RLE compressed",
  "1.2.840.10008.1.2.4.50": "JPEG compressed",
};

function formatTransferSyntax(uid: string): string {
  return TRANSFER_SYNTAX_WORDS[uid] ?? uid;
}

function formatWindow(window: WindowSetting): string {
  return `${Math.round(window.center)} / ${Math.round(window.width)}`;
}

// Not part of any one message (3.6): a reader who sees a bare failure where the preview should be
// may reasonably conclude the whole analysis failed and distrust findings that are in fact complete
// - the worse of the two errors, for a tool whose entire claim is about what it found in the
// metadata. True wherever it appears, since the preview only ever renders after a successful parse -
// so it is appended structurally, in this one place, rather than baked into each thrown message
// (where it would drift the first time someone edited one). `no-pixel-data` gets the shorter line:
// "only the preview is unavailable" implies something was withheld, and a DICOMDIR never had an
// image to withhold.
const APPENDED_SENTENCE: Record<DecodeReason, string> = {
  "unsupported-syntax": "The findings above are complete — only the preview is unavailable.",
  "unsupported-format": "The findings above are complete — only the preview is unavailable.",
  "no-pixel-data": "The findings above are complete.",
};

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Draws a decoded frame to a canvas. Pulled out of the component so it can be tested without a
 * real canvas: happy-dom's 2D context is not usable, and the component tests supply a fake one.
 */
export function drawDecoded(ctx: CanvasRenderingContext2D, image: DecodedImage): void {
  ctx.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height), 0, 0);
}

export function ImagePreview({ fileKey, fileLabel, getBytes, decode, announce, stepping }: ImagePreviewProps) {
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [image, setImage] = useState<DecodedImage | null>(null);
  const [message, setMessage] = useState("");
  const [reason, setReason] = useState<DecodeReason | undefined>(undefined);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const windowOverride = useRef<WindowSetting | null>(null);
  const dragStart = useRef<{ x: number; y: number; window: WindowSetting } | null>(null);
  const requestSeq = useRef(0);

  // A new slice: carries the current window across (3.4a) - someone stepping through a series to
  // find faint text would otherwise have to find it again on every slice, which defeats the reason
  // they were stepping. `windowOverride` is left exactly as it is; `null` (never adjusted) still
  // lets the new slice pick its own declared value or fallback, same as before. The old image stays
  // exactly where it is (state untouched) until this one resolves.
  useEffect(() => {
    if (visible) void runDecode(windowOverride.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey]);

  useLayoutEffect(() => {
    if (!image) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) drawDecoded(ctx, image);
  }, [image]);

  // Debounced per section 8: a live region that fired on every drag update would be unusable.
  useEffect(() => {
    if (!image?.window) return;
    const text = `Window ${formatWindow(image.window)}`;
    const timer = setTimeout(() => announce(text), ANNOUNCE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image?.window?.center, image?.window?.width]);

  async function runDecode(window: WindowSetting | null) {
    const seq = ++requestSeq.current;
    setPhase("decoding");
    let bytes: ArrayBuffer;
    try {
      bytes = await getBytes();
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setPhase("error");
      setMessage(messageOf(e));
      setReason(undefined);
      return;
    }
    const outcome = await decode(bytes, window ? { window } : undefined);
    if (seq !== requestSeq.current) return; // a newer runDecode call has since started

    if (!outcome.ok) {
      if ("superseded" in outcome && outcome.superseded) return; // section 7: nothing rendered
      setPhase("error");
      setMessage(outcome.message);
      setReason("reason" in outcome ? outcome.reason : undefined);
      return;
    }
    setImage({ width: outcome.width, height: outcome.height, rgba: new Uint8ClampedArray(outcome.rgba), window: outcome.window, transferSyntaxUid: outcome.transferSyntaxUid });
    setPhase("ready");
  }

  function applyWindow(next: WindowSetting) {
    windowOverride.current = next;
    void runDecode(next);
  }

  function onToggle() {
    const next = !visible;
    setVisible(next);
    // Opening it is what starts the worker - never decode while closed, and never decode again on
    // reopen if the image (or an in-flight decode) is already in hand.
    if (next && phase === "idle") void runDecode(null);
  }

  function onReset() {
    windowOverride.current = null;
    void runDecode(null);
  }

  function onPointerDown(e: PointerEvent<HTMLCanvasElement>) {
    if (!image?.window) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = { x: e.clientX, y: e.clientY, window: image.window };
  }

  function onPointerMove(e: PointerEvent<HTMLCanvasElement>) {
    const start = dragStart.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const sensitivity = start.window.width / 256;
    applyWindow({ width: Math.max(1, start.window.width + dx * sensitivity), center: start.window.center + dy * sensitivity });
  }

  function onPointerUp(e: PointerEvent<HTMLCanvasElement>) {
    if (dragStart.current) e.currentTarget.releasePointerCapture(e.pointerId);
    dragStart.current = null;
  }

  function onKeyDown(e: KeyboardEvent<HTMLCanvasElement>) {
    if (!image?.window) return;
    const step = (image.window.width / 64) * (e.shiftKey ? 10 : 1);
    if (e.key === "ArrowLeft") applyWindow({ center: image.window.center, width: Math.max(1, image.window.width - step) });
    else if (e.key === "ArrowRight") applyWindow({ center: image.window.center, width: Math.max(1, image.window.width + step) });
    else if (e.key === "ArrowUp") applyWindow({ center: image.window.center - step, width: image.window.width });
    else if (e.key === "ArrowDown") applyWindow({ center: image.window.center + step, width: image.window.width });
    else return;
    e.preventDefault();
  }

  if (!visible) {
    return (
      <button type="button" onClick={onToggle} aria-expanded={false} className={`mt-4 cursor-pointer rounded-md border-2 border-shade px-4 py-1.5 text-ink hover:border-signal ${FOCUS_RING}`}>
        Show image
      </button>
    );
  }

  return (
    <div className="mt-4">
      <button type="button" onClick={onToggle} aria-expanded={true} className={`cursor-pointer rounded-md border-2 border-shade px-4 py-1.5 text-ink hover:border-signal ${FOCUS_RING}`}>
        Hide image
      </button>

      {phase === "decoding" && image === null && <p className="mt-4 text-ink motion-safe:animate-pulse">Decoding…</p>}

      {phase === "error" && (
        <>
          {/* A reason-carrying outcome is a stated scope limitation, not a defect - the same
              neutral, muted treatment as the burned-in caveat line (see single-file-result.tsx).
              A plain failure (no reason) is a genuine defect in the file, and reads differently -
              text-ink, not text-shade - so the two cannot be mistaken for each other. Before 3.6,
              both rendered identically in text-shade; there was no distinct "error" styling to tell
              them apart with. */}
          <p className={`mt-4 break-words text-sm ${reason ? "text-shade" : "text-ink"}`}>{message}</p>
          {reason && <p className="mt-1 break-words text-sm text-shade">{APPENDED_SENTENCE[reason]}</p>}
        </>
      )}

      {image !== null && (
        <div className="mt-4">
          <canvas
            ref={canvasRef}
            width={image.width}
            height={image.height}
            tabIndex={0}
            role="img"
            aria-label={
              image.window
                ? `Decoded image of ${fileLabel}. This is medical pixel data and cannot otherwise be described. When focused, arrow keys adjust brightness and contrast; hold shift for larger steps.`
                : `Decoded image of ${fileLabel}. This is medical pixel data and cannot otherwise be described.`
            }
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
            style={{ imageRendering: "pixelated", aspectRatio: `${image.width} / ${image.height}` }}
            className={`w-full max-w-[512px] cursor-crosshair touch-none rounded border border-rule ${FOCUS_RING}`}
          />
          <p className="mt-2 text-sm text-shade">
            {`${image.width} × ${image.height} · ${formatTransferSyntax(image.transferSyntaxUid)}`}
            {image.window && ` · window ${formatWindow(image.window)}`}
          </p>
          {image.window ? (
            <button type="button" onClick={onReset} className={`mt-2 cursor-pointer rounded-md border-2 border-shade px-4 py-1.5 text-ink hover:border-signal ${FOCUS_RING}`}>
              Reset window
            </button>
          ) : (
            <p className="mt-2 text-sm text-shade">no window to adjust — these pixels are shown as stored</p>
          )}
        </div>
      )}

      {stepping && (
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <button
            type="button"
            disabled={!stepping.hasPrevious}
            onClick={stepping.onPrevious}
            className={`cursor-pointer rounded-md border-2 border-shade px-4 py-1.5 text-ink hover:border-signal disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-shade ${FOCUS_RING}`}
          >
            Previous slice
          </button>
          <span className="text-sm text-shade">{stepping.label}</span>
          <button
            type="button"
            disabled={!stepping.hasNext}
            onClick={stepping.onNext}
            className={`cursor-pointer rounded-md border-2 border-shade px-4 py-1.5 text-ink hover:border-signal disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-shade ${FOCUS_RING}`}
          >
            Next slice
          </button>
        </div>
      )}
    </div>
  );
}
