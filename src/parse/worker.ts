import { handleParse, toMessage } from "./handle";
import type { ParseRequest, ParseResult } from "./protocol";

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  const request = event.data;
  try {
    const result: ParseResult = { id: request.id, ...handleParse(new Uint8Array(request.bytes)) };
    self.postMessage(result);
  } catch (e) {
    // An exception escaping here would only fire an easily missed `error` event.
    const id = typeof request?.id === "number" ? request.id : -1;
    const failure: ParseResult = { id, ok: false, message: toMessage(e) || "Worker failed to process this file." };
    self.postMessage(failure);
  }
};
