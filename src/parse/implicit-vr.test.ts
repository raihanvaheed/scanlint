import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { flattenNodes } from "../model/tree";
import type { Finding, TagNode } from "../model/types";
import { handleParse } from "./handle";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => new Uint8Array(fs.readFileSync(path.join(ROOT, rel)));

function parse(rel: string) {
  const outcome = handleParse(read(rel));
  if (!outcome.ok) throw new Error(`${rel}: ${outcome.message}`);
  const flat = flattenNodes(outcome.nodes);
  return { ...outcome, flat, byPath: new Map(flat.map((n) => [n.path, n])), findingByPath: new Map(outcome.findings.map((f) => [f.path, f])) };
}

type Manifest = { files: { expectedFindings: Finding[] }[] };
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "single.manifest.json"), "utf8")) as Manifest;
const manifestPaths = manifest.files[0].expectedFindings.map((f) => f.path).sort();

const explicit = parse("public/samples/single.dcm");
const implicit = parse("fixtures/single-implicit.dcm");
const rle = parse("fixtures/single-rle.dcm");

const PRIVATE = ["00290010", "00291001", "00291002"];
const isPrivate = (p: string) => PRIVATE.includes(p);

describe("the same study in two transfer syntaxes gives the same answer", () => {
  it("the implicit file really is Implicit VR Little Endian, and the explicit one is not", () => {
    expect(implicit.byPath.get("00020010")?.value).toBe("1.2.840.10008.1.2");
    expect(explicit.byPath.get("00020010")?.value).toBe("1.2.840.10008.1.2.1");
    expect(rle.byPath.get("00020010")?.value).toBe("1.2.840.10008.1.2.5");
  });

  it("1. has identical path sets in the flattened trees", () => {
    expect([...implicit.byPath.keys()].sort()).toEqual([...explicit.byPath.keys()].sort());
    expect(implicit.flat.length).toBe(55);
  });

  it("2. has identical finding path sets, and both equal the manifest's 29", () => {
    const explicitPaths = explicit.findings.map((f) => f.path).sort();
    const implicitPaths = implicit.findings.map((f) => f.path).sort();

    expect(manifestPaths.length).toBe(29);
    expect(explicitPaths).toEqual(manifestPaths);
    expect(implicitPaths).toEqual(manifestPaths);
  });

  it("3. gives every finding the same value, except the three private ones", () => {
    const wrong = explicit.findings
      .filter((f) => !isPrivate(f.path))
      .flatMap((f) => {
        const other = implicit.findingByPath.get(f.path);
        return other?.value === f.value ? [] : [`${f.path}: explicit ${JSON.stringify(f.value)}, implicit ${JSON.stringify(other?.value)}`];
      });
    expect(wrong).toEqual([]);
    expect(explicit.findings.filter((f) => !isPrivate(f.path) && f.vr !== "SQ" && f.value === undefined)).toEqual([]);
    expect(implicit.findings.filter((f) => !isPrivate(f.path) && f.vr !== "SQ" && f.value === undefined)).toEqual([]);
  });

  it("4. gives every non-private finding the same name", () => {
    const wrong = explicit.findings
      .filter((f) => !isPrivate(f.path))
      .filter((f) => implicit.findingByPath.get(f.path)?.name !== f.name)
      .map((f) => f.path);
    expect(wrong).toEqual([]);
    expect(explicit.findings.filter((f) => !isPrivate(f.path) && !f.name)).toEqual([]);
  });

  it("classifies the three private elements as private in both, with no value in the implicit file", () => {
    for (const parsed of [explicit, implicit]) {
      expect(parsed.findings.filter((f) => f.kind === "private").map((f) => f.path)).toEqual(PRIVATE);
    }
    for (const p of PRIVATE) {
      expect(explicit.findingByPath.get(p)?.value, p).toBeDefined();
      expect(implicit.findingByPath.get(p), p).not.toHaveProperty("value");
      expect(implicit.byPath.get(p)?.vr, p).toBe("UN");
      expect(implicit.byPath.get(p), p).not.toHaveProperty("name");
    }
  });

  it("gives the same kind, action and length encoding for every finding", () => {
    const key = (f: Finding) => JSON.stringify([f.path, f.kind, f.action ?? null, f.lengthEncoding ?? null]);
    expect(implicit.findings.map(key)).toEqual(explicit.findings.map(key));
  });

  it("agrees on every element's value and name, but for a short list, each with a reason", () => {
    // The transfer syntax UID differs because the files differ in it. The file meta group length
    // follows the length of that UID. The private elements have no readable value without a VR.
    const differing = [...explicit.byPath.keys()].filter((p) => explicit.byPath.get(p)?.value !== implicit.byPath.get(p)?.value).sort();
    expect(differing).toEqual(["00020000", "00020010", ...PRIVATE].sort());
    expect(explicit.byPath.get("00020000")?.value).toBe("198");
    expect(implicit.byPath.get("00020000")?.value).toBe("196");

    const namesDiffering = [...explicit.byPath.keys()].filter((p) => explicit.byPath.get(p)?.name !== implicit.byPath.get(p)?.name);
    expect(namesDiffering).toEqual([]);
  });

  it("reads the numbers the tree used to show as (not shown), the same in both", () => {
    for (const [p, value] of [["00280010", "256"], ["00280011", "256"], ["00280100", "16"], ["00280101", "12"], ["00280102", "11"], ["00280103", "0"], ["00280002", "1"]]) {
      expect(explicit.byPath.get(p)?.value, p).toBe(value);
      expect(implicit.byPath.get(p)?.value, p).toBe(value);
    }
  });

  it("reports every element whose VR differs between the two parses (informational; asserts only that it ran)", () => {
    const rows = [...explicit.byPath.keys()]
      .filter((p) => explicit.byPath.get(p)?.vr !== implicit.byPath.get(p)?.vr)
      .map((p) => `${p} ${explicit.byPath.get(p)?.name ?? "(private)"}: explicit ${explicit.byPath.get(p)?.vr}, implicit ${implicit.byPath.get(p)?.vr}`);
    console.info(`VR differs on ${rows.length} of ${explicit.byPath.size} elements:\n  ${rows.join("\n  ")}`);
    expect(explicit.byPath.size).toBe(55);
  });

  it("gives Pixel Data the first-listed VR of OB or OW when the stream does not say: OB, not OW", () => {
    expect(explicit.byPath.get("7fe00010")?.vr).toBe("OW");
    expect(implicit.byPath.get("7fe00010")?.vr).toBe("OB");
    expect(implicit.byPath.get("7fe00010")?.length).toBe(explicit.byPath.get("7fe00010")?.length);
  });
});

describe("a file with compressed (encapsulated) pixel data", () => {
  it("gives Pixel Data no length, not 4294967295, because the encoding has none to give", () => {
    const pixel = rle.byPath.get("7fe00010") as TagNode;

    expect(pixel.vr).toBe("OW");
    expect(pixel).not.toHaveProperty("length");
    expect(JSON.stringify(rle)).not.toContain("4294967295");
  });

  it("has the same 29 findings as the uncompressed file, with the same values", () => {
    expect(rle.findings.map((f) => f.path).sort()).toEqual(manifestPaths);
    const wrong = explicit.findings.filter((f) => rle.findingByPath.get(f.path)?.value !== f.value).map((f) => f.path);
    expect(wrong).toEqual([]);
  });

  it("differs from the explicit file only in the transfer syntax and in Pixel Data's length", () => {
    // The group length is the same: the two UIDs pad to the same even length.
    const differing = [...explicit.byPath.keys()].filter((p) => JSON.stringify(explicit.byPath.get(p)) !== JSON.stringify(rle.byPath.get(p)));
    expect(differing.sort()).toEqual(["00020010", "7fe00010"]);
    expect(explicit.byPath.get("00020000")?.value).toBe(rle.byPath.get("00020000")?.value);
  });
});
