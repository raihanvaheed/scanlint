"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { flattenNodes } from "../model/tree";
import type { Finding, TagNode } from "../model/types";
import type { ParseOutcome } from "../parse/protocol";
import { FieldTree } from "./field-tree";
import { useReveal } from "./field-value";
import { FindingsList } from "./findings-list";
import { FOCUS_RING, FOCUS_RING_WITHIN, TREE_HEADING_ID } from "./focus";
import { SkipLink } from "./skip-link";

type LoadScreenProps = {
  parse: (bytes: ArrayBuffer) => Promise<ParseOutcome>;
  loadSample: () => Promise<ArrayBuffer>;
};

type Counted = "annex-e" | "private";

type Summary = { fields: number; findings: number; byKind: Record<Counted, number>; burnedIn: string[] };

type View =
  | { kind: "idle" }
  | { kind: "loading"; name: string }
  | { kind: "loaded"; name: string; summary: Summary; nodes: TagNode[]; findings: Finding[] }
  | { kind: "error"; headline: string; detail: string };

const SAMPLE_NAME = "single.dcm";

const BREAKDOWN: { kind: Counted; label: string }[] = [
  { kind: "annex-e", label: "named in the DICOM confidentiality profile" },
  { kind: "private", label: "private tags, contents defined by the manufacturer" },
];

const BURNED_IN_CAVEAT = "ScanLint reports what this field says. It cannot see text printed into the image itself.";

