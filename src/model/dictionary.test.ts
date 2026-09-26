import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import annexE from "./annex-e.json";
import dictionary from "./dictionary.json";
import { applyNames, lookupAttribute } from "./dictionary";
import type { TagNode } from "./types";

const ROOT = path.resolve(__dirname, "../..");
const readJson = <T>(...parts: string[]) => JSON.parse(fs.readFileSync(path.join(ROOT, ...parts), "utf8")) as T;

type Keywords = { edition: string; byTag: Record<string, string>; byMask: Record<string, string> };
type ManifestEntry = { path: string; tag: string; keyword?: string; vr: string };
type Manifest = { files: { expectedFindings: ManifestEntry[]; expectedKept: ManifestEntry[] }[] };

// Read straight from the file: the keywords are test data and are not reachable from the app.
const keywords = readJson<Keywords>("fixtures", "dictionary-keywords.json");
const manifest = readJson<Manifest>("fixtures", "single.manifest.json");

describe("lookupAttribute", () => {
  it("resolves an exact tag", () => {
    expect(lookupAttribute("00100010")).toEqual({ name: "Patient's Name", vr: "PN" });
  });

  it("joins a compound word that Part 6 breaks with U+200B, and spaces two words it breaks the same way", () => {
    // Same invisible character in the source, opposite answers. See JOINED_NAMES in the extraction script.
    expect(lookupAttribute("0072000a")?.name).toBe("Hanging Protocol Creation DateTime");
    expect(lookupAttribute("300a067b")?.name).toBe("Radiation Generation Mode Sequence");
    expect(lookupAttribute("0014605f")?.name).toBe("Polynomial Coefficients");
  });

  it("resolves a file meta tag", () => {
    expect(lookupAttribute("00020010")).toEqual({ name: "Transfer Syntax UID", vr: "UI" });
  });

  it.each(["60003000", "601e3000"])("resolves %s through the overlay pattern", (tag) => {
    expect(lookupAttribute(tag)?.name).toBe("Overlay Data");
  });

  it("returns undefined for a tag the standard does not define", () => {
    expect(lookupAttribute("00280399")).toBeUndefined();
    expect(lookupAttribute("ffff0000")).toBeUndefined();
  });

  it("names a group length element, which the registry does not list", () => {
    expect(dictionary.attributes).not.toHaveProperty("00080000");
    expect(lookupAttribute("00080000")).toEqual({ name: "Group Length" });
    expect(lookupAttribute("7fe00000")).toEqual({ name: "Group Length" });
  });

  it("does not name a private tag, in any position", () => {
    expect(lookupAttribute("00290010")).toBeUndefined();
    expect(lookupAttribute("00291001")).toBeUndefined();
    expect(lookupAttribute("00090000")).toBeUndefined();
  });

  it("does not let a loose pattern name an odd-group tag", () => {
    // 5001 is odd, and (50xx,xxxx)-style masks in the table would match it if private were not checked first.
    expect(dictionary.patterns.some((p) => p.mask === "60xx3000")).toBe(true);
    expect(lookupAttribute("60013000")).toBeUndefined();
    expect(lookupAttribute("50010010")).toBeUndefined();
  });

  it("throws on a tag that is not normalised, and does not normalise it", () => {
    expect(() => lookupAttribute("(0010,0010)")).toThrow(TypeError);
    expect(() => lookupAttribute("00100010 ")).toThrow(TypeError);
    expect(() => lookupAttribute("0010001")).toThrow(TypeError);
    expect(() => lookupAttribute("0010001G")).toThrow(TypeError);
    expect(() => lookupAttribute("")).toThrow(TypeError);
  });

  it("omits vr instead of setting it undefined when the registry gives none", () => {
    const noVr = Object.entries(dictionary.attributes).find(([, a]) => !("vr" in a));
    expect(noVr).toBeDefined();
    expect(lookupAttribute(noVr![0])).not.toHaveProperty("vr");
  });
});

