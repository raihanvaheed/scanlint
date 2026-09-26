// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Finding, TagNode } from "../model/types";
import { handleParse } from "../parse/handle";
import { useReveal } from "./field-value";
import { FieldTree as BareFieldTree } from "./field-tree";

// The tree no longer owns its reveal state: the screen does. This owns it for a tree on its own.
function FieldTree({ nodes, findings, announce }: { nodes: TagNode[]; findings: Finding[]; announce?: (message: string) => void }) {
  const reveal = useReveal(findings, announce);
  return <BareFieldTree nodes={nodes} findings={findings} reveal={reveal} />;
}

afterEach(cleanup);

const bytes = new Uint8Array(fs.readFileSync(path.resolve(__dirname, "../../public/samples/single.dcm")));
const outcome = handleParse(bytes);
if (!outcome.ok) throw new Error(outcome.message);
const { nodes, findings } = outcome;

// happy-dom does not hide the contents of a closed <details>, so "shown" means every enclosing one is open.
function shown(element: Element): boolean {
  for (let el = element.parentElement; el; el = el.parentElement) {
    if (el instanceof HTMLDetailsElement && !el.open && !el.querySelector(":scope > summary")?.contains(element)) return false;
  }
  return true;
}

const summaryOf = (text: string | RegExp, n = 0) => screen.getAllByText(text)[n].closest("summary") as HTMLElement;

async function openTree(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("heading", { name: "All fields (55)" }));
}

describe("collapsed by default", () => {
  it("has a heading with the field count, and shows no row until opened", () => {
    render(<FieldTree nodes={nodes} findings={findings} />);

    expect(screen.getByRole("heading", { name: "All fields (55)" })).toBeTruthy();
    expect((document.querySelector("section > details") as HTMLDetailsElement).open).toBe(false);
    expect(shown(screen.getByText("Patient's Name"))).toBe(false);
    expect(shown(screen.getByRole("heading", { name: "All fields (55)" }))).toBe(true);
  });

  // happy-dom does not turn Enter or Space on a summary into a toggle, as a browser does, so the
  // keyboard operation itself is checked in a real browser. What can be checked here is that the
  // summary is a plain native one, first in the tab order, with no handler of ours in the way.
  it("puts the native summary next in the tab order after the skip link, with no key handling of its own", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Back to findings" }));
    await user.tab();
    const summary = document.querySelector("section > details > summary") as HTMLElement;
    expect(document.activeElement).toBe(summary);
    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.getAttribute("tabindex")).toBeNull();
    expect(summary.getAttribute("onkeydown")).toBeNull();
  });

  it("is a native details/summary and nested lists, not an ARIA tree", () => {
    const { container } = render(<FieldTree nodes={nodes} findings={findings} />);

    expect(container.querySelector('[role="tree"], [role="treeitem"]')).toBeNull();
    expect(container.querySelectorAll("details").length).toBeGreaterThan(1);
  });
});

