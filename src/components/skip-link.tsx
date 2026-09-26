"use client";

import type { MouseEvent } from "react";
import { FOCUS_RING } from "./focus";

// Hidden until it takes focus. It moves focus to a heading, which has tabindex="-1" for the purpose.
// Focused, it is absolutely positioned with no offsets, so it stays where it would have been in the flow but
// takes up no room there: it overlays what follows instead of pushing it down.
export function SkipLink({ targetId, children }: { targetId: string; children: string }) {
  function go(event: MouseEvent<HTMLAnchorElement>) {
    const target = document.getElementById(targetId);
    if (!target) return;
    event.preventDefault();
    target.focus();
    target.scrollIntoView?.({ block: "start" });
  }

  return (
    <a
      href={`#${targetId}`}
      onClick={go}
      className={`sr-only focus:not-sr-only focus:absolute focus:z-10 focus:rounded-md focus:border-2 focus:border-shade focus:bg-paper focus:px-4 focus:py-1.5 focus:text-ink ${FOCUS_RING}`}
    >
      {children}
    </a>
  );
}
