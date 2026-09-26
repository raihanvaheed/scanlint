import type { ParseOutcome, ParseRequest, ParseResult } from "./protocol";

export type Pool = {
  /**
   * Takes ownership of `bytes`: the buffer is transferred to a worker, not copied, so it is
   * unusable (zero length) on the calling side afterwards. Pass a copy to keep the bytes.
   *
   * Resolves with `{ ok: false, message }` when the file cannot be parsed. Rejects only when
   * the infrastructure fails: a worker cannot be created, errors, or the pool is terminated.
   */
  parse(bytes: ArrayBuffer): Promise<ParseOutcome>;
  terminate(): void;
};

type Job = {
  id: number;
  bytes: ArrayBuffer;
  resolve: (outcome: ParseOutcome) => void;
  reject: (error: Error) => void;
};

type Slot = { worker: Worker; job: Job | undefined };

const defaultCreateWorker = () => new Worker(new URL("./worker.ts", import.meta.url));

function defaultSize(): number {
  return Math.min(4, globalThis.navigator?.hardwareConcurrency ?? 2);
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export function createPool(options: { size?: number; createWorker?: () => Worker } = {}): Pool {
  const size = Math.max(1, options.size ?? defaultSize());
  const createWorker = options.createWorker ?? defaultCreateWorker;

  const slots: Slot[] = [];
  const queue: Job[] = [];
  const owners = new Map<number, Slot>();
  let nextId = 1;
  let terminated = false;

  function release(slot: Slot): Job | undefined {
    const job = slot.job;
    if (job) owners.delete(job.id);
    slot.job = undefined;
    return job;
  }

  function failSlot(slot: Slot, error: Error): void {
    if (!slots.includes(slot)) return;
    slots.splice(slots.indexOf(slot), 1);
    const job = release(slot);
    slot.worker.terminate();
    job?.reject(error);
    pump();
  }

  function attach(slot: Slot): void {
    slot.worker.onmessage = (event: MessageEvent<ParseResult>) => {
      const { id, ...outcome } = event.data;
      const owner = owners.get(id);
      const job = owner && release(owner);
      if (!job) return;
      job.resolve(outcome);
      pump();
    };
    slot.worker.onerror = (event: ErrorEvent) => {
      failSlot(slot, new Error(event.message || "The worker failed."));
    };
    slot.worker.onmessageerror = () => {
      failSlot(slot, new Error("The worker sent a message that could not be read."));
    };
  }

  function dispatch(slot: Slot, job: Job): void {
    slot.job = job;
    owners.set(job.id, slot);
    const request: ParseRequest = { id: job.id, bytes: job.bytes };
    try {
      slot.worker.postMessage(request, [request.bytes]);
    } catch (e) {
      release(slot);
      job.reject(toError(e));
    }
  }

  function pump(): void {
    while (!terminated && queue.length > 0) {
      let slot = slots.find((s) => s.job === undefined);
      if (!slot) {
        if (slots.length >= size) return;
        try {
          slot = { worker: createWorker(), job: undefined };
        } catch (e) {
          queue.shift()?.reject(toError(e));
          continue;
        }
        slots.push(slot);
        attach(slot);
      }
      const job = queue.shift();
      if (job) dispatch(slot, job);
    }
  }

  return {
    parse(bytes) {
      if (terminated) return Promise.reject(new Error("The pool has been terminated."));
      return new Promise<ParseOutcome>((resolve, reject) => {
        queue.push({ id: nextId++, bytes, resolve, reject });
        pump();
      });
    },

    terminate() {
      terminated = true;
      const error = new Error("The pool was terminated.");
      for (const job of queue.splice(0)) job.reject(error);
      for (const slot of slots.splice(0)) {
        const job = release(slot);
        slot.worker.terminate();
        job?.reject(error);
      }
    },
  };
}
