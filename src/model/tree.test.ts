import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseMetadata } from "../parse/walk";
import { flattenNodes, identifyingFindings } from "./tree";
import type { Finding } from "./types";

const bytes = new Uint8Array(fs.readFileSync(path.resolve(__dirname, "../../public/samples/single.dcm")));
const tree = parseMetadata(bytes);
const flat = flattenNodes(tree);

const NESTED_PATH = "04000561/0/04000550/0/00080090";

describe("identifyingFindings", () => {
  const finding = (kind: Finding["kind"], path: string): Finding => ({ path, tag: "00100010", vr: "LO", kind });

  it("drops the burned-in flag and keeps the rest, in order", () => {
    const all = [finding("annex-e", "a"), finding("burned-in", "b"), finding("private", "c")];
    expect(identifyingFindings(all).map((f) => f.path)).toEqual(["a", "c"]);
  });

  it("does not modify its input, and returns an empty array for none", () => {
    const all = [finding("burned-in", "b")];
    identifyingFindings(all);
    expect(all).toHaveLength(1);
    expect(identifyingFindings([])).toEqual([]);
  });
});

describe("flattenNodes", () => {
  it("returns more nodes than the top level, and contains every nested node", () => {
    expect(flat.length).toBeGreaterThan(tree.length);
    expect(flat.map((n) => n.path)).toEqual(expect.arrayContaining([NESTED_PATH, "04000561/0/04000550"]));
  });

  it("puts parents before their children", () => {
    const order = new Map(flat.map((node, i) => [node.path, i]));
    for (const node of flat) {
      const slash = node.path.lastIndexOf("/");
      if (slash === -1) continue;
      const parentPath = node.path.slice(0, node.path.lastIndexOf("/", slash - 1));
      expect(order.get(parentPath), `parent of ${node.path}`).toBeLessThan(order.get(node.path) ?? -1);
    }
  });

  it("is depth-first: a node's descendants directly follow it", () => {
    const outerAt = flat.findIndex((n) => n.path === "04000561");
    expect(flat.slice(outerAt, outerAt + 3).map((n) => n.path)).toEqual([
      "04000561",
      "04000561/0/04000550",
      NESTED_PATH,
    ]);
    expect(flat.filter((n) => n.path.startsWith("04000561/")).length).toBe(2);
  });

  it("returns an empty array for no nodes", () => {
    expect(flattenNodes([])).toEqual([]);
  });
});

describe("tree.ts", () => {
  it("imports nothing but types, so it can be used on the main thread without pulling in the parser", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "tree.ts"), "utf8");
    const imports = source.split("\n").filter((line) => /^\s*import\b/.test(line));

    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((line) => !/^\s*import type\b/.test(line))).toEqual([]);
  });
});
