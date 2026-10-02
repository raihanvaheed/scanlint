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

// Composed from the parts actually present (1.8: never promise keyboard behaviour that is not
// there, in either direction) - a window and a frame count are independent, and a file can have
// either, neither, or both.
function canvasAriaLabel(fileLabel: string, hasWindow: boolean, hasFrames: boolean): string {
  let label = `Decoded image of ${fileLabel}. This is medical pixel data and cannot otherwise be described.`;
  if (hasWindow) label += " When focused, arrow keys adjust brightness and contrast; hold shift for larger steps.";
  if (hasFrames) label += " Page Up and Page Down move between frames; Home and End jump to the first and last frame.";
  return label;
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
  // What the reader asked for, carried across a slice step the same way windowOverride is (3.4a) -
  // someone examining frame 12 of a cine series wants frame 12 on the next slice, not frame 1 (3.8).
  // Deliberately NOT the same as what's displayed (image.frame): a slice step through a shorter
  // file clamps the display, but must not overwrite this with the clamped value, or the original
  // request is lost for good the moment a reader passes through one shorter file (3.8a) - including
  // a single-frame slice, which clamps to 0 with no control on screen to show it happened. Only the
  // frame controls themselves (Previous/Next/Home/End) are allowed to change what's requested, and
  // they always derive the new value from what's currently displayed, not from this ref - see
  // applyFrame's callers. Starts at 0, the only value every file is guaranteed to have; resets to 0
  // for free on a genuinely new file, since picking one unmounts this component rather than just
  // changing its fileKey prop (see ImagePreviewProps.fileKey).
  const requestedFrame = useRef(0);
  const dragStart = useRef<{ x: number; y: number; window: WindowSetting } | null>(null);
  const requestSeq = useRef(0);

  // A new slice: carries the current window and requested frame across (3.4a, 3.8) - the old image
  // stays exactly where it is (state untouched) until the new one resolves.
  //
  // The frame needs its own dance: requesting an out-of-range frame is a plain failure (correctly -
  // it is a genuine defect to ask for a frame that is not there), not something decodeImage clamps
  // for itself, so clamping has to happen here, and it needs the new file's own frame count first.
  // When the requested frame is already 0 (the overwhelmingly common case - most files are
  // single-frame, and most sessions never step a frame at all) this is exactly one decode, same as
  // before 3.8. Only a requested frame greater than 0 risks landing out of range, so only that case
  // pays for a second, corrective decode once the first reveals how many frames the new file has.
  //
  // requestedFrame.current is read here but never written: what's displayed is allowed to clamp
  // down for a file that can't show it, but what's remembered must not (3.8a) - a reader who was on
  // frame 12 and steps through an 8-frame file, then into another 25-frame one, should land back on
  // 12, not on "8, and then forgotten".
  useEffect(() => {
    if (!visible) return;
    const requested = requestedFrame.current;
    if (requested === 0) {
      void runDecode(windowOverride.current, 0);
      return;
    }
    void (async () => {
      const decoded = await runDecode(windowOverride.current, 0);
      if (!decoded) return;
      const displayed = Math.min(requested, decoded.numberOfFrames - 1);
      if (displayed !== 0) void runDecode(windowOverride.current, displayed);
    })();
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

  // Returns the decoded image on success, so the fileKey-change effect can read the new file's own
  // numberOfFrames back without keeping a second copy of decode's own result handling. Returns
  // undefined on any failure, supersession, or going stale - every case where there is nothing a
  // caller could act on.
  async function runDecode(window: WindowSetting | null, frame: number): Promise<DecodedImage | undefined> {
    const seq = ++requestSeq.current;
    setPhase("decoding");
    let bytes: ArrayBuffer;
    try {
      bytes = await getBytes();
    } catch (e) {
      if (seq !== requestSeq.current) return undefined;
      setPhase("error");
      setMessage(messageOf(e));
      setReason(undefined);
      return undefined;
    }
    const outcome = await decode(bytes, window ? { frame, window } : { frame });
    if (seq !== requestSeq.current) return undefined; // a newer runDecode call has since started

    if (!outcome.ok) {
      if ("superseded" in outcome && outcome.superseded) return undefined; // section 7: nothing rendered
      setPhase("error");
      setMessage(outcome.message);
      setReason("reason" in outcome ? outcome.reason : undefined);
      return undefined;
    }
    const decoded: DecodedImage = {
      width: outcome.width,
      height: outcome.height,
      rgba: new Uint8ClampedArray(outcome.rgba),
      window: outcome.window,
      transferSyntaxUid: outcome.transferSyntaxUid,
      frame: outcome.frame,
      numberOfFrames: outcome.numberOfFrames,
    };
    setImage(decoded);
    setPhase("ready");
    return decoded;
  }

  function applyWindow(next: WindowSetting) {
    windowOverride.current = next;
    void runDecode(next, requestedFrame.current);
  }

  // The only place requestedFrame.current is written outside the initial 0. Every caller below
  // derives `next` from `image.frame` - what's currently displayed - never from the old requested
  // value, so using a control always collapses the request down to the reader's actual choice
  // (3.8a): stepping off a frame that only exists because of a clamp means asking for exactly where
  // you land, not "whatever was originally requested, plus or minus one".
  function applyFrame(next: number) {
    requestedFrame.current = next;
    void runDecode(windowOverride.current, next);
  }

  function onToggle() {
    const next = !visible;
    setVisible(next);
    // Opening it is what starts the worker - never decode while closed, and never decode again on
    // reopen if the image (or an in-flight decode) is already in hand.
    if (next && phase === "idle") void runDecode(null, requestedFrame.current);
  }

  function onReset() {
    windowOverride.current = null;
    void runDecode(null, requestedFrame.current);
  }

  function onPreviousFrame() {
    if (!image || image.frame <= 0) return;
    applyFrame(image.frame - 1);
  }

  function onNextFrame() {
    if (!image || image.frame >= image.numberOfFrames - 1) return;
    applyFrame(image.frame + 1);
  }

  function onFirstFrame() {
    if (!image || image.frame <= 0) return;
    applyFrame(0);
  }

  function onLastFrame() {
    if (!image) return;
    const last = image.numberOfFrames - 1;
    if (image.frame >= last) return;
    applyFrame(last);
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
    // Page Up/Down and Home/End move frames; arrow keys move the window. Two disjoint key sets on
    // the same element, neither reads the other's keys, so there is nothing to arbitrate between
    // them. 3.4 deferred a keyboard path for slice stepping; frames get one here because a 600-slice
    // folder still has 2.5's clickable list as a second route, while two hundred frames inside one
    // file have no route at all except the button - clicking it two hundred times is not a feature.
    if (image && image.numberOfFrames > 1) {
      if (e.key === "PageDown") {
        onNextFrame();
        e.preventDefault();
        return;
      }
      if (e.key === "PageUp") {
        onPreviousFrame();
        e.preventDefault();
        return;
      }
      if (e.key === "Home") {
        onFirstFrame();
        e.preventDefault();
        return;
      }
      if (e.key === "End") {
        onLastFrame();
        e.preventDefault();
        return;
      }
    }

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
            aria-label={canvasAriaLabel(fileLabel, Boolean(image.window), image.numberOfFrames > 1)}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
            style={{ imageRendering: "pixelated", aspectRatio: `${image.width} / ${image.height}` }}
            className={`w-full max-w-[512px] cursor-crosshair touch-none rounded border border-rule ${FOCUS_RING}`}
          />
          <p className="mt-2 text-sm text-shade">
            {/* The frame segment sits next to the dimensions, not the encoding - it is part of what
                the reader is looking at. No segment at all for a single-frame file (numberOfFrames
                1 or absent): "frame 1 of 1" is clutter on almost every file in existence, the same
                rule the window segment already follows. */}
            {`${image.width} × ${image.height}`}
            {image.numberOfFrames > 1 && ` · frame ${image.frame + 1} of ${image.numberOfFrames}`}
            {` · ${formatTransferSyntax(image.transferSyntaxUid)}`}
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

      {/* Two independent control pairs (section 6): a slice is a different position in the body, a
          frame is a different moment in time, and a reader needs the distinction, not a single
          counter that discards it. Each renders only when its own axis has more than one position -
          neither nested inside the other nor flattened into one.

          Each pair is its own counter-above-buttons stack below `sm`, and a single row at `sm` and
          up (3.8a) - `flex-wrap` alone let the second button wrap onto a line by itself, orphaned
          rather than grouped. The buttons share a `display:contents` wrapper at `sm` so they stop
          being one flex item and rejoin the row individually, in label-first DOM order reordered
          back to previous/label/next with `order-*`. */}
      {image !== null && image.numberOfFrames > 1 && (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <span className="order-1 text-sm text-shade sm:order-2">{`Frame ${image.frame + 1} of ${image.numberOfFrames}`}</span>
          <div className="order-2 flex gap-4 sm:contents">
            <button
              type="button"
              disabled={image.frame <= 0}
              onClick={onPreviousFrame}
              className={`cursor-pointer rounded-md border-2 border-shade px-4 py-1.5 text-ink hover:border-signal disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-shade sm:order-1 ${FOCUS_RING}`}
            >
              Previous frame
            </button>
            <button
              type="button"
              disabled={image.frame >= image.numberOfFrames - 1}
              onClick={onNextFrame}
              className={`cursor-pointer rounded-md border-2 border-shade px-4 py-1.5 text-ink hover:border-signal disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-shade sm:order-3 ${FOCUS_RING}`}
            >
              Next frame
            </button>
          </div>
        </div>
      )}

      {stepping && (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <span className="order-1 text-sm text-shade sm:order-2">{stepping.label}</span>
          <div className="order-2 flex gap-4 sm:contents">
            <button
              type="button"
              disabled={!stepping.hasPrevious}
              onClick={stepping.onPrevious}
              className={`cursor-pointer rounded-md border-2 border-shade px-4 py-1.5 text-ink hover:border-signal disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-shade sm:order-1 ${FOCUS_RING}`}
            >
              Previous slice
            </button>
            <button
              type="button"
              disabled={!stepping.hasNext}
              onClick={stepping.onNext}
              className={`cursor-pointer rounded-md border-2 border-shade px-4 py-1.5 text-ink hover:border-signal disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-shade sm:order-3 ${FOCUS_RING}`}
            >
              Next slice
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
