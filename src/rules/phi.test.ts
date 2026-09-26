import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { lookupAnnexE, matchAnnexEPattern } from "../model/annex-e";
import { applyNames } from "../model/dictionary";
import type { Finding, TagNode } from "../model/types";
import { parseMetadata } from "../parse/walk";
import { classify, classifyNode } from "./phi";

const ROOT = path.resolve(__dirname, "../..");
const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, "public", "samples", "single.dcm")));

type KeptEntry = { path: string };
type Manifest = { files: { expectedFindings: Finding[]; expectedKept: KeptEntry[] }[] };
const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, "fixtures", "single.manifest.json"), "utf8"),
) as Manifest;
const { expectedFindings, expectedKept } = manifest.files[0];

const findings = classify(applyNames(parseMetadata(bytes)));
const byPath = new Map(findings.map((f) => [f.path, f]));

const node = (tag: string, extra: Partial<TagNode> = {}): TagNode => ({
  tag,
  path: tag,
  vr: "UN",
  ...extra,
});

describe("the fixture manifest is the oracle", () => {
  const expectedPaths = expectedFindings.map((f) => f.path);
  const producedPaths = findings.map((f) => f.path);

  it("produces no finding the manifest does not list", () => {
    const extra = producedPaths.filter((p) => !expectedPaths.includes(p));
    expect(extra, `extra findings: ${extra.join(", ")}`).toEqual([]);
  });

  it("misses no finding the manifest lists", () => {
    const missing = expectedPaths.filter((p) => !producedPaths.includes(p));
    expect(missing, `missing findings: ${missing.join(", ")}`).toEqual([]);
  });

  // The manifest carries keywords; findings carry names. Neither is in the other, so both are left out.
  it("matches every manifest entry on every field except keyword and name", () => {
    const wrong = expectedFindings.flatMap((entry) => {
      const expected = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "keyword"));
      const produced = byPath.get(entry.path);
      const comparable = produced && Object.fromEntries(Object.entries(produced).filter(([key]) => key !== "name"));
      if (comparable && isDeepStrictEqual(comparable, expected)) return [];
      return [`${entry.path}\n  produced ${JSON.stringify(produced)}\n  expected ${JSON.stringify(expected)}`];
    });
    expect(wrong).toEqual([]);
  });

  it("never sets keyword", () => {
    expect(findings.filter((f) => "keyword" in f)).toEqual([]);
  });

  it("flags none of the elements the manifest says are kept", () => {
    expect(expectedKept.length).toBe(16);
    const flagged = expectedKept.filter((k) => byPath.has(k.path)).map((k) => k.path);
    expect(flagged).toEqual([]);
  });

  it("returns findings sorted by path, in the manifest's own order", () => {
    expect(producedPaths).toEqual([...producedPaths].sort());
    expect(producedPaths).toEqual(expectedPaths);
  });
});

describe("names on findings", () => {
  it("gives every standard finding a non-empty name", () => {
    const standard = findings.filter((f) => f.kind !== "private");
    expect(standard.length).toBe(26);
    expect(standard.filter((f) => !f.name)).toEqual([]);
  });

  it("gives the three private findings no name key at all", () => {
    const privates = findings.filter((f) => f.kind === "private");
    expect(privates.length).toBe(3);
    for (const finding of privates) expect(finding).not.toHaveProperty("name");
  });

  it("names the patient's name, and a nested element by its own tag", () => {
    expect(byPath.get("00100010")?.name).toBe("Patient's Name");
    expect(byPath.get("04000561/0/04000550/0/00080090")?.name).toBe("Referring Physician's Name");
  });

  it("copies the node's name, and leaves it off when the node has none", () => {
    expect(classifyNode(node("00100010", { vr: "PN", name: "Patient's Name" }))?.name).toBe("Patient's Name");
    expect(classifyNode(node("00100010", { vr: "PN" }))).not.toHaveProperty("name");
  });

  it("still finds 29 in total, and never sets keyword", () => {
    expect(findings.length).toBe(29);
    expect(findings.filter((f) => "keyword" in f)).toEqual([]);
  });
});

describe("counts by kind", () => {
  const count = (kind: Finding["kind"]) => findings.filter((f) => f.kind === kind).length;

  it("has 25 annex-e, 3 private and 1 burned-in", () => {
    expect(count("annex-e")).toBe(25);
    expect(count("private")).toBe(3);
    expect(count("burned-in")).toBe(1);
    expect(findings.length).toBe(29);
  });
});

