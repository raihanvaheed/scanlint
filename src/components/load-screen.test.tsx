// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Finding, TagNode } from "../model/types";
import type { ParseOutcome } from "../parse/protocol";
import { LoadScreen } from "./load-screen";

afterEach(cleanup);

const node = (tag: string, items?: TagNode[][]): TagNode => ({ tag, path: tag, vr: "LO", ...(items ? { items } : {}) });

// Three nodes in total: one top-level node holding one nested node, plus one more top-level node.
const nodes = [node("00081140", [[node("00100020")]]), node("00080060")];

let counter = 0;
const finding = (kind: Finding["kind"], value?: string): Finding => ({
  path: `${String(0x00100010 + counter++).padStart(8, "0")}`,
  tag: "00100010",
  vr: "LO",
  kind,
  ...(kind === "annex-e" ? { action: "Z", name: `Field ${counter}` } : {}),
  ...(value === undefined ? {} : { value }),
});

function outcome(counts: { annex?: number; priv?: number; burned?: number }, burnedValue = "YES"): ParseOutcome {
  const findings = [
    ...Array.from({ length: counts.annex ?? 0 }, () => finding("annex-e", "SECRET")),
    ...Array.from({ length: counts.priv ?? 0 }, () => finding("private")),
    ...Array.from({ length: counts.burned ?? 0 }, () => finding("burned-in", burnedValue)),
  ];
  return { ok: true, nodes, findings };
}

const sampleBytes = new ArrayBuffer(8);
const CAVEAT = "ScanLint reports what this field says. It cannot see text printed into the image itself.";

function setup(parseResult: ParseOutcome | Error, loadResult: ArrayBuffer | Error = sampleBytes) {
  const parse = vi.fn<(bytes: ArrayBuffer) => Promise<ParseOutcome>>(() =>
    parseResult instanceof Error ? Promise.reject(parseResult) : Promise.resolve(parseResult),
  );
  const loadSample = vi.fn<() => Promise<ArrayBuffer>>(() =>
    loadResult instanceof Error ? Promise.reject(loadResult) : Promise.resolve(loadResult),
  );
  const view = render(<LoadScreen parse={parse} loadSample={loadSample} />);
  return { parse, loadSample, user: userEvent.setup(), ...view };
}

describe("idle", () => {
  it("shows Load sample, the file input and the privacy line", () => {
    setup(outcome({}));

    expect(screen.getByRole("button", { name: "Load sample" })).toBeTruthy();
    expect(screen.getByText("Drop a DICOM file here")).toBeTruthy();
    expect((screen.getByLabelText("or choose a file") as HTMLInputElement).type).toBe("file");
    expect(screen.getByText("Files are read in your browser. Nothing is uploaded.")).toBeTruthy();
  });

  it("gives the file input no accept attribute, because real DICOM files often have no extension", () => {
    setup(outcome({}));

    expect(screen.getByLabelText("or choose a file").hasAttribute("accept")).toBe(false);
  });

  it("has a polite aria-live status region", () => {
    const { container } = setup(outcome({}));

    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
  });
});

describe("loading the sample", () => {
  it("calls loadSample, then parse with its bytes, then shows the counts inside the live region", async () => {
    const { parse, loadSample, user, container } = setup(outcome({ annex: 3, priv: 2, burned: 1 }));

    await user.click(screen.getByRole("button", { name: "Load sample" }));

    expect(await screen.findByText("3 fields read")).toBeTruthy();
    expect(screen.getByText("5 could identify a patient")).toBeTruthy();
    expect(loadSample).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse.mock.calls[0][0]).toBe(sampleBytes);
    expect(loadSample.mock.invocationCallOrder[0]).toBeLessThan(parse.mock.invocationCallOrder[0]);
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain("3 fields read");
  });
});