describe("opened", () => {
  it("shows all 53 top-level rows", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    const topList = document.querySelector("section > details > div > ul") as HTMLElement;
    expect(topList.children).toHaveLength(53);
    expect(shown(screen.getByText("Patient's Name"))).toBe(true);
    expect(shown(screen.getByText("Modality"))).toBe(true);
  });

  it("shows a row's name, tag, VR and value", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    const row = within(screen.getByText("Modality").closest("li") as HTMLElement);
    expect(row.getByText("(0008,0060)")).toBeTruthy();
    expect(row.getByText("CS")).toBeTruthy();
    expect(row.getByText("MR")).toBeTruthy();
  });

  it("shows a sequence with its item count, expanding to Item 1", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    const summary = summaryOf("Original Attributes Sequence (1 item)");
    const details = summary.parentElement as HTMLDetailsElement;
    const itemOne = () => details.querySelector(":scope > ol > li > details > summary") as HTMLElement;
    expect(details.open).toBe(false);
    expect(itemOne().textContent).toBe("▸Item 1");
    expect(shown(itemOne())).toBe(false);

    await user.click(summary);
    expect(details.open).toBe(true);
    expect(shown(itemOne())).toBe(true);
    expect(screen.queryByText("Item 0")).toBeNull();
  });

  it("uses the plural for a sequence with several items, and the tag when it has no name", async () => {
    const user = userEvent.setup();
    const item = (path: string): TagNode[] => [{ tag: "00100020", path, vr: "LO", name: "Patient ID", value: "x" }];
    const seq: TagNode = { tag: "00291000", path: "00291000", vr: "SQ", lengthEncoding: "defined", items: [item("00291000/0/00100020"), item("00291000/1/00100020")] };
    render(<FieldTree nodes={[seq]} findings={[]} />);
    await user.click(screen.getByRole("heading", { name: "All fields (3)" }));

    expect(screen.getByText("(0029,1000) (2 items)")).toBeTruthy();
    const details = screen.getByText("(0029,1000) (2 items)").closest("details") as HTMLElement;
    const items = [...details.querySelectorAll(":scope > ol > li > details > summary")].map((el) => el.textContent);
    expect(items).toEqual(["▸Item 1", "▸Item 2"]);
  });

  it("reaches the nested finding by expanding the sequences and their items, and marks it", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    const nestedName = () => screen.getAllByText("Referring Physician's Name")[1];
    expect(shown(nestedName())).toBe(false);

    await user.click(summaryOf("Original Attributes Sequence (1 item)"));
    await user.click(summaryOf("Item 1", 0));
    expect(shown(nestedName())).toBe(false);
    await user.click(summaryOf("Modified Attributes Sequence (1 item)"));
    await user.click(summaryOf("Item 1", 1));

    expect(shown(nestedName())).toBe(true);
    const mark = nestedName().closest(".border-l-4") as HTMLElement;
    expect(mark.classList.contains("border-signal")).toBe(true);
    expect(within(mark).getByText("Finding:", { exact: false })).toBeTruthy();
    expect(within(mark).getByText("finding")).toBeTruthy();
  });
});

describe("marking findings", () => {
  it("marks exactly the 28 identifying findings, by shape and by words, and not the burned-in flag", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    expect(document.querySelectorAll(".border-l-4.border-signal")).toHaveLength(28);
    expect(screen.getAllByText("finding")).toHaveLength(28);
    const burnedIn = screen.getByText("Burned In Annotation").closest("[data-finding]") as HTMLElement;
    expect(burnedIn.getAttribute("data-finding")).toBe("false");
    expect(burnedIn.classList.contains("border-signal")).toBe(false);
    expect(within(burnedIn).queryByText("finding")).toBeNull();
  });

  it("marks both sequences in the fixture", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    for (const text of ["Original Attributes Sequence (1 item)", "Modified Attributes Sequence (1 item)"]) {
      const mark = summaryOf(text).querySelector(".border-l-4") as HTMLElement;
      expect(mark.classList.contains("border-signal"), text).toBe(true);
      expect(within(mark).getByText("finding")).toBeTruthy();
    }
  });

  it("does not mark a kept field", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    const mark = screen.getByText("Modality").closest("[data-finding]") as HTMLElement;
    expect(mark.getAttribute("data-finding")).toBe("false");
    expect(mark.classList.contains("border-signal")).toBe(false);
    expect(within(mark).queryByText("finding")).toBeNull();
  });
});

describe("masking in the tree", () => {
  it("masks a flagged value, with a control named after the field, and reveals it on request", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    expect(screen.queryByText("TESTPATIENT^SCANLINT")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Reveal Patient's Name" }));
    expect(screen.getByText("TESTPATIENT^SCANLINT")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Hide Patient's Name" }));
    expect(screen.queryByText("TESTPATIENT^SCANLINT")).toBeNull();
  });

  it("never masks a kept field, and gives it no control", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    for (const [name, value] of [["Modality", "MR"], ["Slice Thickness", "5.0"], ["Transfer Syntax UID", "1.2.840.10008.1.2.1"]]) {
      const row = within(screen.getByText(name).closest("li") as HTMLElement);
      expect(row.getByText(value), name).toBeTruthy();
      expect(row.queryByRole("button"), name).toBeNull();
      expect(row.queryByRole("img"), name).toBeNull();
    }
  });

  it("masks 25 values in the tree before any reveal: every flagged text value, none of the kept ones", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    expect(screen.getAllByRole("img", { name: "hidden value" })).toHaveLength(26);
  });

  it("shows the length of the binary elements, and never their bytes", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    expect(within(screen.getByText("Pixel Data").closest("li") as HTMLElement).getByText("<binary, 131,072 bytes>")).toBeTruthy();
    expect(within(screen.getByText("File Meta Information Version").closest("li") as HTMLElement).getByText("<binary, 2 bytes>")).toBeTruthy();
  });
});

