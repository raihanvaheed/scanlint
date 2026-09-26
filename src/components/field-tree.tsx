"use client";

import type { ReactNode } from "react";
import { formatTag } from "../model/tag";
import { flattenNodes, identifyingFindings } from "../model/tree";
import type { Finding, TagNode } from "../model/types";
import { FieldValue } from "./field-value";
import type { Reveal } from "./field-value";
import { FINDINGS_HEADING_ID, FOCUS_RING, HEADING_FOCUS_RING, TREE_HEADING_ID } from "./focus";
import { SkipLink } from "./skip-link";

type FieldTreeProps = {
  nodes: TagNode[];
  /** Every finding for the file. Rows matching an identifying finding by path are marked and masked. */
  findings: Finding[];
  /** Shared with the findings list, so a value revealed here is revealed there. Owned by the result. */
  reveal: Reveal;
};

type Context = {
  flagged: ReadonlySet<string>;
  revealed: ReadonlySet<string>;
  toggle: (path: string, label: string) => void;
};

function itemCount(count: number): string {
  return `${count} item${count === 1 ? "" : "s"}`;
}

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

// A border is a shape as well as a colour, and the words are there for anyone who cannot see either.
// Only a finding has a border: in forced-colours mode a transparent one is drawn in the text colour,
// which would put the bar on every row and stop it meaning anything. Both take the same width.
function Mark({ flagged, children }: { flagged: boolean; children: ReactNode }) {
  return (
    <span data-finding={flagged} className={`block ${flagged ? "border-l-4 border-signal pl-3" : "pl-4"}`}>
      {flagged && <span className="sr-only">Finding: </span>}
      {children}
    </span>
  );
}

// The name, then the tag, the VR and, for a finding, the word: one line that wraps as a unit.
function Heading({ label, node, flagged }: { label: string; node: TagNode; flagged: boolean }) {
  return (
    <>
      <span className="break-words font-semibold text-ink">{label}</span>
      {node.name !== undefined && (
        <>
          {" "}
          <span className="ml-3 font-mono text-sm text-shade">{formatTag(node.tag)}</span>
        </>
      )}{" "}
      <span className="ml-3 font-mono text-sm text-shade">{node.vr}</span>
      {flagged && (
        <>
          {" "}
          {/* The sr-only "Finding:" before the row already says it. Read twice, it would be noise. */}
          <span aria-hidden="true" className="ml-3 text-xs uppercase tracking-wide text-shade">
            finding
          </span>
        </>
      )}
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
            <Heading label={label} node={node} flagged={flagged} />
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
      <Heading label={name} node={node} flagged={flagged} />
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

export function FieldTree({ nodes, findings, reveal }: FieldTreeProps) {
  const flagged = new Set(identifyingFindings(findings).map((finding) => finding.path));

  return (
    <section className="mt-10 border-t-2 border-signal pt-5">
      <SkipLink targetId={FINDINGS_HEADING_ID}>Back to findings</SkipLink>
      <details className="group">
        <Summary>
          <h2 id={TREE_HEADING_ID} tabIndex={-1} className={`text-xl font-semibold text-ink ${HEADING_FOCUS_RING}`}>
            {`All fields (${flattenNodes(nodes).length})`}
          </h2>
        </Summary>
        <div className="mt-4">
          <NodeList nodes={nodes} ctx={{ flagged, revealed: reveal.revealed, toggle: reveal.toggle }} />
        </div>
      </details>
    </section>
  );
}