describe("the breakdown", () => {
  it("shows two lines with the right counts, and counts only those in the headline", async () => {
    const { user } = setup(outcome({ annex: 25, priv: 3, burned: 1 }));
    await user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("28 could identify a patient");

    const lines = within(screen.getByText("private tags, contents defined by the manufacturer").closest("ul") as HTMLElement).getAllByRole("listitem");
    expect(lines).toHaveLength(2);
    expect(within(lines[0]).getByText("25")).toBeTruthy();
    expect(within(lines[0]).getByText("named in the DICOM confidentiality profile")).toBeTruthy();
    expect(within(lines[1]).getByText("3")).toBeTruthy();
    expect(within(lines[1]).getByText("private tags, contents defined by the manufacturer")).toBeTruthy();
    expect(screen.queryByText(/burned-in annotation flag/)).toBeNull();
  });

  it("omits a kind whose count is zero", async () => {
    const { user } = setup(outcome({ annex: 2, priv: 0 }));
    await user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("2 could identify a patient");

    const breakdown = screen.getByText("named in the DICOM confidentiality profile").closest("ul") as HTMLElement;
    expect(within(breakdown).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByText(/private tags/)).toBeNull();
  });
});

describe("the burned-in annotation", () => {
  it.each(["YES", "NO", "MAYBE", "yes"])("reports what the file says, verbatim: %s", async (value) => {
    const { user } = setup(outcome({ annex: 1, burned: 1 }, value));
    await user.click(screen.getByRole("button", { name: "Load sample" }));

    expect(await screen.findByText(`This file declares burned-in annotation: ${value}`)).toBeTruthy();
    expect(screen.getByText(CAVEAT)).toBeTruthy();
  });

  it("shows the statement below the breakdown, followed by the caveat", async () => {
    const { user } = setup(outcome({ annex: 1, priv: 1, burned: 1 }));
    await user.click(screen.getByRole("button", { name: "Load sample" }));
    const statement = await screen.findByText("This file declares burned-in annotation: YES");

    const list = screen.getByText("named in the DICOM confidentiality profile").closest("ul") as HTMLElement;
    const caveat = screen.getByText(CAVEAT);
    expect(list.compareDocumentPosition(statement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(statement.compareDocumentPosition(caveat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not count the flag, even when it says NO", async () => {
    const { user } = setup(outcome({ burned: 1 }, "NO"));
    await user.click(screen.getByRole("button", { name: "Load sample" }));

    expect(await screen.findByText("0 could identify a patient")).toBeTruthy();
    expect(screen.queryByText("named in the DICOM confidentiality profile")).toBeNull();
    expect(screen.getByRole("heading", { name: "Findings (0)" })).toBeTruthy();
    expect(screen.getByText("This file declares burned-in annotation: NO")).toBeTruthy();
  });

  it("shows (empty) when the file declares the element with no value", async () => {
    const { user } = setup(outcome({ annex: 1, burned: 1 }, ""));
    await user.click(screen.getByRole("button", { name: "Load sample" }));

    expect(await screen.findByText("This file declares burned-in annotation: (empty)")).toBeTruthy();
  });

  it("shows nothing about it, and no caveat, when the file has no burned-in finding", async () => {
    const { user } = setup(outcome({ annex: 2, priv: 1 }));
    await user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("3 could identify a patient");

    expect(screen.queryByText(/burned-in/)).toBeNull();
    expect(screen.queryByText(CAVEAT)).toBeNull();
  });
});

describe("the wording", () => {
  it("says fields, not elements, and names the profile rather than crediting it with flagging", async () => {
    const { user } = setup(outcome({ annex: 2, priv: 1 }));
    await user.click(screen.getByRole("button", { name: "Load sample" }));

    expect(await screen.findByText("3 fields read")).toBeTruthy();
    expect(screen.getByText("named in the DICOM confidentiality profile")).toBeTruthy();
    expect(screen.queryByText(/flagged by/)).toBeNull();
    expect(screen.queryByText(/elements? read/)).toBeNull();
  });

  it("uses the singular for one field", async () => {
    const { user } = setup({ ok: true, nodes: [node("00080060")], findings: [] });
    await user.click(screen.getByRole("button", { name: "Load sample" }));

    expect(await screen.findByText("1 field read")).toBeTruthy();
  });

  it("no longer says the field-by-field view is still to come", async () => {
    const { user } = setup(outcome({ annex: 1 }));
    expect(screen.queryByText(/next step/)).toBeNull();
    expect(screen.queryByText(/Detailed field-by-field view/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("1 could identify a patient");
    expect(screen.queryByText(/next step/)).toBeNull();
  });
});

describe("the views", () => {
  const listCount = () => Number(/\((\d+)\)/.exec(screen.getByRole("heading", { name: /^Findings \(/ }).textContent ?? "")?.[1]);
  const headline = () => Number(/^(\d+) could identify/.exec(screen.getByText(/could identify a patient/).textContent ?? "")?.[1]);
  const findingsRows = () => within(screen.getByRole("heading", { name: /^Findings \(/ }).closest("section") as HTMLElement).queryAllByRole("listitem");

  it.each([
    [{ annex: 3, priv: 2, burned: 1 }, 5],
    [{ annex: 25, priv: 3, burned: 1 }, 28],
    [{ burned: 1 }, 0],
    [{}, 0],
  ])("shows as many findings as the headline counts: %j", async (counts, expected) => {
    const { user } = setup(outcome(counts));
    await user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText(/could identify a patient/);

    expect(headline()).toBe(expected);
    expect(listCount()).toBe(expected);
    expect(findingsRows()).toHaveLength(expected);
  });

  it("lays out the summary, then the findings, then the collapsed tree, then Load another file", async () => {
    const { user } = setup(outcome({ annex: 2, burned: 1 }));
    await user.click(screen.getByRole("button", { name: "Load sample" }));
    const fields = await screen.findByText("3 fields read");

    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const findings = screen.getByRole("heading", { name: "Findings (2)" });
    const reveal = screen.getByRole("button", { name: "Reveal all" });
    const tree = screen.getByRole("heading", { name: "All fields (3)" });
    const another = screen.getByRole("button", { name: "Load another file" });

    expect(follows(screen.getByRole("heading", { name: "single.dcm" }), fields)).toBe(true);
    expect(follows(fields, screen.getByText(CAVEAT))).toBe(true);
    expect(follows(screen.getByText(CAVEAT), findings)).toBe(true);
    expect(follows(findings, reveal)).toBe(true);
    expect(follows(reveal, tree)).toBe(true);
    expect(follows(tree, another)).toBe(true);
    expect((document.querySelector("section details") as HTMLDetailsElement).open).toBe(false);
  });

  it("keeps the findings and the tree out of the live region, apart from the announcement", async () => {
    const { user, container } = setup(outcome({ annex: 2 }));
    await user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("2 could identify a patient");

    const live = container.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live.contains(screen.getByRole("heading", { name: "Findings (2)" }))).toBe(false);
    expect(live.contains(screen.getByRole("heading", { name: "All fields (3)" }))).toBe(false);
    expect(live.contains(screen.getByText("2 could identify a patient"))).toBe(true);
  });

  it("announces a reveal through the existing live region", async () => {
    const { user, container } = setup(outcome({ annex: 2 }));
    await user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("2 could identify a patient");
    const live = container.querySelector('[aria-live="polite"]') as HTMLElement;

    await user.click(screen.getByRole("button", { name: "Reveal all" }));
    expect(live.textContent).toContain("All values revealed");
    await user.click(screen.getByRole("button", { name: "Hide all" }));
    expect(live.textContent).toContain("All values hidden");
    expect(live.textContent).not.toContain("SECRET");
  });

  it("gives the result heading a visible --signal ring while it holds programmatic focus", async () => {
    const { user } = setup(outcome({ annex: 2 }));
    await user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("2 could identify a patient");

    const heading = screen.getByRole("heading", { name: "single.dcm" });
    expect(heading.getAttribute("tabindex")).toBe("-1");
    // :focus-visible, so the ring reaches keyboard users and not a mouse user who never touched it.
    expect(heading.className).toContain("focus-visible:outline-signal");
    expect(heading.className).toContain("focus-visible:outline-2");
    expect(heading.className).not.toMatch(/(^|\s)focus:outline/);
    expect(heading.className).not.toContain("outline-none");
  });

  it("moves focus to the top of the result, not the button at the bottom", async () => {
    const { user } = setup(outcome({ annex: 2 }));
    await user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("2 could identify a patient");

    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "single.dcm" }));
  });

  it("resets every reveal to masked when the user returns to idle and loads again", async () => {
    const { user } = setup(outcome({ annex: 2 }));
    await user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("2 could identify a patient");

    await user.click(screen.getByRole("button", { name: "Reveal all" }));
    expect(screen.getAllByText("SECRET")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Load another file" }));
    await user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("2 could identify a patient");

    expect(screen.queryByText("SECRET")).toBeNull();
    expect(screen.getAllByRole("img", { name: "hidden value" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Reveal all" })).toBeTruthy();
  });

  it("resets a single row's reveal in the tree as well", async () => {
    const patient: TagNode = { tag: "00100010", path: "00100010", vr: "PN", name: "Patient's Name", value: "SECRET" };
    const flagged: Finding = { path: "00100010", tag: "00100010", vr: "PN", kind: "annex-e", action: "Z", name: "Patient's Name", value: "SECRET" };
    const { user } = setup({ ok: true, nodes: [patient], findings: [flagged] });
    await user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("1 could identify a patient");

    const reveal = screen.getAllByRole("button", { name: "Reveal Patient's Name" });
    expect(reveal).toHaveLength(2);
    await user.click(reveal[1]);
    expect(screen.getAllByText("SECRET")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Load another file" }));
    await user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("1 could identify a patient");
    expect(screen.queryByText("SECRET")).toBeNull();
    expect(screen.getAllByRole("img", { name: "hidden value" })).toHaveLength(2);
  });
});

describe("reveal state is shared by the findings list and the tree", () => {
  const patient: TagNode = { tag: "00100010", path: "00100010", vr: "PN", name: "Patient's Name", value: "SECRET" };
  const other: TagNode = { tag: "00100020", path: "00100020", vr: "LO", name: "Patient ID", value: "SECRET-ID" };
  const flagged = (node: TagNode): Finding => ({ path: node.path, tag: node.tag, vr: node.vr, kind: "annex-e", action: "Z", name: node.name, value: node.value });
  const twoFields = (): ParseOutcome => ({ ok: true, nodes: [patient, other], findings: [flagged(patient), flagged(other)] });

  async function load() {
    const view = setup(twoFields());
    await view.user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("2 could identify a patient");
    return view;
  }
  const list = () => screen.getByRole("heading", { name: /^Findings/ }).closest("section") as HTMLElement;
  const tree = () => screen.getByRole("heading", { name: /^All fields/ }).closest("section") as HTMLElement;

  it("starts with both views masked", async () => {
    await load();
    expect(within(list()).getAllByRole("img", { name: "hidden value" })).toHaveLength(2);
    expect(within(tree()).getAllByRole("img", { name: "hidden value" })).toHaveLength(2);
  });

  it("revealing a value in the list reveals it in the tree, and hiding it in the tree hides it in the list", async () => {
    const { user } = await load();

    await user.click(within(list()).getByRole("button", { name: "Reveal Patient's Name" }));
    expect(within(list()).getByText("SECRET")).toBeTruthy();
    expect(within(tree()).getByText("SECRET")).toBeTruthy();
    expect(within(tree()).getByRole("button", { name: "Hide Patient's Name" })).toBeTruthy();
    expect(within(tree()).queryByText("SECRET-ID")).toBeNull();

    await user.click(within(tree()).getByRole("button", { name: "Hide Patient's Name" }));
    expect(within(list()).queryByText("SECRET")).toBeNull();
    expect(within(list()).getByRole("button", { name: "Reveal Patient's Name" })).toBeTruthy();
  });

  it("revealing a value in the tree reveals it in the list", async () => {
    const { user } = await load();

    await user.click(within(tree()).getByRole("button", { name: "Reveal Patient ID" }));
    expect(within(list()).getByText("SECRET-ID")).toBeTruthy();
    expect(within(list()).getByRole("button", { name: "Hide Patient ID" })).toBeTruthy();
  });

  it("Reveal all reveals every masked value in both views, and Hide all hides them in both", async () => {
    const { user } = await load();

    await user.click(screen.getByRole("button", { name: "Reveal all" }));
    for (const view of [list(), tree()]) {
      expect(within(view).getByText("SECRET")).toBeTruthy();
      expect(within(view).getByText("SECRET-ID")).toBeTruthy();
      expect(within(view).queryAllByRole("img", { name: "hidden value" })).toHaveLength(0);
    }

    await user.click(screen.getByRole("button", { name: "Hide all" }));
    for (const view of [list(), tree()]) {
      expect(within(view).queryByText("SECRET")).toBeNull();
      expect(within(view).getAllByRole("img", { name: "hidden value" })).toHaveLength(2);
    }
  });

  it("offers Hide all once every value has been revealed one at a time, across both views", async () => {
    const { user } = await load();

    await user.click(within(list()).getByRole("button", { name: "Reveal Patient's Name" }));
    expect(screen.getByRole("button", { name: "Reveal all" })).toBeTruthy();
    await user.click(within(tree()).getByRole("button", { name: "Reveal Patient ID" }));
    expect(screen.getByRole("button", { name: "Hide all" })).toBeTruthy();
  });

  it("resets to masked in both views when the result is left and loaded again", async () => {
    const { user } = await load();
    await user.click(screen.getByRole("button", { name: "Reveal all" }));
    expect(screen.getAllByText("SECRET")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Load another file" }));
    await user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("2 could identify a patient");

    expect(screen.queryByText("SECRET")).toBeNull();
    expect(screen.queryByText("SECRET-ID")).toBeNull();
    expect(screen.getAllByRole("img", { name: "hidden value" })).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Reveal all" })).toBeTruthy();
  });
});

describe("skip links", () => {
  async function load() {
    const view = setup(outcome({ annex: 2 }));
    await view.user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("2 could identify a patient");
    return view;
  }

  it("has both, with the exact text, pointing at headings that can take focus and are not in the tab order", async () => {
    await load();

    const toTree = screen.getByRole("link", { name: "Skip to all fields" });
    const toFindings = screen.getByRole("link", { name: "Back to findings" });
    expect(toTree.getAttribute("href")).toBe("#all-fields-heading");
    expect(toFindings.getAttribute("href")).toBe("#findings-heading");

    for (const [id, name] of [["all-fields-heading", /^All fields/], ["findings-heading", /^Findings/]] as const) {
      const heading = screen.getByRole("heading", { name });
      expect(heading.id).toBe(id);
      expect(heading.getAttribute("tabindex")).toBe("-1");
      expect(heading.className).toContain("focus-visible:outline-signal");
      expect(heading.className).not.toMatch(/(^|\s)focus:outline/);
    }
  });

  it("overlays what follows when focused, instead of taking up room and pushing it down", async () => {
    await load();

    for (const name of ["Skip to all fields", "Back to findings"]) {
      const link = screen.getByRole("link", { name });
      expect(link.className, name).toContain("focus:absolute");
      expect(link.className, name).toContain("focus:bg-paper");
      expect(link.className, name).not.toMatch(/focus:(inline-block|block|mt-\d+|my-\d+)/);
    }
  });

  it("hides each link until it has focus", async () => {
    await load();

    for (const name of ["Skip to all fields", "Back to findings"]) {
      const link = screen.getByRole("link", { name });
      expect(link.className).toContain("sr-only");
      expect(link.className).toContain("focus:not-sr-only");
    }
  });

  it("is the first stop after the filename heading, and Skip to all fields moves focus to the tree heading", async () => {
    const { user } = await load();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "single.dcm" }));

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Skip to all fields" }));
    await user.keyboard("{Enter}");

    expect(document.activeElement).toBe(screen.getByRole("heading", { name: /^All fields/ }));
  });

  it("Back to findings moves focus to the findings heading", async () => {
    const { user } = await load();

    await user.click(screen.getByRole("link", { name: "Back to findings" }));

    expect(document.activeElement).toBe(screen.getByRole("heading", { name: /^Findings/ }));
  });

  it("sits in front of the section it leaves: the second link is the first stop inside the tree section", async () => {
    await load();

    const section = screen.getByRole("heading", { name: /^All fields/ }).closest("section") as HTMLElement;
    expect(section.firstElementChild).toBe(screen.getByRole("link", { name: "Back to findings" }));
  });
});

describe("what a screen reader is given", () => {
  it("has one h1, then the filename, Findings and All fields as h2, in that order", async () => {
    const { user } = setup(outcome({ annex: 2 }));
    await user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("2 could identify a patient");

    const headings = screen.getAllByRole("heading").map((h) => [h.tagName, h.textContent]);
    expect(headings).toEqual([
      ["H1", "ScanLint"],
      ["H2", "single.dcm"],
      ["H2", "Findings (2)"],
      ["H2", "All fields (3)"],
    ]);
  });

  it("puts the summary and announcements in one polite status region, and the views outside it", async () => {
    const { user, container } = setup(outcome({ annex: 2 }));
    await user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("2 could identify a patient");

    const regions = container.querySelectorAll("[aria-live], [role='status'], [role='alert'], [role='log']");
    expect(regions).toHaveLength(1);
    const live = regions[0] as HTMLElement;
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.getAttribute("role")).toBe("status");
    expect(live.textContent).toContain("2 could identify a patient");
    expect(live.querySelector("section")).toBeNull();
    expect(live.querySelector("details")).toBeNull();
    expect(live.querySelector("a")).toBeNull();
  });

  it("gives every reveal control a name that includes the field's name", async () => {
    const { user } = setup(outcome({ annex: 2 }));
    await user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("2 could identify a patient");

    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label")).filter((n): n is string => n !== null);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/^(Reveal|Hide) Field \d+$/);
  });
});

describe("borders on controls", () => {
  it("gives Load sample a border, transparent so that forced-colours mode draws it, since its fill is not drawn there", () => {
    setup(outcome({}));
    const button = screen.getByRole("button", { name: "Load sample" });
    expect(button.className).toContain("border-2");
    expect(button.className).toContain("border-transparent");
  });

  it("takes the border's 2px off each side of Load sample's padding, so it is the size it was before", () => {
    setup(outcome({}));
    const button = screen.getByRole("button", { name: "Load sample" });
    // 32px by 12px padding, less 2px for the border, on each side. The measured size is in the PR.
    expect(button.className).toContain("px-[30px]");
    expect(button.className).toContain("py-2.5");
    expect(button.className).not.toMatch(/(^|\s)(px-8|py-3)(\s|$)/);
  });

  it("uses --shade, not --rule, for the drop zone and every control", async () => {
    const { user, container } = setup(outcome({ annex: 2 }));
    expect(container.querySelector(".border-dashed")?.className).toContain("border-shade");
    expect(container.querySelector(".border-dashed")?.className).not.toContain("border-rule");

    await user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("2 could identify a patient");

    for (const button of [screen.getByRole("button", { name: "Reveal all" }), screen.getByRole("button", { name: "Load another file" }), ...screen.getAllByRole("button", { name: /^Reveal Field/ })]) {
      expect(button.className, button.textContent ?? "").toContain("border-shade");
      expect(button.className, button.textContent ?? "").not.toContain("border-rule");
    }
  });
});

describe("errors", () => {
  it("shows the plain statement and dicom-parser's message when the file cannot be read as DICOM", async () => {
    const { user } = setup({ ok: false, message: "dicomParser.readPart10Header: DICM prefix not found at location 132" });
    await user.click(screen.getByRole("button", { name: "Load sample" }));

    expect(await screen.findByText("This file could not be read as DICOM.")).toBeTruthy();
    expect(screen.getByText("dicomParser.readPart10Header: DICM prefix not found at location 132")).toBeTruthy();
  });

  it("shows an error, not a stuck loading state, when loadSample rejects", async () => {
    const { user, parse } = setup(outcome({}), new Error("Could not load the sample file: the server answered 404."));
    await user.click(screen.getByRole("button", { name: "Load sample" }));

    expect(await screen.findByText("The sample file could not be loaded.")).toBeTruthy();
    expect(screen.getByText("Could not load the sample file: the server answered 404.")).toBeTruthy();
    expect(screen.queryByText(/Reading/)).toBeNull();
    expect(screen.getByRole("button", { name: "Load another file" })).toBeTruthy();
    expect(parse).not.toHaveBeenCalled();
  });
});

describe("Load another file", () => {
  it("returns to idle", async () => {
    const { user } = setup(outcome({ annex: 1 }));
    await user.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("1 could identify a patient");

    await user.click(screen.getByRole("button", { name: "Load another file" }));

    const sample = screen.getByRole("button", { name: "Load sample" });
    expect(sample).toBeTruthy();
    expect(screen.getByText("Drop a DICOM file here")).toBeTruthy();
    expect(screen.queryByText("1 could identify a patient")).toBeNull();
    expect(document.activeElement).toBe(sample);
  });
});
