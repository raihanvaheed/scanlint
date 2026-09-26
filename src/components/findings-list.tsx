"use client";

import { ACTION_GLOSS } from "../model/actions";
import { formatTag } from "../model/tag";
import { identifyingFindings } from "../model/tree";
import type { Finding } from "../model/types";
import { FieldValue } from "./field-value";
import type { Reveal } from "./field-value";
import { FINDINGS_HEADING_ID, FOCUS_RING, HEADING_FOCUS_RING } from "./focus";

type FindingsListProps = {
  /** Every finding for the file. The burned-in flag is dropped here: the summary already states it. */
  findings: Finding[];
  /** Shared with the tree, so a value revealed here is revealed there. Owned by the result. */
  reveal: Reveal;
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

export function FindingsList({ findings, reveal }: FindingsListProps) {
  const rows = identifyingFindings(findings);
  const { revealed, hasMaskable, allRevealed, toggle, toggleAll } = reveal;

  return (
    <section className="mt-10 border-t-2 border-signal pt-5">
      <h2 id={FINDINGS_HEADING_ID} tabIndex={-1} className={`text-xl font-semibold text-ink ${HEADING_FOCUS_RING}`}>
        {`Findings (${rows.length})`}
      </h2>

      {rows.length === 0 ? (
        <p className="mt-3 text-shade">No fields were flagged.</p>
      ) : (
        <>
          {hasMaskable && (
            <button
              type="button"
              onClick={toggleAll}
              className={`mt-3 cursor-pointer rounded-md border-2 border-shade px-4 py-1.5 text-ink hover:border-signal ${FOCUS_RING}`}
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
                      onToggle={() => toggle(finding.path, label)}
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
