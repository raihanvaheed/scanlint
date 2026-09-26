"use client";

// Temporary page. Deleted in step 1.6. It exists only to prove the worker chunk loads from a
// static export. It must not import walk.ts, handle.ts or phi.ts: those belong in the worker chunk.

import { useEffect, useRef, useState } from "react";
import { loadSample } from "../../lib/load-sample";
import type { TagNode } from "../../model/types";
import { createPool } from "../../parse/pool";
import type { Pool } from "../../parse/pool";

function countNodes(nodes: TagNode[]): number {
  return nodes.reduce((total, node) => total + 1 + (node.items ?? []).reduce((n, item) => n + countNodes(item), 0), 0);
}

export default function WorkerCheck() {
  const pool = useRef<Pool | null>(null);
  const [lines, setLines] = useState<string[]>([]);

  useEffect(
    () => () => {
      pool.current?.terminate();
      pool.current = null;
    },
    [],
  );

  async function run() {
    try {
      const bytes = await loadSample();
      pool.current ??= createPool();
      const started = performance.now();
      const outcome = await pool.current.parse(bytes);
      const ms = Math.round(performance.now() - started);
      const line = outcome.ok
        ? `ok: true, top-level nodes: ${outcome.nodes.length}, flattened nodes: ${countNodes(outcome.nodes)}, findings: ${outcome.findings.length}, round trip: ${ms} ms`
        : `ok: false, message: ${outcome.message}, round trip: ${ms} ms`;
      setLines((previous) => [...previous, line]);
    } catch (e) {
      setLines((previous) => [...previous, `rejected: ${e instanceof Error ? e.message : String(e)}`]);
    }
  }

  return (
    <main className="px-6 py-24">
      <p>Temporary page — removed in step 1.6.</p>
      <button onClick={run} className="mt-4 underline">
        Run check
      </button>
      <div id="result" className="mt-4">
        {lines.map((line, index) => (
          <p key={index}>{line}</p>
        ))}
      </div>
    </main>
  );
}
