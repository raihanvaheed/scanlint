import { describe, expect, it } from "vitest";
import { createPixelClient } from "./client";
import type { DecodeRequest, DecodeResult } from "./protocol";

// pool.test.ts's FakeWorker is typed to ParseRequest/ParseResult and not exported, so it doesn't
// generalise to this protocol's shape (an options field, an rgba buffer instead of nodes/findings).
// This mirrors its shape exactly: postMessage/terminate/onmessage/onerror/onmessageerror, plus
// reply/fail/garble helpers that can answer out of order.
class FakeWorker {
  onmessage: ((event: MessageEvent<DecodeResult>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  received: DecodeRequest[] = [];
  transfers: Transferable[][] = [];
  terminated = false;

  postMessage(message: DecodeRequest, transfer: Transferable[] = []): void {
    this.transfers.push(transfer);
    this.received.push(structuredClone(message, { transfer }));
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(result: DecodeResult): void {
    this.onmessage?.({ data: result } as unknown as MessageEvent<DecodeResult>);
  }

  fail(message: string): void {
    this.onerror?.({ message } as unknown as ErrorEvent);
  }

  garble(): void {
    this.onmessageerror?.({} as unknown as MessageEvent);
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const client = createPixelClient({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  return { client, workers };
}

const buffer = (length = 8): ArrayBuffer => new Uint8Array(length).fill(7).buffer;
const idOf = (worker: FakeWorker, index = 0): number => worker.received[index].id;

const image = (rgba: number[]) => ({ ok: true as const, width: 1, height: 1, rgba: new Uint8Array(rgba).buffer, transferSyntaxUid: "1.2.840.10008.1.2.1" });

describe("a single request", () => {
  it("resolves with the worker's image, without the id", async () => {
    const { client, workers } = setup();
    const promise = client.decode(buffer());
    const id = idOf(workers[0]);
    const result = image([1, 2, 3, 4]);
    workers[0].reply({ id, ...result });

    const outcome = await promise;
    expect(outcome).toEqual(result);
    expect(outcome).not.toHaveProperty("id");
  });

  it("transfers the buffer instead of copying it", () => {
    const { client, workers } = setup();
    const bytes = buffer(16);
    void client.decode(bytes);

    expect(workers[0].transfers[0]).toHaveLength(1);
    expect(bytes.byteLength).toBe(0);
    expect(workers[0].received[0].bytes.byteLength).toBe(16);
  });

  it("a fake replying not-ok resolves rather than rejects", async () => {
    const { client, workers } = setup();
    const promise = client.decode(buffer());
    workers[0].reply({ id: idOf(workers[0]), ok: false, message: "bad file" });

    await expect(promise).resolves.toEqual({ ok: false, message: "bad file" });
  });

  it("reuses the same worker across sequential requests - one worker, not a pool", async () => {
    const { client, workers } = setup();
    const first = client.decode(buffer());
    workers[0].reply({ id: idOf(workers[0]), ...image([1, 1, 1, 1]) });
    await first;

    const second = client.decode(buffer());
    expect(workers).toHaveLength(1);
    workers[0].reply({ id: idOf(workers[0], 1), ...image([2, 2, 2, 2]) });
    await second;
  });
});

describe("superseding", () => {
  it("the older request resolves as superseded, the newer with its image, even replied out of order", async () => {
    const { client, workers } = setup();
    const older = client.decode(buffer());
    const olderId = idOf(workers[0]);
    const newer = client.decode(buffer());
    const newerId = idOf(workers[0], 1);
    expect(workers).toHaveLength(1);

    const newerImage = image([9, 9, 9, 9]);
    // Reply to the newer request first, then let a late reply for the (already superseded) older
    // one arrive - it must be ignored rather than resolving `older` a second time.
    workers[0].reply({ id: newerId, ...newerImage });
    workers[0].reply({ id: olderId, ...image([1, 1, 1, 1]) });

    const olderOutcome = await older;
    expect(olderOutcome).toEqual({ ok: false, superseded: true, message: "Superseded by a newer request." });
    await expect(newer).resolves.toEqual(newerImage);
  });

  it("the superseded discriminator is present only on a superseded outcome, never on a real failure", async () => {
    const { client, workers } = setup();
    const superseded = client.decode(buffer());
    const later = client.decode(buffer());
    workers[0].reply({ id: idOf(workers[0], 1), ...image([1, 1, 1, 1]) });
    await later;
    const supersededOutcome = await superseded;
    expect(supersededOutcome).toHaveProperty("superseded", true);
    expect(supersededOutcome).not.toHaveProperty("reason"); // 3.6: superseded stays its own boolean, not folded into reason

    const failing = client.decode(buffer());
    workers[0].reply({ id: idOf(workers[0], 2), ok: false, message: "bad file" });
    expect(await failing).not.toHaveProperty("superseded");
  });
});

describe("worker failures reject", () => {
  it("rejects the in-flight request when the worker fires an error event", async () => {
    const { client, workers } = setup();
    const promise = client.decode(buffer());
    workers[0].fail("script failed to load");

    await expect(promise).rejects.toThrow("script failed to load");
  });

  it("rejects, rather than hanging, when createWorker throws", async () => {
    const client = createPixelClient({
      createWorker: () => {
        throw new Error("no workers here");
      },
    });

    await expect(client.decode(buffer())).rejects.toThrow("no workers here");
  });
});

describe("terminate", () => {
  it("rejects an in-flight request, and stops the worker", async () => {
    const { client, workers } = setup();
    const promise = client.decode(buffer());
    client.terminate();

    await expect(promise).rejects.toThrow("terminated");
    expect(workers[0].terminated).toBe(true);
  });

  it("rejects a request submitted afterwards, rather than hanging", async () => {
    const { client, workers } = setup();
    client.terminate();

    await expect(client.decode(buffer())).rejects.toThrow("terminated");
    expect(workers).toHaveLength(0);
  });
});
