// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatTag } from "../model/tag";
import type { Finding } from "../model/types";
import { handleParse } from "../parse/handle";
import { useReveal } from "./field-value";
import { FindingsList as BareFindingsList } from "./findings-list";

// The list no longer owns its reveal state: the screen does. This owns it for a list on its own.
function FindingsList({ findings, announce }: { findings: Finding[]; announce?: (message: string) => void }) {
  const reveal = useReveal(findings, announce);
  return <BareFindingsList findings={findings} reveal={reveal} />;
}

afterEach(cleanup);

const bytes = new Uint8Array(fs.readFileSync(path.resolve(__dirname, "../../public/samples/single.dcm")));
const outcome = handleParse(bytes);
if (!outcome.ok) throw new Error(outcome.message);
const findings = outcome.findings;

const rowOf = (label: string | RegExp, n = 0) => screen.getAllByText(label)[n].closest("li") as HTMLElement;
const rows = () => screen.getAllByRole("listitem");

describe("the fixture's findings", () => {
  it("has 28 rows and the heading says so; the burned-in flag is not one of them", () => {
    render(<FindingsList findings={findings} />);

    expect(findings.length).toBe(29);
    expect(screen.getByRole("heading", { name: "Findings (28)" })).toBeTruthy();
    expect(rows()).toHaveLength(28);
    expect(screen.queryByText("Burned In Annotation")).toBeNull();
    expect(screen.queryByText("(0028,0301)")).toBeNull();
  });

  it("lists rows in the order it was given, which is classify's path order", () => {
    render(<FindingsList findings={findings} />);

    const expected = findings.filter((f) => f.kind !== "burned-in").map((f) => f.name ?? formatTag(f.tag));
    const shown = rows().map((li) => li.querySelector("p")?.textContent);
    expect(shown.length).toBe(28);
    expect(shown.slice(0, 3)).toEqual(["Media Storage SOP Instance UID", "SOP Instance UID", "Study Date"]);
    expect(shown).toEqual(expected);
  });

  it("does not re-sort what it is given", () => {
    const given: Finding[] = [
      { path: "00100010", tag: "00100010", vr: "PN", kind: "annex-e", action: "Z", name: "Zeta" },
      { path: "00080020", tag: "00080020", vr: "DA", kind: "annex-e", action: "Z", name: "Alpha" },
    ];
    render(<FindingsList findings={given} />);

    expect(rows().map((li) => li.querySelector("p")?.textContent)).toEqual(["Zeta", "Alpha"]);
  });
});

