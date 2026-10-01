// @vitest-environment happy-dom
// worker.ts assigns `self.onmessage` as an import side effect, so this needs an environment where
// `self` already exists before that import runs.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecodeRequest, DecodeResult } from "./protocol";

function fakeEvent(data: Partial<DecodeRequest> | Record<string, unknown>): MessageEvent<DecodeRequest> {
  return { data } as unknown as MessageEvent<DecodeRequest>;
}

describe("the worker's message handler never leaves a request unsettled (3.3, raised by 3.6's async handler)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("./handle");
    vi.resetModules();
  });

  it("a malformed request (no bytes field) still settles with exactly one not-ok reply", async () => {
    vi.resetModules();
    await import("./worker");
    const postMessage = vi.fn();
    vi.stubGlobal("postMessage", postMessage);

    await self.onmessage?.(fakeEvent({ id: 1 }));

    expect(postMessage).toHaveBeenCalledTimes(1);
    const result = postMessage.mock.calls[0][0] as DecodeResult;
    expect(result.ok).toBe(false);
    expect(result.id).toBe(1);
  });

  // `new Uint8Array(undefined)` does not throw - it is simply empty - so a request missing both
  // `bytes` and `id` settles via handleDecode's own graceful not-ok (empty bytes fail DICOM parsing
  // on their own merits), not via the catch block's `id` fallback. That fallback only matters when
  // something throws before a result can be built - still worth a request with no `id` at all here,
  // to show settlement does not depend on `id` being present either way. createPixelClient itself
  // never omits `id` (see client.ts), so this is a defensive case, not a reachable one in practice.
  it("a request with no id at all still settles exactly once", async () => {
    vi.resetModules();
    await import("./worker");
    const postMessage = vi.fn();
    vi.stubGlobal("postMessage", postMessage);

    await self.onmessage?.(fakeEvent({}));

    expect(postMessage).toHaveBeenCalledTimes(1);
    const result = postMessage.mock.calls[0][0] as DecodeResult;
    expect(result.ok).toBe(false);
  });

  it("handleDecode rejecting still settles with exactly one not-ok reply, not an unhandled rejection", async () => {
    vi.resetModules();
    vi.doMock("./handle", () => ({
      handleDecode: vi.fn().mockRejectedValue(new Error("handleDecode rejected unexpectedly")),
    }));
    await import("./worker");
    const postMessage = vi.fn();
    vi.stubGlobal("postMessage", postMessage);

    await self.onmessage?.(fakeEvent({ id: 7, bytes: new ArrayBuffer(0) }));

    expect(postMessage).toHaveBeenCalledTimes(1);
    const result = postMessage.mock.calls[0][0] as DecodeResult;
    expect(result).toEqual({ id: 7, ok: false, message: "handleDecode rejected unexpectedly" });
  });

  it("postMessage itself throwing on the reply still settles with a fallback failure reply", async () => {
    vi.resetModules();
    vi.doMock("./handle", () => ({
      handleDecode: vi.fn().mockResolvedValue({ ok: true, width: 1, height: 1, rgba: new Uint8ClampedArray(4), transferSyntaxUid: "1.2.840.10008.1.2.1" }),
    }));
    await import("./worker");
    const postMessage = vi.fn().mockImplementationOnce(() => {
      throw new Error("could not clone");
    });
    vi.stubGlobal("postMessage", postMessage);

    await self.onmessage?.(fakeEvent({ id: 3, bytes: new ArrayBuffer(0) }));

    expect(postMessage).toHaveBeenCalledTimes(2); // the throwing attempt, then the fallback reply
    const result = postMessage.mock.calls[1][0] as DecodeResult;
    expect(result.ok).toBe(false);
    expect(result.id).toBe(3);
  });
});
