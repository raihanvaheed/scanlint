"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { formatTag } from "../model/tag";
import { flattenNodes, identifyingFindings } from "../model/tree";
import type { Finding, TagNode } from "../model/types";
import { FieldValue } from "./field-value";
import { FOCUS_RING } from "./focus";

type FieldTreeProps = {
  nodes: TagNode[];
  /** Every finding for the file. Rows matching an identifying finding by path are marked and masked. */
  findings: Finding[];
  /** Called with a plain sentence when reveal state changes, for a live region. */
  announce?: (message: string) => void;
};

type Context = {
  flagged: ReadonlySet<string>;
  revealed: ReadonlySet<string>;
  toggle: (path: string, label: string) => void;
};

function itemCount(count: number): string {
  return `${count} item${count === 1 ? "" : "s"}`;
}

// A border is a shape as well as a colour, and the words are there for anyone who cannot see either.
// The native marker is replaced by a glyph so a long name can wrap beside it instead of dropping below it.
// It is still a <summary> inside a <details>: the browser keeps the toggling, the keys and the semantics.
function Summary({ children }: { children: ReactNode }) {
  return (
    <summary className={`flex cursor-pointer list-none items-start gap-2 rounded [&::-webkit-details-marker]:hidden ${FOCUS_RING}`}>
      <span aria-hidden="true" className="mt-0.5 text-shade motion-safe:transition-transform group-open:rotate-90">
        ▸
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </summary>
  );
}

function Mark({ flagged, children }: { flagged: boolean; children: ReactNode }) {
  return (
    <span className={`block border-l-4 pl-3 ${flagged ? "border-signal" : "border-transparent"}`}>
      {flagged && <span className="sr-only">Finding: </span>}
      {children}
      {flagged && <span className="ml-3 text-xs uppercase tracking-wide text-shade">finding</span>}
    </span>
  );
}

function Heading({ node }: { node: TagNode }) {
  const tag = formatTag(node.tag);
  return (
    <>
      <span className="break-words font-semibold text-ink">{node.name ?? tag}</span>
      {node.name !== undefined && <span className="ml-3 font-mono text-sm text-shade">{tag}</span>}
      <span className="ml-3 font-mono text-sm text-shade">{node.vr}</span>
    </>
  );
}

function NodeList({ nodes, ctx }: { nodes: TagNode[]; ctx: Context }) {
  return (
    <ul className="space-y-2">
      {nodes.map((node) => (
        <li key={node.path}>
          <NodeRow node={node} ctx={ctx} />
        </li>
      ))}
    </ul>
  );
}

function NodeRow({ node, ctx }: { node: TagNode; ctx: Context }) {
  const flagged = ctx.flagged.has(node.path);

  if (node.items !== undefined) {
    const label = `${node.name ?? formatTag(node.tag)} (${itemCount(node.items.length)})`;
    return (
      <details className="group">
        <Summary>
          <Mark flagged={flagged}>
            <span className="break-words font-semibold text-ink">{label}</span>
            {node.name !== undefined && <span className="ml-3 font-mono text-sm text-shade">{formatTag(node.tag)}</span>}
            <span className="ml-3 font-mono text-sm text-shade">{node.vr}</span>
          </Mark>
        </Summary>
        <ol className="mt-2 space-y-2 pl-4">
          {node.items.map((item, index) => (
            <li key={index}>
              <details className="group">
                <Summary>
                  <span className="text-ink">{`Item ${index + 1}`}</span>
                </Summary>
                <div className="mt-2 pl-4">
                  <NodeList nodes={item} ctx={ctx} />
                </div>
              </details>
            </li>
          ))}
        </ol>
      </details>
    );
  }

  const name = node.name ?? formatTag(node.tag);
  return (
    <Mark flagged={flagged}>
      <Heading node={node} />
      <div className="mt-1">
        <FieldValue
          name={name}
          value={node.value}
          vr={node.vr}
          length={node.length}
          flagged={flagged}
          revealed={ctx.revealed.has(node.path)}
          onToggle={() => ctx.toggle(node.path, name)}
        />
      </div>
    </Mark>
  );
}

export function FieldTree({ nodes, findings, announce }: FieldTreeProps) {
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const flagged = new Set(identifyingFindings(findings).map((finding) => finding.path));

  function toggle(path: string, label: string) {
    const next = new Set(revealed);
    const showing = !next.delete(path);
    if (showing) next.add(path);
    setRevealed(next);
    announce?.(`${label} ${showing ? "revealed" : "hidden"}`);
  }

  return (
    <section className="mt-10 border-t-2 border-signal pt-5">
      <details className="group">
        <Summary>
          <h2 className="text-xl font-semibold text-ink">{`All fields (${flattenNodes(nodes).length})`}</h2>
        </Summary>
        <div className="mt-4">
          <NodeList nodes={nodes} ctx={{ flagged, revealed, toggle }} />
        </div>
      </details>
    </section>
  );
}