describe("a row", () => {
  it("shows the name, the formatted tag, the value and the reason with code and gloss", () => {
    render(<FindingsList findings={findings} />);
    const row = within(rowOf("Patient's Name"));

    expect(row.getByText("Patient's Name")).toBeTruthy();
    expect(row.getByText("(0010,0010)")).toBeTruthy();
    expect(row.getByRole("img", { name: "hidden value" })).toBeTruthy();
    expect(row.getByText("Z")).toBeTruthy();
    expect(row.getByText("blank, or replace with a dummy", { exact: false })).toBeTruthy();
  });

  it("shows the Z/D gloss for Patient ID, in words different from Z's", () => {
    render(<FindingsList findings={findings} />);
    const row = within(rowOf("Patient ID"));

    expect(row.getByText("Z/D")).toBeTruthy();
    expect(row.getByText("blank, or a dummy where the field cannot be empty", { exact: false })).toBeTruthy();
  });

  it("shows a multi-part action code with its gloss", () => {
    render(<FindingsList findings={findings} />);
    const row = within(rowOf("Institution Name"));

    expect(row.getByText("X/Z/D")).toBeTruthy();
    expect(row.getByText("remove, blank, or replace with a dummy", { exact: false })).toBeTruthy();
  });

  it("shows a formatted tag where the name goes for the three private findings, and the private reason with no action", () => {
    render(<FindingsList findings={findings} />);

    for (const tag of ["(0029,0010)", "(0029,1001)", "(0029,1002)"]) {
      const li = rowOf(tag);
      expect(li.querySelector("p")?.textContent, tag).toBe(tag);
      expect(within(li).getAllByText(tag)).toHaveLength(1);
      expect(within(li).getByText("private tag, contents defined by the manufacturer")).toBeTruthy();
      expect(li.textContent).not.toMatch(/\b(remove|replace|blank|keep|clean)\b/);
    }
  });

  it("shows the canonical path under a nested finding, and under no other", () => {
    render(<FindingsList findings={findings} />);

    const nested = "04000561/0/04000550/0/00080090";
    expect(within(rowOf(nested)).getByText("Referring Physician's Name")).toBeTruthy();
    const paths = [...document.querySelectorAll("p.font-mono.text-xs")].map((p) => p.textContent);
    expect(paths).toEqual(["04000561/0/04000550", nested]);
    expect(rows().filter((li) => li.querySelector("p.font-mono.text-xs"))).toHaveLength(2);
    expect(within(rowOf("Original Attributes Sequence")).queryByText(/^0400/)).toBeNull();
  });

  it("shows a sequence finding's value as (sequence), with nothing to reveal", () => {
    render(<FindingsList findings={findings} />);
    const row = within(rowOf("Original Attributes Sequence"));

    expect(row.getByText("(sequence)")).toBeTruthy();
    expect(row.queryByRole("button")).toBeNull();
  });

  it("shows a flagged binary value as its length", () => {
    const binary: Finding = { path: "60003000", tag: "60003000", vr: "OW", kind: "annex-e", action: "X", name: "Overlay Data", length: 2048 };
    render(<FindingsList findings={[binary]} />);

    expect(screen.getByText("<binary, 2,048 bytes>")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Reveal/ })).toBeNull();
  });

  it("throws rather than render a bare code when an action has no gloss", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unknown: Finding = { path: "00100010", tag: "00100010", vr: "PN", kind: "annex-e", action: "Q" };
    expect(() => render(<FindingsList findings={[unknown]} />)).toThrow('No gloss for action "Q"');
    spy.mockRestore();
  });
});

