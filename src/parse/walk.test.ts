import { describe, expect, it } from "vitest";
import { parseDicom } from "dicom-parser";
import fs from "node:fs";
import path from "node:path";
import { flattenNodes, parseMetadata } from "./walk";
import { tagGroup } from "../model/tag";
import type { Finding, TagNode } from "../model/types";

const ROOT = path.resolve(__dirname, "../..");
const DICOM_PATH = path.join(ROOT, "public", "samples", "single.dcm");
const MANIFEST_PATH = path.join(ROOT, "fixtures", "single.manifest.json");

type KeptEntry = Pick<Finding, "path" | "tag" | "keyword" | "vr">;
type Manifest = {
  files: { expectedFindings: Finding[]; expectedKept: KeptEntry[] }[];
};

const bytes = new Uint8Array(fs.readFileSync(DICOM_PATH));
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
const { expectedFindings, expectedKept } = manifest.files[0];

const tree = parseMetadata(bytes);
const flat = flattenNodes(tree);
const byPath = new Map<string, TagNode>(flat.map((node) => [node.path, node]));

const NESTED_PATH = "04000561/0/04000550/0/00080090";
const TOP_LEVEL_PATH = "00080090";

function manifestValue(entryPath: string): string | undefined {
  return expectedFindings.find((f) => f.path === entryPath)?.value;
}

describe("parseMetadata on the fixture", () => {
  it("has a node for every path in the manifest's expectedFindings and expectedKept", () => {
    const paths = [...expectedFindings, ...expectedKept].map((entry) => entry.path);
    expect(paths.length).toBe(45);
    expect(paths.filter((p) => !byPath.has(p))).toEqual([]);
  });

  it("holds more nodes than the manifest lists", () => {
    expect(flat.length).toBeGreaterThan(45);
  });

  it("tag and vr agree with the manifest", () => {
    const wrong = [...expectedFindings, ...expectedKept].flatMap((entry) => {
      const node = byPath.get(entry.path);
      if (node && node.tag === entry.tag && node.vr === entry.vr) return [];
      return [`${entry.path}: manifest ${entry.tag}/${entry.vr}, node ${node?.tag}/${node?.vr}`];
    });
    expect(wrong).toEqual([]);
  });

  it("values agree with every manifest entry that records one", () => {
    const wrong = expectedFindings.flatMap((entry) => {
      if (entry.value === undefined) return [];
      const node = byPath.get(entry.path);
      if (node?.value === entry.value) return [];
      return [`${entry.path}: manifest ${JSON.stringify(entry.value)}, node ${JSON.stringify(node?.value)}`];
    });
    expect(wrong).toEqual([]);
  });

  it("includes group 0002: the file meta elements are in the tree", () => {
    const node = byPath.get("00020003");
    expect(node).toBeDefined();
    expect(node?.value).toBe(manifestValue("00020003"));
  });

  it("has unique paths across the whole tree", () => {
    const paths = flat.map((node) => node.path);
    expect(paths.filter((p, i) => paths.indexOf(p) !== i)).toEqual([]);
    expect(new Set(paths).size).toBe(flat.length);
  });

  it("includes the pixel data element as a node with a VR and no value", () => {
    const node = byPath.get("7fe00010");
    expect(node?.vr).toBe("OW");
    expect(node?.value).toBeUndefined();
  });
});

describe("nesting", () => {
  it("keeps the nested and top-level ReferringPhysicianName apart", () => {
    const nested = byPath.get(NESTED_PATH);
    const top = byPath.get(TOP_LEVEL_PATH);

    expect(nested?.value).toBe(manifestValue(NESTED_PATH));
    expect(top?.value).toBe(manifestValue(TOP_LEVEL_PATH));
    expect(nested?.value).toBeDefined();
    expect(nested?.value).not.toBe(top?.value);
  });

  it("nests items as arrays of nodes", () => {
    const outer = byPath.get("04000561");
    expect(outer?.items?.length).toBe(1);
    expect(outer?.items?.[0].map((n) => n.path)).toEqual(["04000561/0/04000550"]);
  });
});

describe("length encoding", () => {
  it("04000561 is undefined length", () => {
    expect(byPath.get("04000561")?.lengthEncoding).toBe("undefined");
  });

  it("04000561/0/04000550 is defined length", () => {
    expect(byPath.get("04000561/0/04000550")?.lengthEncoding).toBe("defined");
  });

  it("no non-SQ node carries lengthEncoding, and every SQ node does", () => {
    expect(flat.filter((n) => n.vr !== "SQ" && n.lengthEncoding !== undefined)).toEqual([]);
    expect(flat.filter((n) => n.vr === "SQ" && n.lengthEncoding === undefined)).toEqual([]);
  });

  it("agrees with the manifest for every sequence finding", () => {
    const sequences = expectedFindings.filter((f) => f.vr === "SQ");
    expect(sequences.length).toBe(2);
    for (const entry of sequences) {
      expect(byPath.get(entry.path)?.lengthEncoding).toBe(entry.lengthEncoding);
    }
  });
});

