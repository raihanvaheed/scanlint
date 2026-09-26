"use client";

import { useCallback, useEffect, useRef } from "react";
import { LoadScreen } from "../components/load-screen";
import { loadSample } from "../lib/load-sample";
import { createPool } from "../parse/pool";
import type { Pool } from "../parse/pool";

export default function Home() {
  const pool = useRef<Pool | null>(null);

  // Cleared on unmount so a strict-mode remount cannot reuse a terminated pool.
  useEffect(
    () => () => {
      pool.current?.terminate();
      pool.current = null;
    },
    [],
  );

  const parse = useCallback((bytes: ArrayBuffer) => {
    pool.current ??= createPool();
    return pool.current.parse(bytes);
  }, []);

  return <LoadScreen parse={parse} loadSample={loadSample} />;
}