// The burned-in flag is a statement about the image, not a field holding patient data, so it is
// reported as the file's own claim and is not counted as identifying.
function summarise(nodes: TagNode[], findings: Finding[]): Summary {
  const byKind: Record<Counted, number> = { "annex-e": 0, private: 0 };
  const burnedIn: string[] = [];
  for (const finding of findings) {
    if (finding.kind === "burned-in") burnedIn.push(finding.value ?? "");
    else byKind[finding.kind] += 1;
  }
  return { fields: flattenNodes(nodes).length, findings: byKind["annex-e"] + byKind.private, byKind, burnedIn };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Mounted only while a result is on screen, so the reveal state it holds is gone when the user leaves it.
function LoadedResult({ nodes, findings, announce }: { nodes: TagNode[]; findings: Finding[]; announce: (message: string) => void }) {
  const reveal = useReveal(findings, announce);

  return (
    <>
      <SkipLink targetId={TREE_HEADING_ID}>Skip to all fields</SkipLink>
      <FindingsList findings={findings} reveal={reveal} />
      <FieldTree nodes={nodes} findings={findings} reveal={reveal} />
    </>
  );
}

export function LoadScreen({ parse, loadSample }: LoadScreenProps) {
  const [view, setView] = useState<View>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const sampleButton = useRef<HTMLButtonElement>(null);
  const anotherButton = useRef<HTMLButtonElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const [announcement, setAnnouncement] = useState("");
  const previousKind = useRef(view.kind);

  useEffect(() => {
    if (previousKind.current !== view.kind) {
      if (view.kind === "idle") sampleButton.current?.focus();
      // The result is long, so focus goes to its top. The button is at the bottom, after every row.
      if (view.kind === "loaded") resultHeading.current?.focus();
      if (view.kind === "error") anotherButton.current?.focus();
    }
    previousKind.current = view.kind;
  }, [view.kind]);

  // The buffer is transferred to the worker by `parse` and must not be used afterwards.
  async function analyse(name: string, readBytes: () => Promise<ArrayBuffer>, readFailure: string) {
    setAnnouncement("");
    setView({ kind: "loading", name });

    let bytes: ArrayBuffer;
    try {
      bytes = await readBytes();
    } catch (e) {
      setView({ kind: "error", headline: readFailure, detail: messageOf(e) });
      return;
    }

    try {
      const outcome = await parse(bytes);
      setView(
        outcome.ok
          ? {
              kind: "loaded",
              name,
              summary: summarise(outcome.nodes, outcome.findings),
              nodes: outcome.nodes,
              findings: outcome.findings,
            }
          : { kind: "error", headline: "This file could not be read as DICOM.", detail: outcome.message },
      );
    } catch (e) {
      setView({ kind: "error", headline: "Something went wrong while reading this file.", detail: messageOf(e) });
    }
  }

  function readFile(file: File) {
    void analyse(file.name, () => file.arrayBuffer(), "This file could not be read.");
  }

  function onChoose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) readFile(file);
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) readFile(file);
  }

  return (
    <main className="mx-auto max-w-160 px-6 py-16 sm:py-24">
      <header>
        <h1 className="text-[2.5rem] font-bold text-ink">ScanLint</h1>
        <div className="mt-3 h-0.75 w-16 bg-signal" />
        <p className="mt-5 text-xl text-ink">Find identifying information hidden in medical image files.</p>
      </header>

      <div className="mt-10">
        {view.kind === "idle" && (
          <div
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={`flex flex-col items-center rounded-lg border-2 border-dashed px-6 py-10 text-center ${
              dragging ? "border-signal bg-paper" : "border-shade bg-surface"
            }`}
          >
            <p className="text-xl text-ink">Drop a DICOM file here</p>
            <label className={`mt-2 cursor-pointer rounded text-ink underline underline-offset-4 ${FOCUS_RING_WITHIN}`}>
              or choose a file
              <input type="file" onChange={onChoose} className="sr-only" />
            </label>
            <button
              ref={sampleButton}
              type="button"
              onClick={() => void analyse(SAMPLE_NAME, loadSample, "The sample file could not be loaded.")}
              className={`mt-8 cursor-pointer rounded-md border-2 border-transparent bg-signal px-[30px] py-2.5 text-lg font-semibold text-paper hover:brightness-110 ${FOCUS_RING}`}
            >
              Load sample
            </button>
          </div>
        )}

        <div aria-live="polite" role="status">
          {view.kind === "loading" && (
            <div>
              <p className="text-ink">
                Reading <span className="font-semibold">{view.name}</span>…
              </p>
              <div aria-hidden="true" className="mt-4 h-1 w-full overflow-hidden rounded bg-rule">
                <div className="h-full w-1/3 bg-signal motion-safe:animate-pulse" />
              </div>
            </div>
          )}

          {view.kind === "loaded" && (
            <div>
              <h2 ref={resultHeading} tabIndex={-1} className="break-all rounded text-lg font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal">
                {view.name}
              </h2>
              <p className="mt-4 text-2xl font-semibold text-ink">
                {`${view.summary.fields} field${view.summary.fields === 1 ? "" : "s"} read`}
              </p>
              <p className="mt-1 text-2xl font-semibold text-ink">
                {`${view.summary.findings} could identify a patient`}
              </p>
              {BREAKDOWN.some(({ kind }) => view.summary.byKind[kind] > 0) && (
                <ul className="mt-6 space-y-3 text-ink">
                  {BREAKDOWN.filter(({ kind }) => view.summary.byKind[kind] > 0).map(({ kind, label }) => (
                    <li key={kind} className="flex gap-4">
                      <span className="w-8 shrink-0 text-right font-semibold tabular-nums">{view.summary.byKind[kind]}</span>
                      <span>{label}</span>
                    </li>
                  ))}
                </ul>
              )}
              {view.summary.burnedIn.length > 0 && (
                <div className="mt-6">
                  {view.summary.burnedIn.map((value, index) => (
                    <p key={index} className="text-ink">
                      {`This file declares burned-in annotation: ${value === "" ? "(empty)" : value}`}
                    </p>
                  ))}
                  <p className="mt-1 text-sm text-shade">{BURNED_IN_CAVEAT}</p>
                </div>
              )}
              <p className="sr-only">{announcement}</p>
            </div>
          )}

          {view.kind === "error" && (
            <div>
              <p className="text-xl text-ink">{view.headline}</p>
              <p className="mt-2 break-words text-sm text-shade">{view.detail}</p>
            </div>
          )}
        </div>

        {view.kind === "loaded" && (
          <LoadedResult nodes={view.nodes} findings={view.findings} announce={setAnnouncement} />
        )}

        {(view.kind === "loaded" || view.kind === "error") && (
          <button
            ref={anotherButton}
            type="button"
            onClick={() => setView({ kind: "idle" })}
            className={`mt-8 cursor-pointer rounded-md border-2 border-shade px-5 py-2 text-ink hover:border-signal ${FOCUS_RING}`}
          >
            Load another file
          </button>
        )}
      </div>

      <p className="mt-6 text-sm text-shade">Files are read in your browser. Nothing is uploaded.</p>
    </main>
  );
}