describe("pixel data is not required", () => {
  it("parses the header identically from bytes cut off where the pixel data begins", () => {
    const { dataOffset } = parseDicom(bytes, { untilTag: "x7fe00010" }).elements.x7fe00010;

    expect(dataOffset).toBeGreaterThan(0);
    expect(dataOffset).toBeLessThan(bytes.length);

    const truncated = bytes.slice(0, dataOffset);
    expect(truncated.length).toBe(dataOffset);
    expect(parseMetadata(truncated)).toEqual(tree);
  });
});

describe("invalid input", () => {
  const notDicom: [string, Uint8Array][] = [
    ["ASCII text", new TextEncoder().encode("this is not a dicom file. ".repeat(40))],
    ["zeros", new Uint8Array(1000)],
    ["a PNG signature", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(200).fill(0)])],
    ["an empty buffer", new Uint8Array(0)],
  ];

  it.each(notDicom)("throws on %s", (_label, input) => {
    expect(() => parseMetadata(input)).toThrow();
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

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const u16 = (n: number): number[] => [n & 0xff, n >> 8];
const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const tagBytes = (group: number, element: number): number[] => [...u16(group), ...u16(element)];
const UNDEFINED_LENGTH = 0xffffffff;

const lo = (group: number, element: number, value: string): number[] => [
  ...tagBytes(group, element), ...ascii("LO"), ...u16(value.length), ...ascii(value),
];
const undefinedLengthItem = (children: number[]): number[] => [
  ...tagBytes(0xfffe, 0xe000), ...u32(UNDEFINED_LENGTH), ...children,
  ...tagBytes(0xfffe, 0xe00d), ...u32(0),
];
const undefinedLengthSequence = (group: number, element: number, items: number[][]): number[] => [
  ...tagBytes(group, element), ...ascii("SQ"), 0, 0, ...u32(UNDEFINED_LENGTH), ...items.flat(),
  ...tagBytes(0xfffe, 0xe0dd), ...u32(0),
];

// Explicit VR little endian. Sequence 0008,1140 has two undefined-length items; item 0 holds
// two elements and a nested sequence whose own item is undefined-length too.
function undefinedLengthItemFile(): Uint8Array {
  const transferSyntax = "1.2.840.10008.1.2.1\0";
  const metaBody = [...tagBytes(2, 0x10), ...ascii("UI"), ...u16(transferSyntax.length), ...ascii(transferSyntax)];
  const meta = [...tagBytes(2, 0), ...ascii("UL"), ...u16(4), ...u32(metaBody.length), ...metaBody];

  const nested = undefinedLengthSequence(0x0008, 0x1115, [undefinedLengthItem(lo(0x10, 0x20, "ID03"))]);
  const item0 = undefinedLengthItem([...lo(0x10, 0x20, "ID01"), ...lo(0x10, 0x1000, "ID02"), ...nested]);
  const item1 = undefinedLengthItem(lo(0x10, 0x20, "ID04"));
  const dataset = [
    ...tagBytes(0x10, 0x10), ...ascii("PN"), ...u16(4), ...ascii("A^B "),
    ...undefinedLengthSequence(0x0008, 0x1140, [item0, item1]),
    ...tagBytes(0x08, 0x60), ...ascii("CS"), ...u16(2), ...ascii("MR"),
  ];
  return new Uint8Array([...new Array<number>(128).fill(0), ...ascii("DICM"), ...meta, ...dataset]);
}

describe("structural delimiters (group FFFE)", () => {
  it("are absent from the fixture tree", () => {
    expect(flat.filter((node) => tagGroup(node.tag) === 0xfffe)).toEqual([]);
  });

  it("are skipped inside undefined-length items at every depth, without shifting any path", () => {
    const nodes = flattenNodes(parseMetadata(undefinedLengthItemFile()));

    expect(nodes.map((n) => n.path)).toEqual([
      "00100010",
      "00081140",
      "00081140/0/00100020",
      "00081140/0/00101000",
      "00081140/0/00081115",
      "00081140/0/00081115/0/00100020",
      "00081140/1/00100020",
      "00080060",
      "00020000",
      "00020010",
    ]);
    expect(nodes.filter((n) => tagGroup(n.tag) === 0xfffe)).toEqual([]);
    expect(nodes.filter((n) => n.path.includes("fffe"))).toEqual([]);

    const values = Object.fromEntries(nodes.filter((n) => n.value !== undefined).map((n) => [n.path, n.value]));
    expect(values["00081140/0/00100020"]).toBe("ID01");
    expect(values["00081140/0/00101000"]).toBe("ID02");
    expect(values["00081140/0/00081115/0/00100020"]).toBe("ID03");
    expect(values["00081140/1/00100020"]).toBe("ID04");
    expect(values["00080060"]).toBe("MR");
  });

  it("keeps the sequences' items and lengthEncoding intact", () => {
    const nodes = flattenNodes(parseMetadata(undefinedLengthItemFile()));
    const outer = nodes.find((n) => n.path === "00081140");
    const inner = nodes.find((n) => n.path === "00081140/0/00081115");

    expect(outer?.items?.map((item) => item.length)).toEqual([3, 1]);
    expect(outer?.lengthEncoding).toBe("undefined");
    expect(inner?.items?.map((item) => item.length)).toEqual([1]);
    expect(inner?.lengthEncoding).toBe("undefined");
  });
});