describe("a row with no name", () => {
  it("shows its tag alone in the name position", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    for (const tag of ["(0029,0010)", "(0029,1001)", "(0029,1002)"]) {
      const li = screen.getByText(tag).closest("li") as HTMLElement;
      expect(within(li).getAllByText(tag), tag).toHaveLength(1);
      expect(within(li).getByText("LO")).toBeTruthy();
      expect(within(li).getByRole("button", { name: `Reveal ${tag}` })).toBeTruthy();
    }
  });
});

describe("accessibility", () => {
  it("is not inside a live region, so expanding a sequence is not read out in full", () => {
    const { container } = render(<FieldTree nodes={nodes} findings={findings} />);
    expect(container.closest("[aria-live]")).toBeNull();
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(container.querySelector('[role="status"], [role="alert"], [role="log"]')).toBeNull();
  });
});

describe("with no findings", () => {
  it("marks nothing", async () => {
    const user = userEvent.setup();
    const flat: Finding[] = [];
    render(<FieldTree nodes={nodes} findings={flat} />);
    await openTree(user);

    expect(document.querySelectorAll(".border-l-4.border-signal")).toHaveLength(0);
    expect(screen.queryAllByRole("img", { name: "hidden value" })).toHaveLength(0);
  });
});

describe("values the walker now reads", () => {
  it("shows numbers where the tree used to say (not shown)", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    expect(screen.queryByText("(not shown)")).toBeNull();
    for (const [name, value] of [["Rows", "256"], ["Columns", "256"], ["Bits Allocated", "16"], ["Bits Stored", "12"], ["High Bit", "11"], ["Samples per Pixel", "1"], ["Pixel Representation", "0"], ["File Meta Information Group Length", "198"]]) {
      const row = within(screen.getByText(name).closest("li") as HTMLElement);
      expect(row.getByText(value), name).toBeTruthy();
      expect(row.queryByRole("button"), name).toBeNull();
    }
  });
});

function fixtureOutcome(rel: string) {
  const parsed = handleParse(new Uint8Array(fs.readFileSync(path.resolve(__dirname, "../..", rel))));
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed;
}

describe("an implicit-VR file", () => {
  it("shows the same readable values as the explicit file, masked and revealable", async () => {
    const user = userEvent.setup();
    const implicit = fixtureOutcome("fixtures/single-implicit.dcm");
    render(<FieldTree nodes={implicit.nodes} findings={implicit.findings} />);
    await openTree(user);

    expect(screen.getAllByText(/^<binary, /).map((el) => el.textContent)).toEqual([
      "<binary, 14 bytes>",
      "<binary, 16 bytes>",
      "<binary, 16 bytes>",
      "<binary, 131,072 bytes>",
      "<binary, 2 bytes>",
    ]);
    await user.click(screen.getByRole("button", { name: "Reveal Patient's Name" }));
    expect(screen.getByText("TESTPATIENT^SCANLINT")).toBeTruthy();
    expect(within(screen.getByText("Rows").closest("li") as HTMLElement).getByText("256")).toBeTruthy();
  });
});

describe("a file with compressed pixel data", () => {
  it("says the length of Pixel Data is not stated", async () => {
    const user = userEvent.setup();
    const compressed = fixtureOutcome("fixtures/single-rle.dcm");
    render(<FieldTree nodes={compressed.nodes} findings={compressed.findings} />);
    await openTree(user);

    const row = within(screen.getByText("Pixel Data").closest("li") as HTMLElement);
    expect(row.getByText("<binary, length not stated>")).toBeTruthy();
    expect(document.body.textContent).not.toContain("4,294,967,295");
    expect(document.body.textContent).not.toContain("4294967295");
  });
});

