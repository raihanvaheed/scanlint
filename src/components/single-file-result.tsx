"use client";

import type { Ref } from "react";
import { flattenNodes } from "../model/tree";
import type { Finding, TagNode } from "../model/types";
import type { DecodeOptions, DecodeOutcome } from "../pixels/protocol";
import { FieldTree } from "./field-tree";
import { useReveal } from "./field-value";
import { FindingsList } from "./findings-list";
import { TREE_HEADING_ID } from "./focus";
import { ImagePreview } from "./image-preview";
import type { SteppingProps } from "./image-preview";
import { SkipLink } from "./skip-link";

/** What `SingleFileDetails` needs to offer the image preview - a way to re-read the file's bytes
 * and a way to decode them, both lazy: neither runs until `Show image` is clicked (see
 * ImagePreview). `fileKey` is the file's stable identity (a series drill-down's map key, which can
 * differ from the displayed name); `stepping` is present only for a slice reached from a series. */
export type ImageAccess = {
  fileKey: string;
  getBytes: () => Promise<ArrayBuffer>;
  decode: (bytes: ArrayBuffer, options?: DecodeOptions) => Promise<DecodeOutcome>;
  stepping?: SteppingProps;
};

type Counted = "annex-e" | "private";

export type FileSummary = { fields: number; findings: number; byKind: Record<Counted, number>; burnedIn: string[] };

const BREAKDOWN: { kind: Counted; label: string }[] = [
  { kind: "annex-e", label: "named in the DICOM confidentiality profile" },
  { kind: "private", label: "private tags, contents defined by the manufacturer" },
];

export const BURNED_IN_CAVEAT = "ScanLint reports what this field says. It cannot see text printed into the image itself.";

// The burned-in flag is a statement about the image, not a field holding patient data, so it is
// reported as the file's own claim and is not counted as identifying.
export function summariseFile(nodes: TagNode[], findings: Finding[]): FileSummary {
  const byKind: Record<Counted, number> = { "annex-e": 0, private: 0 };
  const burnedIn: string[] = [];
  for (const finding of findings) {
    if (finding.kind === "burned-in") burnedIn.push(finding.value ?? "");
    else byKind[finding.kind] += 1;
  }
  return { fields: flattenNodes(nodes).length, findings: byKind["annex-e"] + byKind.private, byKind, burnedIn };
}

/**
 * The heading and summary counts: the part of the single-file view the top-level flow puts inside
 * its live region, so a load is announced without the findings list or field tree being read aloud
 * with it. Split from {@link SingleFileDetails} for exactly that reason - see `SingleFileResult`.
 */
export function SingleFileHeader({ name, nodes, findings, headingRef }: { name: string; nodes: TagNode[]; findings: Finding[]; headingRef?: Ref<HTMLHeadingElement> }) {
  const summary = summariseFile(nodes, findings);

  return (
    <div>
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="break-all rounded text-lg font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal"
      >
        {name}
      </h2>
      <p className="mt-4 text-2xl font-semibold text-ink">{`${summary.fields} field${summary.fields === 1 ? "" : "s"} read`}</p>
      <p className="mt-1 text-2xl font-semibold text-ink">{`${summary.findings} could identify a patient`}</p>
      {BREAKDOWN.some(({ kind }) => summary.byKind[kind] > 0) && (
        <ul className="mt-6 space-y-3 text-ink">
          {BREAKDOWN.filter(({ kind }) => summary.byKind[kind] > 0).map(({ kind, label }) => (
            <li key={kind} className="flex gap-4">
              <span className="w-8 shrink-0 text-right font-semibold tabular-nums">{summary.byKind[kind]}</span>
              <span>{label}</span>
            </li>
          ))}
        </ul>
      )}
      {summary.burnedIn.length > 0 && (
        <div className="mt-6">
          {summary.burnedIn.map((value, index) => (
            <p key={index} className="text-ink">
              {`This file declares burned-in annotation: ${value === "" ? "(empty)" : value}`}
            </p>
          ))}
          <p className="mt-1 text-sm text-shade">{BURNED_IN_CAVEAT}</p>
        </div>
      )}
    </div>
  );
}

/**
 * The findings list and full field tree: the part of the single-file view kept out of the live
 * region, mounted only while a result is on screen so its own reveal state is gone once it isn't.
 *
 * The image preview is the first thing rendered here, which - since `SingleFileHeader` and this
 * component are always adjacent siblings, in both the top-level flow and `SingleFileResult` below -
 * puts it immediately after the summary block and, when the file declares one, right after the
 * burned-in caveat: exactly where section 3 asks for it. A file with no such declaration still gets
 * the control (pattern-signed.dcm and friends have no BurnedInAnnotation tag at all); only the
 * caveat sentence itself stays conditional on that tag, unchanged from 2.x.
 */
export function SingleFileDetails({
  name,
  nodes,
  findings,
  announce,
  image,
}: {
  name: string;
  nodes: TagNode[];
  findings: Finding[];
  announce: (message: string) => void;
  image: ImageAccess;
}) {
  const reveal = useReveal(findings, announce);

  return (
    <>
      <ImagePreview fileKey={image.fileKey} fileLabel={name} getBytes={image.getBytes} decode={image.decode} announce={announce} stepping={image.stepping} />
      <SkipLink targetId={TREE_HEADING_ID}>Skip to all fields</SkipLink>
      <FindingsList findings={findings} reveal={reveal} />
      <FieldTree nodes={nodes} findings={findings} reveal={reveal} />
    </>
  );
}

/**
 * The whole single-file view, header and details together. The top-level single-file flow renders
 * {@link SingleFileHeader} and {@link SingleFileDetails} separately, either side of its live
 * region's boundary (a tested behaviour: a load is announced, the field-by-field content is not).
 * A slice drilled into from the series view has no such transition to announce - it opens on a
 * click, with focus moved explicitly - so this combined form is what it renders.
 */
export function SingleFileResult({
  name,
  nodes,
  findings,
  announce,
  headingRef,
  image,
}: {
  name: string;
  nodes: TagNode[];
  findings: Finding[];
  announce: (message: string) => void;
  headingRef?: Ref<HTMLHeadingElement>;
  image: ImageAccess;
}) {
  return (
    <div>
      <SingleFileHeader name={name} nodes={nodes} findings={findings} headingRef={headingRef} />
      <SingleFileDetails name={name} nodes={nodes} findings={findings} announce={announce} image={image} />
    </div>
  );
}