describe("exact beats pattern", () => {
  // Each of these tags is a real entry that also matches a pattern. The pattern's name would be wrong.
  const masks = dictionary.patterns.map((p) => ({ mask: p.mask, name: p.name }));
  const matches = (tag: string, mask: string) => [...mask].every((c, i) => c === "x" || c === tag[i]);
  const collisions = Object.keys(dictionary.attributes).filter((tag) => masks.some((m) => matches(tag, m.mask)));

  it("finds exactly the eight collisions the extraction reported", () => {
    expect(collisions.sort()).toEqual([
      "00280400",
      "00280401",
      "00280402",
      "00280403",
      "7fe00010",
      "7fe00020",
      "7fe00030",
      "7fe00040",
    ]);
  });

  it.each([
    ["7fe00010", "Pixel Data", "Variable Pixel Data"],
    ["00280400", "Transform Label", "Rows For Nth Order Coefficients"],
    ["00280401", "Transform Version Number", "Rows For Nth Order Coefficients"],
  ])("%s is %s, not the pattern's %s", (tag, name, patternName) => {
    expect(lookupAttribute(tag)?.name).toBe(name);
    expect(dictionary.patterns.some((p) => p.name === patternName)).toBe(true);
    expect(lookupAttribute(tag)?.name).not.toBe(patternName);
  });

  it("uses the entry's own name for every collision", () => {
    for (const tag of collisions) {
      expect(lookupAttribute(tag)).toBe(dictionary.attributes[tag as keyof typeof dictionary.attributes]);
    }
  });

  it("still uses the pattern for a tag that has no entry of its own", () => {
    expect(lookupAttribute("7f000010")?.name).toBe("Variable Pixel Data");
  });
});

describe("pattern order", () => {
  // Lookup takes the first matching pattern in file order. That only matters if two patterns can
  // match the same tag; today none can, so order is irrelevant. A future edition that adds an
  // overlap fails here, which forces a decision instead of silently picking by file position.
  it("no two patterns can match the same tag", () => {
    const masks = dictionary.patterns.map((p) => p.mask);
    const overlapping = masks.flatMap((a, i) =>
      masks
        .slice(i + 1)
        .filter((b) => [...a].every((c, k) => c === "x" || b[k] === "x" || c === b[k]))
        .map((b) => `${a} and ${b}`),
    );
    expect(overlapping).toEqual([]);
  });
});

describe("the shipped dictionary file", () => {
  it("has no keyword anywhere: names only", () => {
    expect(JSON.stringify(dictionary)).not.toContain('"keyword"');
    for (const entry of [...Object.values(dictionary.attributes), ...dictionary.patterns]) {
      expect(Object.keys(entry).every((k) => ["name", "vr", "tagPattern", "match", "mask"].includes(k))).toBe(true);
    }
  });

  it("has no zero-width space and no stray whitespace in a name", () => {
    const names = [...Object.values(dictionary.attributes), ...dictionary.patterns].map((e) => e.name);
    expect(names.filter((n) => n.includes("\u200b"))).toEqual([]);
    expect(names.filter((n) => n !== n.trim() || /\s{2,}/.test(n))).toEqual([]);
    expect(names.filter((n) => n === "")).toEqual([]);
  });

  it("has the same edition as the keywords file and the Annex E table", () => {
    expect(keywords.edition).toBe(dictionary.edition);
    expect(annexE.source.edition).toBe(dictionary.edition);
  });
});

describe("the keywords file, which is test data", () => {
  it("has no keyword containing whitespace or U+200B: they are identifiers, kept as Part 6 prints them", () => {
    const all = [...Object.values(keywords.byTag), ...Object.values(keywords.byMask)];
    expect(all.filter((k) => /\s/.test(k) || k.includes("\u200b"))).toEqual([]);
  });

  it("covers exactly the tags and masks the dictionary does", () => {
    const missing = Object.keys(dictionary.attributes).filter((t) => !(t in keywords.byTag));
    const extra = Object.keys(keywords.byTag).filter((t) => !(t in dictionary.attributes));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
    expect(Object.keys(keywords.byMask)).toEqual(dictionary.patterns.map((p) => p.mask));
  });
});

