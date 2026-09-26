import { afterEach, describe, expect, it, vi } from "vitest";
import { createPool } from "./pool";
import type { ParseRequest, ParseResult } from "./protocol";

class FakeWorker {
  onmessage: ((event: MessageEvent<ParseResult>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  received: ParseRequest[] = [];
  transfers: Transferable[][] = [];
  terminated = false;

  postMessage(message: ParseRequest, transfer: Transferable[] = []): void {
    this.transfers.push(transfer);
    this.received.push(structuredClone(message, { transfer }));
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(result: ParseResult): void {
    this.onmessage?.({ data: result } as unknown as MessageEvent<ParseResult>);
  }

  fail(message: string): void {
    this.onerror?.({ message } as unknown as ErrorEvent);
  }

  garble(): void {
    this.onmessageerror?.({} as unknown as MessageEvent);
  }
}

function setup(size: number) {
  const workers: FakeWorker[] = [];
  const pool = createPool({
    size,
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  return { pool, workers };
}

const buffer = (length = 8): ArrayBuffer => new Uint8Array(length).fill(7).buffer;

const okResult = (id: number): ParseResult => ({
  id,
  ok: true,
  nodes: [],
  findings: [{ path: `job-${id}`, tag: "00100010", vr: "PN", kind: "annex-e" }],
});

const idOf = (worker: FakeWorker, index = 0): number => worker.received[index].id;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a single job", () => {
  it("resolves with the worker's result, without the id", async () => {
    const { pool, workers } = setup(1);
    const promise = pool.parse(buffer());
    const id = idOf(workers[0]);
    workers[0].reply(okResult(id));

    const outcome = await promise;
    expect(outcome).toEqual({
      ok: true,
      nodes: [],
      findings: [{ path: `job-${id}`, tag: "00100010", vr: "PN", kind: "annex-e" }],
    });
    expect(outcome).not.toHaveProperty("id");
  });

  it("transfers the buffer instead of copying it", () => {
    const { pool, workers } = setup(1);
    const bytes = buffer(16);
    void pool.parse(bytes);

    expect(workers[0].transfers[0]).toHaveLength(1);
    expect(bytes.byteLength).toBe(0);
    expect(workers[0].received[0].bytes.byteLength).toBe(16);
    expect(new Uint8Array(workers[0].received[0].bytes)[0]).toBe(7);
  });

  it("creates workers only as needed", () => {
    const { pool, workers } = setup(4);
    void pool.parse(buffer());
    expect(workers).toHaveLength(1);
  });
});

describe("several jobs at once", () => {
  it("correlates each reply with its own job when the workers answer out of order", async () => {
    const { pool, workers } = setup(4);
    const promises = [1, 2, 3, 4].map(() => pool.parse(buffer()));
    expect(workers).toHaveLength(4);

    const ids = workers.map((w) => idOf(w));
    expect(new Set(ids).size).toBe(4);

    for (const index of [2, 0, 3, 1]) workers[index].reply(okResult(ids[index]));

    const outcomes = await Promise.all(promises);
    outcomes.forEach((outcome, i) => {
      expect(outcome.ok && outcome.findings[0].path).toBe(`job-${ids[i]}`);
    });
  });

  it("queues jobs beyond the pool size and hands each to the next worker to free up", async () => {
    const { pool, workers } = setup(2);
    const promises = [1, 2, 3, 4].map(() => pool.parse(buffer()));

    expect(workers).toHaveLength(2);
    expect(workers.flatMap((w) => w.received)).toHaveLength(2);

    // Worker 1 frees first, so it takes job 3, then job 4. Worker 0 stays on job 1 throughout.
    workers[1].reply(okResult(idOf(workers[1])));
    await promises[1];
    expect(workers[1].received).toHaveLength(2);

    workers[1].reply(okResult(idOf(workers[1], 1)));
    await promises[2];
    expect(workers[1].received).toHaveLength(3);

    workers[1].reply(okResult(idOf(workers[1], 2)));
    workers[0].reply(okResult(idOf(workers[0])));

    expect(workers).toHaveLength(2);
    const dispatchedIds = [idOf(workers[0]), idOf(workers[1]), idOf(workers[1], 1), idOf(workers[1], 2)];
    const paths = (await Promise.all(promises)).map((o) => o.ok && o.findings[0].path);
    expect(paths).toEqual(dispatchedIds.map((id) => `job-${id}`));
  });

  it("ignores a reply carrying an id that belongs to no job", async () => {
    const { pool, workers } = setup(1);
    const promise = pool.parse(buffer());
    const id = idOf(workers[0]);

    workers[0].reply(okResult(9999));
    workers[0].reply(okResult(id));

    const outcome = await promise;
    expect(outcome.ok && outcome.findings[0].path).toBe(`job-${id}`);
  });
});

describe("a file that cannot be parsed", () => {
  it("resolves with ok: false instead of rejecting", async () => {
    const { pool, workers } = setup(1);
    const promise = pool.parse(buffer());
    workers[0].reply({ id: idOf(workers[0]), ok: false, message: "DICM prefix not found" });

    await expect(promise).resolves.toEqual({ ok: false, message: "DICM prefix not found" });
  });

  it("does not affect the other jobs in the batch", async () => {
    const { pool, workers } = setup(2);
    const bad = pool.parse(buffer());
    const good = pool.parse(buffer());
    workers[0].reply({ id: idOf(workers[0]), ok: false, message: "bad file" });
    workers[1].reply(okResult(idOf(workers[1])));

    expect(await bad).toEqual({ ok: false, message: "bad file" });
    expect((await good).ok).toBe(true);
  });
});

describe("worker failures reject", () => {
  it("rejects the in-flight job when the worker fires an error event", async () => {
    const { pool, workers } = setup(1);
    const promise = pool.parse(buffer());
    workers[0].fail("script failed to load");

    await expect(promise).rejects.toThrow("script failed to load");
    expect(workers[0].terminated).toBe(true);
  });

  it("leaves the other workers' jobs alone", async () => {
    const { pool, workers } = setup(2);
    const failing = pool.parse(buffer());
    const healthy = pool.parse(buffer());
    workers[0].fail("boom");
    workers[1].reply(okResult(idOf(workers[1])));

    await expect(failing).rejects.toThrow("boom");
    expect((await healthy).ok).toBe(true);
  });

  it("replaces a failed worker, so queued jobs still run", async () => {
    const { pool, workers } = setup(1);
    const first = pool.parse(buffer());
    const second = pool.parse(buffer());
    workers[0].fail("boom");

    await expect(first).rejects.toThrow("boom");
    expect(workers).toHaveLength(2);
    workers[1].reply(okResult(idOf(workers[1])));
    expect((await second).ok).toBe(true);
  });

  it("rejects the in-flight job when a reply cannot be read", async () => {
    const { pool, workers } = setup(1);
    const promise = pool.parse(buffer());
    workers[0].garble();

    await expect(promise).rejects.toThrow("could not be read");
  });

  it("rejects, rather than hanging, when createWorker throws", async () => {
    const pool = createPool({
      size: 2,
      createWorker: () => {
        throw new Error("no workers here");
      },
    });

    await expect(pool.parse(buffer())).rejects.toThrow("no workers here");
    await expect(pool.parse(buffer())).rejects.toThrow("no workers here");
  });

  it("rejects when the buffer cannot be posted, and the worker stays usable", async () => {
    const { pool, workers } = setup(1);
    const detached = buffer();
    structuredClone(detached, { transfer: [detached] });

    await expect(pool.parse(detached)).rejects.toThrow();

    const next = pool.parse(buffer());
    workers[0].reply(okResult(idOf(workers[0])));
    expect((await next).ok).toBe(true);
  });
});

describe("terminate", () => {
  it("stops every worker and rejects in-flight and queued jobs", async () => {
    const { pool, workers } = setup(2);
    const settled = [pool.parse(buffer()), pool.parse(buffer()), pool.parse(buffer())].map((p) =>
      p.then(
        () => "resolved",
        (error: Error) => error.message,
      ),
    );
    expect(workers).toHaveLength(2);

    pool.terminate();

    expect(workers.every((w) => w.terminated)).toBe(true);
    expect(await Promise.all(settled)).toEqual([
      "The pool was terminated.",
      "The pool was terminated.",
      "The pool was terminated.",
    ]);
  });

  it("rejects a job submitted afterwards, rather than hanging", async () => {
    const { pool, workers } = setup(1);
    pool.terminate();

    await expect(pool.parse(buffer())).rejects.toThrow("terminated");
    expect(workers).toHaveLength(0);
  });
});

describe("default pool size", () => {
  const sizeFor = (hardwareConcurrency: number | undefined): number => {
    vi.stubGlobal("navigator", { hardwareConcurrency });
    const workers: FakeWorker[] = [];
    const pool = createPool({
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    for (let i = 0; i < 10; i++) void pool.parse(buffer());
    return workers.length;
  };

  it.each([
    [16, 4],
    [8, 4],
    [3, 3],
    [1, 1],
    [0, 1],
    [undefined, 2],
  ])("with hardwareConcurrency %s creates %s workers for a full queue", (cores, expected) => {
    expect(sizeFor(cores)).toBe(expected);
  });
});
