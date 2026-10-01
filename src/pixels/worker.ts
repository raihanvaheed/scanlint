import { toMessage } from "../lib/to-message";
import { handleDecode } from "./handle";
import type { DecodeRequest, DecodeResult } from "./protocol";

// 3.3 required the whole handler in a try/catch: an exception escaping it fires only an easily
// missed `error` event, settling nothing. An async handler raises the stakes on the same rule rather
// than retiring it - a rejection escaping an async message handler fires `unhandledrejection`
// instead, the main thread's `onerror` never runs, and the in-flight promise never settles: a leak
// with no symptom (3.3's own phrase), now reachable through `await` as well as `throw`. So the whole
// body, including the reply itself, stays inside one try/catch - `self.postMessage` can throw too
// (an unserialisable value, a bad transfer list), and that must produce a settling reply as well.
self.onmessage = async (event: MessageEvent<DecodeRequest>) => {
  const request = event.data;
  const id = typeof request?.id === "number" ? request.id : -1;
  try {
    const outcome = await handleDecode(new Uint8Array(request.bytes), request.options);
    const result: DecodeResult = { id: request.id, ...outcome };
    self.postMessage(result, { transfer: result.ok ? [result.rgba] : [] });
  } catch (e) {
    const failure: DecodeResult = { id, ok: false, message: toMessage(e) || "Worker failed to process this file." };
    self.postMessage(failure);
  }
};
