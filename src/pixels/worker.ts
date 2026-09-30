import { toMessage } from "../lib/to-message";
import { handleDecode } from "./handle";
import type { DecodeRequest, DecodeResult } from "./protocol";

self.onmessage = (event: MessageEvent<DecodeRequest>) => {
  const request = event.data;
  try {
    const outcome = handleDecode(new Uint8Array(request.bytes), request.options);
    const result: DecodeResult = { id: request.id, ...outcome };
    self.postMessage(result, { transfer: result.ok ? [result.rgba] : [] });
  } catch (e) {
    // An exception escaping here would only fire an easily missed `error` event.
    const id = typeof request?.id === "number" ? request.id : -1;
    const failure: DecodeResult = { id, ok: false, message: toMessage(e) || "Worker failed to process this file." };
    self.postMessage(failure);
  }
};
