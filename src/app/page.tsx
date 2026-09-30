"use client";

import { useCallback, useEffect, useRef } from "react";
import { LoadScreen } from "../components/load-screen";
import { loadSample } from "../lib/load-sample";
import { createPool, defaultPoolSize } from "../parse/pool";
import type { Pool } from "../parse/pool";
import { createPixelClient } from "../pixels/client";
import type { PixelClient } from "../pixels/client";
import type { DecodeOptions } from "../pixels/protocol";

export default function Home() {
  const pool = useRef<Pool | null>(null);
  const pixelClient = useRef<PixelClient | null>(null);

  // Cleared on unmount so a strict-mode remount cannot reuse a terminated pool or client.
  useEffect(
    () => () => {
      pool.current?.terminate();
      pool.current = null;
      pixelClient.current?.terminate();
      pixelClient.current = null;
    },
    [],
  );

  const parse = useCallback((bytes: ArrayBuffer) => {
    pool.current ??= createPool();
    return pool.current.parse(bytes);
  }, []);

  // Created lazily, on the first decode - not here - so the pixel worker's own module graph is
  // never even requested until someone actually opens a preview (see ImagePreview/section 10).
  const decodePixels = useCallback((bytes: ArrayBuffer, options?: DecodeOptions) => {
    pixelClient.current ??= createPixelClient();
    return pixelClient.current.decode(bytes, options);
  }, []);

  // createPool() below is never given a size, so this mirrors its own default exactly.
  return <LoadScreen parse={parse} loadSample={loadSample} concurrency={defaultPoolSize()} decodePixels={decodePixels} />;
}
