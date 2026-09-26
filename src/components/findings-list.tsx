"use client";

import { useState } from "react";
import { ACTION_GLOSS } from "../model/actions";
import { formatTag } from "../model/tag";
import { identifyingFindings } from "../model/tree";
import type { Finding } from "../model/types";
import { FieldValue, isMaskable } from "./field-value";
import { FOCUS_RING } from "./focus";

type FindingsListProps = {
  /** Every finding for the file. The burned-in flag is dropped here: the summary already states it. */
  findings: Finding[];
  /** Called with a plain sentence when reveal state changes, for a live region. */
  announce?: (message: string) => void;
};

const PRIVATE_REASON = "private tag, contents defined by the manufacturer";

function Reason({ finding }: { finding: Finding }) {
  if (finding.kind === "private") return <span className="text-shade">{PRIVATE_REASON}</span>;

  const action = finding.action ?? "";
  const gloss = ACTION_GLOSS[action];
  if (gloss === undefined) throw new Error(`No gloss for action "${action}" (${finding.path})`);
  return (
    <span className="text-shade">
      <span className="font-mono font-semibold">{action}</span> {gloss}
    </span>
  );
}

export function FindingsList({ findings, announce }: FindingsListProps) {
  const rows = identifyingFindings(findings);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());

  const maskable = rows.filter(isMaskable).map((finding) => finding.path);
  const allRevealed = maskable.length > 0 && maskable.every((path) => revealed.has(path));

  function toggleAll() {
    setRevealed(allRevealed ? new Set() : new Set(maskable));
    announce?.(allRevealed ? "All values hidden" : "All values revealed");
  }

  function toggle(finding: Finding, label: string) {
    const next = new Set(revealed);
    const showing = !next.delete(finding.path);
    if (showing) next.add(finding.path);
    setRevealed(next);
    announce?.(`${label} ${showing ? "revealed" : "hidden"}`);
  }

  return (
    <section className="mt-10 border-t-2 border-signal pt-5">
      <h2 className="text-xl font-semibold text-ink">{`Findings (${rows.length})`}</h2>

      {rows.length === 0 ? (
        <p className="mt-3 text-shade">No fields were flagged.</p>
      ) : (
        <>
          {maskable.length > 0 && (
            <button
              type="button"
              onClick={toggleAll}
              className={`mt-3 cursor-pointer rounded-md border-2 border-rule px-4 py-1.5 text-ink hover:border-signal ${FOCUS_RING}`}
            >
              {allRevealed ? "Hide all" : "Reveal all"}
            </button>
          )}
          <ul className="mt-4 divide-y divide-rule">
            {rows.map((finding) => {
              const tag = formatTag(finding.tag);
              const label = finding.name ?? tag;
              return (
                <li key={finding.path} className="py-3">
                  <p className="break-words text-lg font-semibold text-ink">{label}</p>
                  {finding.name !== undefined && <p className="font-mono text-sm text-shade">{tag}</p>}
                  {finding.path.includes("/") && (
                    <p className="break-all font-mono text-xs text-shade">{finding.path}</p>
                  )}
                  <p className="mt-1">
                    <FieldValue
                      name={label}
                      value={finding.value}
                      vr={finding.vr}
                      length={finding.length}
                      flagged
                      revealed={revealed.has(finding.path)}
                      onToggle={() => toggle(finding, label)}
                    />
                  </p>
                  <p className="mt-1 text-sm">
                    <Reason finding={finding} />
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
