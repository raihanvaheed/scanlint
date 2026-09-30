import type { DecodeOptions, DecodeOutcome, DecodeRequest, DecodeResult } from "./protocol";

export type PixelClient = {
  /**
   * Takes ownership of `bytes`: the buffer is transferred to the worker, not copied, so it is
   * unusable (zero length) on the calling side afterwards. Pass a copy to keep the bytes.
   *
   * A person looks at one image at a time, so there is one worker, not a pool. When a newer
   * request arrives while an older one is still in flight, the older one resolves immediately
   * with `{ ok: false, message: "Superseded by a newer request." }` rather than eventually
   * resolving with a slice the caller has since scrolled past.
   *
   * Resolves with `{ ok: false, message }` when the file cannot be decoded. Rejects only when the
   * infrastructure fails: the worker cannot be created, errors, or the client is terminated.
   */
  decode(bytes: ArrayBuffer, options?: DecodeOptions): Promise<DecodeOutcome>;
  terminate(): void;
};

type Job = {
  id: number;
  resolve: (outcome: DecodeOutcome) => void;
  reject: (error: Error) => void;
};

const defaultCreateWorker = () => new Worker(new URL("./worker.ts", import.meta.url));

const SUPERSEDED: DecodeOutcome = { ok: false, message: "Superseded by a newer request." };

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export function createPixelClient(options: { createWorker?: () => Worker } = {}): PixelClient {
  const createWorker = options.createWorker ?? defaultCreateWorker;

  let worker: Worker | undefined;
  let current: Job | undefined;
  let nextId = 1;
  let terminated = false;

  function settleCurrent(id: number, outcome: DecodeOutcome): void {
    if (!current || current.id !== id) return; // a stale reply for an already-superseded job
    const job = current;
    current = undefined;
    job.resolve(outcome);
  }

  function failCurrent(error: Error): void {
    const job = current;
    current = undefined;
    job?.reject(error);
  }

  function ensureWorker(): Worker {
    if (worker) return worker;
    const w = createWorker();
    w.onmessage = (event: MessageEvent<DecodeResult>) => {
      const { id, ...outcome } = event.data;
      settleCurrent(id, outcome);
    };
    w.onerror = (event: ErrorEvent) => {
      failCurrent(new Error(event.message || "The worker failed."));
    };
    w.onmessageerror = () => {
      failCurrent(new Error("The worker sent a message that could not be read."));
    };
    worker = w;
    return w;
  }

  return {
    decode(bytes, decodeOptions) {
      if (terminated) return Promise.reject(new Error("The pixel client has been terminated."));

      const previous = current;
      previous?.resolve(SUPERSEDED);

      return new Promise<DecodeOutcome>((resolve, reject) => {
        const id = nextId++;
        let w: Worker;
        try {
          w = ensureWorker();
        } catch (e) {
          reject(toError(e));
          return;
        }

        current = { id, resolve, reject };
        const request: DecodeRequest = { id, bytes, options: decodeOptions };
        try {
          w.postMessage(request, [request.bytes]);
        } catch (e) {
          current = undefined;
          reject(toError(e));
        }
      });
    },

    terminate() {
      terminated = true;
      worker?.terminate();
      worker = undefined;
      failCurrent(new Error("The pixel client was terminated."));
    },
  };
}