describe("burned-in annotation", () => {
  it("is reported with its value and no action", () => {
    const finding = byPath.get("00280301");
    expect(finding?.kind).toBe("burned-in");
    expect(finding?.value).toBe("YES");
    expect(finding).not.toHaveProperty("action");
  });

  it("is reported whatever its value says", () => {
    for (const value of ["YES", "NO", ""]) {
      expect(classifyNode(node("00280301", { vr: "CS", value }))?.kind).toBe("burned-in");
    }
    expect(classifyNode(node("00280301", { vr: "CS" }))?.kind).toBe("burned-in");
  });
});

describe("private tags", () => {
  it("classifies the private creator as private", () => {
    expect(byPath.get("00290010")?.kind).toBe("private");
  });

  it("gives every private finding no action field at all", () => {
    const privates = findings.filter((f) => f.kind === "private");
    expect(privates.map((f) => f.path)).toEqual(["00290010", "00291001", "00291002"]);
    for (const finding of privates) {
      expect(finding).not.toHaveProperty("action");
    }
  });

  it("classifies a private tag as private even when it would otherwise match Annex E", () => {
    // 6001 is an odd group, and the deliberately loose overlay mask 60xx3000 matches it.
    expect(matchAnnexEPattern("60013000")).toBeDefined();
    const finding = classifyNode(node("60013000", { vr: "OW" }));
    expect(finding?.kind).toBe("private");
    expect(finding).not.toHaveProperty("action");
  });

  it("does not consult the oddGroup pattern: a plain even-group tag is not private", () => {
    expect(classifyNode(node("00080060", { vr: "CS", value: "MR" }))).toBeUndefined();
  });
});

describe("nesting", () => {
  const NESTED = "04000561/0/04000550/0/00080090";

  it("finds the nested physician name, with the nested value", () => {
    const nested = byPath.get(NESTED);
    const top = byPath.get("00080090");
    expect(nested?.kind).toBe("annex-e");
    expect(nested?.value).toBe(expectedFindings.find((f) => f.path === NESTED)?.value);
    expect(nested?.value).not.toBe(top?.value);
  });

  it("reports both sequences in their own right, with their length encodings", () => {
    expect(byPath.get("04000561")).toMatchObject({ kind: "annex-e", action: "X", lengthEncoding: "undefined" });
    expect(byPath.get("04000561/0/04000550")).toMatchObject({ kind: "annex-e", action: "X", lengthEncoding: "defined" });
  });
});

describe("the pattern path", () => {
  it.each([
    ["60003000", "the overlay data mask"],
    ["601e3000", "a different group matching the same mask"],
    ["50001000", "the curve data mask"],
  ])("classifies %s as annex-e with action X (%s)", (tag) => {
    const finding = classifyNode(node(tag, { vr: "OW" }));
    expect(finding).toMatchObject({ tag, path: tag, kind: "annex-e", action: "X" });
    expect(lookupAnnexE(tag)).toBeUndefined();
    expect(matchAnnexEPattern(tag)).toBeDefined();
  });

  it("matches an ordinary table tag exactly, not by pattern", () => {
    expect(lookupAnnexE("00081030")).toBeDefined();
    expect(matchAnnexEPattern("00081030")).toBeUndefined();
    expect(classifyNode(node("00081030", { vr: "LO", value: "X" }))).toMatchObject({ kind: "annex-e", action: "X" });
  });
});

describe("everything else, and field handling", () => {
  it("returns undefined for a tag that is not a finding", () => {
    expect(classifyNode(node("00080060", { vr: "CS", value: "MR" }))).toBeUndefined();
    expect(classifyNode(node("7fe00010", { vr: "OW" }))).toBeUndefined();
  });

  it("omits value and lengthEncoding when the node has none, instead of setting undefined", () => {
    const finding = classifyNode(node("00100010", { vr: "PN" }));
    expect(finding).toStrictEqual({ path: "00100010", tag: "00100010", vr: "PN", kind: "annex-e", action: "Z" });
  });

  it("copies path, tag, vr, value and lengthEncoding through from the node", () => {
    const finding = classifyNode(node("04000561", { path: "04000561", vr: "SQ", lengthEncoding: "undefined" }));
    expect(finding).toStrictEqual({ path: "04000561", tag: "04000561", vr: "SQ", kind: "annex-e", action: "X", lengthEncoding: "undefined" });
  });

  it("does not normalise a malformed tag: it throws", () => {
    expect(() => classifyNode(node("(0010,0010)"))).toThrow(TypeError);
  });
});

describe("classify", () => {
  it("returns an empty array for no nodes", () => {
    expect(classify([])).toEqual([]);
  });

  it("classifies nested nodes, not only the top level", () => {
    const nested = node("00100010", { path: "00081140/0/00100010", vr: "PN" });
    const tree = [node("00081140", { vr: "SQ", items: [[nested]], lengthEncoding: "defined" })];
    expect(classify(tree).map((f) => f.path)).toEqual(["00081140", "00081140/0/00100010"]);
  });
});
