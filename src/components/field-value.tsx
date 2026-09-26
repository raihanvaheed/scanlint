import { isBinaryVr } from "../model/vr";
import { FOCUS_RING } from "./focus";

// Always eight, whatever the real length: a dot per character would leak the length of a name.
export const MASK = "●●●●●●●●";

type Maskable = { value?: string; vr: string };

/** Whether there is anything to hide. Empty values, binary values and sequences have no text to mask. */
export function isMaskable({ value, vr }: Maskable): boolean {
  return !isBinaryVr(vr) && value !== undefined && value !== "";
}

type FieldValueProps = Maskable & {
  /** The field's name, or its formatted tag when it has none. Names the reveal control. */
  name: string;
  length?: number;
  flagged: boolean;
  revealed: boolean;
  onToggle: () => void;
};

function plainText({ value, vr, length }: Maskable & { length?: number }): string {
  if (isBinaryVr(vr)) {
    if (length === undefined) return "<binary, length not stated>";
    return `<binary, ${length.toLocaleString("en-US")} ${length === 1 ? "byte" : "bytes"}>`;
  }
  if (value === "") return "(empty)";
  if (value === undefined) return vr === "SQ" ? "(sequence)" : "(not shown)";
  return value;
}

/** The one place a value is masked or shown. Findings and the tree both render values through here. */
export function FieldValue({ name, value, vr, length, flagged, revealed, onToggle }: FieldValueProps) {
  const masked = flagged && isMaskable({ value, vr }) && !revealed;

  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
      {masked ? (
        <span role="img" aria-label="hidden value" className="text-ink">
          {MASK}
        </span>
      ) : (
        <span className="break-all text-ink">{plainText({ value, vr, length })}</span>
      )}
      {flagged && isMaskable({ value, vr }) && (
        <button
          type="button"
          onClick={onToggle}
          aria-label={`${revealed ? "Hide" : "Reveal"} ${name}`}
          className={`cursor-pointer rounded border border-rule px-2 py-0.5 text-sm text-ink hover:border-signal ${FOCUS_RING}`}
        >
          {revealed ? "Hide" : "Reveal"}
        </button>
      )}
    </span>
  );
}
