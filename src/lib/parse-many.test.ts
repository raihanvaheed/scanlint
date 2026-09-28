import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ParseOutcome } from "../parse/protocol";
import { parseMany } from "./parse-many";
import type { FileSource } from "./parse-many";

const ROOT = path.resolve(__dirname, "../..");
const DIR = path.join(ROOT, "fixtures", "series");
const SLICE_NAMES = Array.from({ length: 15 }, (_, i) => `IM_${String(i + 1).padStart(4, "0")}`);

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function fixtureSource(name: string): FileSource {
  const bytes = toArrayBuffer(fs.readFileSync(path.join(DIR, name)));
  return {
    name,
    peek: async () => bytes.slice(0, 132),
    read: async () => bytes,
  };
}

const REAL_PARSE = async (bytes: ArrayBuffer): Promise<ParseOutcome> => {
  const { handleParse } = await import("../parse/handle");
  return handleParse(new Uint8Array(bytes));
};

describe("filtering", () => {
  it("skips a file with no DICM magic without ever calling parse", async () => {
    let calls = 0;
    const source: FileSource = { name: "README.txt", peek: async () => fixtureSource("README.txt").peek(), read: async () => { throw new Error("should not be read"); } };
    const [result] = await parseMany([source], { concurrency: 4, parse: async (b) => { calls++; return REAL_PARSE(b); } });

    expect(result.outcome).toEqual({ kind: "skipped", reason: "not-dicom" });
    expect(calls).toBe(0);
  });

  it("skips the fixture's DICOMDIR by its SOP Class", async () => {
    const [result] = await parseMany([fixtureSource("DICOMDIR")], { concurrency: 4, parse: REAL_PARSE });
    expect(result.outcome).toEqual({ kind: "skipped", reason: "dicomdir" });
  });

  it("still skips a DICOMDIR renamed to something else: the check is by SOP Class, not filename", async () => {
    const original = fixtureSource("DICOMDIR");
    const renamed: FileSource = { ...original, name: "study.bin" };
    const [result] = await parseMany([renamed], { concurrency: 4, parse: REAL_PARSE });
    expect(result.outcome).toEqual({ kind: "skipped", reason: "dicomdir" });
  });

  it("reports a file with the magic but unparseable bytes as failed, with a non-empty message", async () => {
    const bytes = toArrayBuffer(fs.readFileSync(path.join(DIR, "IM_0001"))).slice(0, 200);
    const source: FileSource = { name: "truncated", peek: async () => bytes.slice(0, 132), read: async () => bytes };
    const [result] = await parseMany([source], { concurrency: 4, parse: REAL_PARSE });

    expect(result.outcome.kind).toBe("failed");
    if (result.outcome.kind === "failed") expect(result.outcome.message.length).toBeGreaterThan(0);
  });

  it("reads all 15 fixture slices", async () => {
    const results = await parseMany(SLICE_NAMES.map(fixtureSource), { concurrency: 4, parse: REAL_PARSE });
    expect(results).toHaveLength(15);
    expect(results.every((r) => r.outcome.kind === "read")).toBe(true);
    const a3 = results.find((r) => r.name === "IM_0011"); // A-3: the extra ReferringPhysicianName
    expect(a3?.outcome).toEqual({ kind: "read", findings: 29 });
  });
});

describe("the bounded pipeline", () => {
  function instrumented(concurrency: number) {
    const sources = SLICE_NAMES.map(fixtureSource);
    let current = 0;
    let max = 0;
    const tracked = sources.map((s) => ({
      ...s,
      read: async () => {
        current++;
        max = Math.max(max, current);
        return s.read();
      },
    }));
    const parse = async (bytes: ArrayBuffer): Promise<ParseOutcome> => {
      await new Promise((r) => setTimeout(r, 0));
      const outcome = await REAL_PARSE(bytes);
      current--;
      return outcome;
    };
    return { tracked, parse, peakOutstanding: () => max, concurrency };
  }

  it("never has more buffers in flight than the concurrency limit, with a pool of 4", async () => {
    const { tracked, parse, peakOutstanding } = instrumented(4);
    const results = await parseMany(tracked, { concurrency: 4, parse });

    expect(results).toHaveLength(15);
    expect(peakOutstanding()).toBeLessThanOrEqual(4);
    expect(peakOutstanding()).toBeGreaterThan(1); // proves real overlap happened, not accidental seriality
  });

  it("never exceeds 1 with a pool of 1: every file is read one at a time", async () => {
    const { tracked, parse, peakOutstanding } = instrumented(1);
    const results = await parseMany(tracked, { concurrency: 1, parse });

    expect(results).toHaveLength(15);
    expect(peakOutstanding()).toBe(1);
  });
});

describe("batch behaviour", () => {
  it("leaves the other fourteen with results when one file fails", async () => {
    const sources = SLICE_NAMES.map((name) => {
      const source = fixtureSource(name);
      if (name !== "IM_0006") return source;
      return { ...source, read: async () => { throw new Error("simulated failure"); } };
    });

    const results = await parseMany(sources, { concurrency: 4, parse: REAL_PARSE });

    expect(results).toHaveLength(15);
    const failed = results.filter((r) => r.outcome.kind === "failed");
    expect(failed).toHaveLength(1);
    expect(results.filter((r) => r.outcome.kind === "read")).toHaveLength(14);
  });

  it("correlates each result to its own filename even when the pool replies out of order", async () => {
    const sources = SLICE_NAMES.slice(0, 4).map(fixtureSource);
    const pending: { outcome: ParseOutcome; resolve: (o: ParseOutcome) => void }[] = [];
    const parse = (bytes: ArrayBuffer): Promise<ParseOutcome> =>
      REAL_PARSE(bytes).then(
        (outcome) =>
          new Promise((resolve) => {
            pending.push({ outcome, resolve });
            if (pending.length === sources.length) {
              // Reply in reverse of arrival order: which call resolves first must not matter.
              for (const p of [...pending].reverse()) p.resolve(p.outcome);
            }
          }),
      );

    const results = await parseMany(sources, { concurrency: 4, parse });

    expect(results.map((r) => r.name)).toEqual(sources.map((s) => s.name));
    for (const r of results) expect(r.outcome.kind).toBe("read");
  });

  it("stops starting new files once cancelled, and returns partial results", async () => {
    const sources = SLICE_NAMES.map(fixtureSource);
    let started = 0;
    const parse = async (bytes: ArrayBuffer): Promise<ParseOutcome> => {
      started++;
      await new Promise((r) => setTimeout(r, 0));
      return REAL_PARSE(bytes);
    };
    let cancelled = false;

    const results = await parseMany(sources, {
      concurrency: 2,
      parse,
      onResult: (_r, index) => {
        if (index === 1) cancelled = true; // cancel partway through
      },
      isCancelled: () => cancelled,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThan(15);
    expect(started).toBeLessThan(15);
    expect(results.every((r) => r.outcome.kind === "read")).toBe(true);
  });

  it("runs a second time normally after a cancelled run", async () => {
    const sources = SLICE_NAMES.map(fixtureSource);
    const first = await parseMany(sources, { concurrency: 4, parse: REAL_PARSE, isCancelled: () => true });
    expect(first.length).toBeLessThanOrEqual(4); // at most one file per worker starts before the check

    const second = await parseMany(sources, { concurrency: 4, parse: REAL_PARSE });
    expect(second).toHaveLength(15);
  });
});