describe("masking in the list", () => {
  const dots = () => screen.queryAllByRole("img", { name: "hidden value" });

  it("starts with every text value masked, and names each control after its field", () => {
    render(<FindingsList findings={findings} />);

    expect(dots()).toHaveLength(26);
    expect(screen.getByRole("button", { name: "Reveal Patient's Name" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reveal (0029,0010)" })).toBeTruthy();
    expect(screen.queryByText("TESTPATIENT^SCANLINT")).toBeNull();
    expect(document.body.textContent).not.toContain("SCANLINT-TEST-0001");
  });

  it("reveals and re-hides one row without touching the others", async () => {
    const user = userEvent.setup();
    const announce = vi.fn();
    render(<FindingsList findings={findings} announce={announce} />);

    await user.click(screen.getByRole("button", { name: "Reveal Patient's Name" }));
    expect(screen.getByText("TESTPATIENT^SCANLINT")).toBeTruthy();
    expect(dots()).toHaveLength(25);
    expect(announce).toHaveBeenLastCalledWith("Patient's Name revealed");

    await user.click(screen.getByRole("button", { name: "Hide Patient's Name" }));
    expect(screen.queryByText("TESTPATIENT^SCANLINT")).toBeNull();
    expect(dots()).toHaveLength(26);
    expect(announce).toHaveBeenLastCalledWith("Patient's Name hidden");
  });

  it("Reveal all reveals every row, and Hide all re-masks them", async () => {
    const user = userEvent.setup();
    const announce = vi.fn();
    render(<FindingsList findings={findings} announce={announce} />);

    await user.click(screen.getByRole("button", { name: "Reveal all" }));
    expect(dots()).toHaveLength(0);
    expect(screen.getByText("TESTPATIENT^SCANLINT")).toBeTruthy();
    expect(screen.getByText("PRIVATE-NOTE-ONE")).toBeTruthy();
    expect(screen.getByText("NESTED^REFERRER")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide Patient's Name" })).toBeTruthy();
    expect(announce).toHaveBeenLastCalledWith("All values revealed");

    await user.click(screen.getByRole("button", { name: "Hide all" }));
    expect(dots()).toHaveLength(26);
    expect(screen.queryByText("TESTPATIENT^SCANLINT")).toBeNull();
    expect(screen.getByRole("button", { name: "Reveal all" })).toBeTruthy();
    expect(announce).toHaveBeenLastCalledWith("All values hidden");
  });

  it("offers Hide all once the last masked value has been revealed one by one", async () => {
    const user = userEvent.setup();
    const two: Finding[] = [
      { path: "00100010", tag: "00100010", vr: "PN", kind: "annex-e", action: "Z", name: "A", value: "a" },
      { path: "00100020", tag: "00100020", vr: "LO", kind: "annex-e", action: "Z", name: "B", value: "b" },
    ];
    render(<FindingsList findings={two} />);

    await user.click(screen.getByRole("button", { name: "Reveal A" }));
    expect(screen.getByRole("button", { name: "Reveal all" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Reveal B" }));
    expect(screen.getByRole("button", { name: "Hide all" })).toBeTruthy();
  });

  it("shows (empty), not dots, for an empty flagged value", () => {
    const empty: Finding = { path: "00100010", tag: "00100010", vr: "PN", kind: "annex-e", action: "Z", name: "Patient's Name", value: "" };
    render(<FindingsList findings={[empty]} />);

    expect(screen.getByText("(empty)")).toBeTruthy();
    expect(dots()).toHaveLength(0);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("no findings", () => {
  it("says so, and offers no Reveal all", () => {
    render(<FindingsList findings={[]} />);

    expect(screen.getByRole("heading", { name: "Findings (0)" })).toBeTruthy();
    expect(screen.getByText("No fields were flagged.")).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("counts only identifying findings: a lone burned-in flag is zero", () => {
    const burned: Finding = { path: "00280301", tag: "00280301", vr: "CS", kind: "burned-in", value: "YES" };
    render(<FindingsList findings={[burned]} />);

    expect(screen.getByRole("heading", { name: "Findings (0)" })).toBeTruthy();
    expect(screen.queryByText("YES")).toBeNull();
  });
});

describe("an implicit-VR file", () => {
  const implicit = handleParse(new Uint8Array(fs.readFileSync(path.resolve(__dirname, "../../fixtures/single-implicit.dcm"))));
  if (!implicit.ok) throw new Error(implicit.message);

  it("lists the same 28 findings, with real values behind the masks", async () => {
    const user = userEvent.setup();
    render(<FindingsList findings={implicit.findings} />);

    expect(screen.getByRole("heading", { name: "Findings (28)" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Reveal Patient's Name" }));
    expect(screen.getByText("TESTPATIENT^SCANLINT")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Reveal all" }));
    expect(screen.getByText("SCANLINT-TEST-0001")).toBeTruthy();
    expect(screen.getByText("NESTED^REFERRER")).toBeTruthy();
  });

  it("shows the three private findings as a byte count, since their VR cannot be known, and offers no reveal for them", () => {
    render(<FindingsList findings={implicit.findings} />);

    for (const [tag, bytes] of [["(0029,0010)", 14], ["(0029,1001)", 16], ["(0029,1002)", 16]] as const) {
      const row = within(rowOf(tag));
      expect(row.getByText(`<binary, ${bytes} bytes>`), tag).toBeTruthy();
      expect(row.queryByRole("button"), tag).toBeNull();
      expect(row.getByText("private tag, contents defined by the manufacturer"), tag).toBeTruthy();
    }
  });
});