describe("the fixture manifest is the oracle for keywords", () => {
  const { expectedFindings, expectedKept } = manifest.files[0];
  const entries = [...expectedFindings, ...expectedKept];

  it("checks 45 entries: 42 with a keyword, 3 private ones without", () => {
    expect(entries.length).toBe(45);
    expect(entries.filter((e) => e.keyword !== undefined).length).toBe(42);
    expect(entries.filter((e) => e.keyword === undefined).map((e) => e.tag)).toEqual([
      "00290010",
      "00291001",
      "00291002",
    ]);
  });

  it("every manifest keyword equals the dictionary's Part 6 keyword for that tag", () => {
    const wrong = entries
      .filter((e) => e.keyword !== undefined)
      .filter((e) => keywords.byTag[e.tag] !== e.keyword)
      .map((e) => `${e.tag}: manifest ${e.keyword}, dictionary ${keywords.byTag[e.tag]}`);
    expect(wrong).toEqual([]);
  });

  it("every manifest entry with a keyword resolves to a name, and every one without is private", () => {
    for (const entry of entries) {
      if (entry.keyword === undefined) {
        expect(lookupAttribute(entry.tag), entry.tag).toBeUndefined();
      } else {
        expect(lookupAttribute(entry.tag)?.name, entry.tag).toBeTruthy();
      }
    }
  });
});

describe("cross-check against Annex E", () => {
  const resolved = annexE.attributes.filter((a) => lookupAttribute(a.tag) !== undefined);
  const unresolved = annexE.attributes.filter((a) => lookupAttribute(a.tag) === undefined).map((a) => a.tag);

  it("resolves every Annex E tag except exactly these two, which are network command elements (PS3.7)", () => {
    expect(unresolved.sort()).toEqual(["00001000", "00001001"]);
    expect(resolved.length).toBe(annexE.attributes.length - 2);
  });

  it("resolves a representative tag for each Annex E nibble-mask pattern", () => {
    const failures = annexE.patterns
      .filter((p) => p.match === "nibbleMask")
      .map((p) => p.mask!.replace(/x/g, "0"))
      .filter((tag) => lookupAttribute(tag) === undefined);
    expect(failures).toEqual([]);
  });

  it("agrees with Annex E on every name except exactly this one", () => {
    // Annex E prints "Icon Image Sequence (see Note 11)": the note is Annex E's own, and the
    // dictionary name has none. A new difference must fail here, not scroll past.
    const mismatches = resolved.filter((a) => lookupAttribute(a.tag)!.name !== a.name).map((a) => a.tag);
    expect(mismatches).toEqual(["00880200"]);
    expect(lookupAttribute("00880200")?.name).toBe("Icon Image Sequence");
    expect(annexE.attributes.find((a) => a.tag === "00880200")?.name).toBe("Icon Image Sequence (see Note 11)");
  });
});

describe("applyNames", () => {
  const node = (tag: string, extra: Partial<TagNode> = {}): TagNode => ({ tag, path: tag, vr: "LO", ...extra });

  it("adds a name to top-level and nested nodes", () => {
    const nested = node("00100020", { path: "00081140/0/00100020" });
    const tree = [node("00081140", { vr: "SQ", items: [[nested]] }), node("00100010", { vr: "PN" })];

    const named = applyNames(tree);

    expect(named[0].name).toBe("Referenced Image Sequence");
    expect(named[0].items?.[0][0].name).toBe("Patient ID");
    expect(named[1].name).toBe("Patient's Name");
  });

  it("does not mutate its input", () => {
    const nested = node("00100020");
    const tree = [node("00081140", { vr: "SQ", items: [[nested]] })];
    const before = structuredClone(tree);

    const named = applyNames(tree);

    expect(tree).toEqual(before);
    expect(tree[0]).not.toHaveProperty("name");
    expect(nested).not.toHaveProperty("name");
    expect(named[0]).not.toBe(tree[0]);
    expect(named[0].items?.[0][0]).not.toBe(nested);
  });

  it("leaves no name key at all on an unresolved node", () => {
    const [named] = applyNames([node("00291001"), node("00280399")]);
    expect(named).not.toHaveProperty("name");
    expect(applyNames([node("00280399")])[0]).toStrictEqual(node("00280399"));
  });

  it("keeps every other field, and an empty items array stays empty", () => {
    const [named] = applyNames([node("00081140", { vr: "SQ", items: [], lengthEncoding: "defined", value: "v" })]);
    expect(named).toStrictEqual({
      tag: "00081140",
      path: "00081140",
      vr: "SQ",
      items: [],
      lengthEncoding: "defined",
      value: "v",
      name: "Referenced Image Sequence",
    });
  });

  it("returns an empty array for no nodes", () => {
    expect(applyNames([])).toEqual([]);
  });
});