describe("the finding label", () => {
  it("sits on the same line as the name, tag and VR, not below the value", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    const row = screen.getByText("Patient's Name").closest("li") as HTMLElement;
    const label = within(row).getByText("finding");
    const tag = within(row).getByText("(0010,0010)");
    const value = row.querySelector("div.mt-1") as HTMLElement;

    expect(label.parentElement).toBe(tag.parentElement);
    expect(label.previousElementSibling?.textContent).toBe("PN");
    expect(tag.nextElementSibling?.textContent).toBe("PN");
    expect(value.contains(label)).toBe(false);
    expect(label.compareDocumentPosition(value) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("still has the screen-reader prefix and the signal border", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    const mark = screen.getByText("Patient's Name").closest(".border-l-4") as HTMLElement;
    expect(mark.classList.contains("border-signal")).toBe(true);
    expect(mark.querySelector(".sr-only")?.textContent).toBe("Finding: ");
  });

  it("is beside the title of a sequence too", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    const summary = summaryOf("Original Attributes Sequence (1 item)");
    const label = within(summary).getByText("finding");
    expect(label.parentElement).toBe(within(summary).getByText("(0400,0561)").parentElement);
  });
});

describe("forced colours and the accessible name", () => {
  it("draws no border at all on a kept row, so forced-colours mode cannot turn it into a marker", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    const kept = [...document.querySelectorAll('[data-finding="false"]')] as HTMLElement[];
    expect(kept.length).toBeGreaterThan(20);
    for (const mark of kept) expect(mark.className).not.toMatch(/border/);
    const flaggedMarks = [...document.querySelectorAll('[data-finding="true"]')] as HTMLElement[];
    expect(flaggedMarks).toHaveLength(28);
    for (const mark of flaggedMarks) expect(mark.className).toContain("border-l-4");
  });

  it("separates the parts of a row's name with spaces, so a screen reader does not run them together", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    const summary = summaryOf("Original Attributes Sequence (1 item)");
    expect(summary.textContent).toBe("▸Finding: Original Attributes Sequence (1 item) (0400,0561) SQ finding");
    const row = screen.getByText("Patient's Name").closest("[data-finding]") as HTMLElement;
    expect(row.textContent).toMatch(/^Finding: Patient's Name \(0010,0010\) PN finding/);
  });
});

describe("the word finding is not read twice", () => {
  // What an accessibility tree would give as a name: the text, less anything hidden from it.
  const raw = (el: Element): string =>
    [...el.childNodes]
      .map((n) => (n.nodeType === Node.TEXT_NODE ? (n.textContent ?? "") : (n as Element).getAttribute("aria-hidden") === "true" ? "" : raw(n as Element)))
      .join("");
  const spoken = (el: Element): string => raw(el).replace(/\s+/g, " ").trim();

  it("hides the visible label from assistive technology, and keeps the screen-reader prefix", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    const labels = screen.getAllByText("finding");
    expect(labels).toHaveLength(28);
    for (const label of labels) expect(label.getAttribute("aria-hidden")).toBe("true");
    const prefixes = [...document.querySelectorAll(".sr-only")].filter((el) => el.textContent === "Finding: ");
    expect(prefixes).toHaveLength(28);
  });

  it("gives a sequence summary a name that begins Finding: and does not end in finding", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    const name = spoken(summaryOf("Original Attributes Sequence (1 item)").querySelector("span.min-w-0") as Element);
    expect(name).toBe("Finding: Original Attributes Sequence (1 item) (0400,0561) SQ");
    expect(name.toLowerCase()).not.toMatch(/finding$/);
    expect(name.toLowerCase().split("finding").length - 1).toBe(1);
  });

  it("says finding once for a plain row too", async () => {
    const user = userEvent.setup();
    render(<FieldTree nodes={nodes} findings={findings} />);
    await openTree(user);

    const row = screen.getByText("Patient's Name").closest("[data-finding]") as HTMLElement;
    expect(spoken(row)).toMatch(/^Finding: Patient's Name \(0010,0010\) PN/);
    expect(spoken(row).toLowerCase().split("finding").length - 1).toBe(1);
  });
});
