import { describe, expect, it } from "vitest";
import { parseDicom } from "dicom-parser";
import fs from "node:fs";
import path from "node:path";
import { flattenNodes } from "../model/tree";
import { parseMetadata } from "./walk";
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

function part10(dataset: number[]): Uint8Array {
  const transferSyntax = "1.2.840.10008.1.2.1\0";
  const metaBody = [...tagBytes(2, 0x10), ...ascii("UI"), ...u16(transferSyntax.length), ...ascii(transferSyntax)];
  const meta = [...tagBytes(2, 0), ...ascii("UL"), ...u16(4), ...u32(metaBody.length), ...metaBody];
  return new Uint8Array([...new Array<number>(128).fill(0), ...ascii("DICM"), ...meta, ...dataset]);
}

const longVr = (group: number, element: number, vr: string, length: number, body: number[]): number[] => [
  ...tagBytes(group, element), ...ascii(vr), 0, 0, ...u32(length), ...body,
];

// Pixel data encoded with undefined length, as compressed images are. The parser stops at its header.
function encapsulatedPixelDataFile(vr: string): Uint8Array {
  return part10([
    ...tagBytes(0x08, 0x60), ...ascii("CS"), ...u16(2), ...ascii("MR"),
    ...longVr(0x7fe0, 0x10, vr, UNDEFINED_LENGTH, []),
  ]);
}

// An item holding a private OB of six bytes, a private OB of none, and a string.
function binaryInItemFile(): Uint8Array {
  const item = [
    ...longVr(0x29, 0x1001, "OB", 6, [1, 2, 3, 4, 5, 6]),
    ...longVr(0x29, 0x1002, "OB", 0, []),
    ...lo(0x10, 0x20, "ID01"),
  ];
  const sequence = [...tagBytes(0x08, 0x1140), ...ascii("SQ"), 0, 0, ...u32(item.length + 8), ...tagBytes(0xfffe, 0xe000), ...u32(item.length), ...item];
  return part10(sequence);
}

const BINARY = ["OB", "OW", "OF", "OD", "OL", "OV", "UN"];

describe("length of binary elements", () => {
  const binaryNodes = flat.filter((n) => BINARY.includes(n.vr));

  it("is carried by both binary nodes in the fixture, as the true byte count", () => {
    expect(binaryNodes.map((n) => n.path).sort()).toEqual(["00020001", "7fe00010"]);
    expect(byPath.get("00020001")?.length).toBe(2);

    // The pixel data element's header is read, then parsing stops, so its length is the header's own.
    const { dataOffset, length } = parseDicom(bytes, { untilTag: "x7fe00010" }).elements.x7fe00010;
    expect(byPath.get("7fe00010")?.length).toBe(length);
    expect(byPath.get("7fe00010")?.length).toBe(bytes.length - dataOffset);
    expect(byPath.get("7fe00010")?.length).toBe(131072);
  });

  it("never carries any byte data: a binary node holds a number and nothing else", () => {
    for (const node of binaryNodes) {
      expect(typeof node.length, node.path).toBe("number");
      expect(node.value, node.path).toBeUndefined();
      expect(Object.keys(node).sort(), node.path).toEqual(["length", "path", "tag", "vr"]);
    }
    expect(JSON.stringify(tree)).not.toMatch(/"(bytes|data|buffer)"/);
  });

  it("is absent from every node that is not binary: it is not a general field", () => {
    const others = flat.filter((n) => !BINARY.includes(n.vr));
    expect(others.length).toBeGreaterThan(40);
    expect(others.filter((n) => "length" in n).map((n) => n.path)).toEqual([]);
  });

  it("leaves length unset, not 4294967295, for an undefined-length element such as encapsulated pixel data", () => {
    const nodes = parseMetadata(encapsulatedPixelDataFile("OB"));
    const pixel = nodes.find((n) => n.tag === "7fe00010");

    expect(pixel?.vr).toBe("OB");
    expect(pixel).not.toHaveProperty("length");
    expect(JSON.stringify(nodes)).not.toContain("4294967295");
  });

  it("keeps a real length of zero, and a defined length inside an item", () => {
    const nodes = flattenNodes(parseMetadata(binaryInItemFile()));
    const byPathHere = new Map(nodes.map((n) => [n.path, n]));

    expect(byPathHere.get("00081140/0/00291001")?.length).toBe(6);
    expect(byPathHere.get("00081140/0/00291002")?.length).toBe(0);
    expect(byPathHere.get("00081140/0/00291002")).toHaveProperty("length", 0);
    expect(byPathHere.get("00081140/0/00100020")).not.toHaveProperty("length");
  });
});

const f32 = (n: number): number[] => [...new Uint8Array(new Float32Array([n]).buffer)];
const f64 = (n: number): number[] => [...new Uint8Array(new Float64Array([n]).buffer)];
const i16 = (n: number): number[] => [...new Uint8Array(new Int16Array([n]).buffer)];
const i32 = (n: number): number[] => [...new Uint8Array(new Int32Array([n]).buffer)];
const shortVr = (group: number, element: number, vr: string, body: number[]): number[] => [
  ...tagBytes(group, element), ...ascii(vr), ...u16(body.length), ...body,
];

describe("numeric values", () => {
  const read = (...elements: number[][]) => {
    const nodes = flattenNodes(parseMetadata(part10(elements.flat())));
    return (tag: string) => nodes.find((n) => n.tag === tag);
  };

  it("reads each numeric VR from the fixture where it exists", () => {
    expect(byPath.get("00280010")?.value).toBe("256"); // US
    expect(byPath.get("00280100")?.value).toBe("16"); // US
    expect(byPath.get("00020000")?.value).toBe("198"); // UL: the file meta group length
    expect(byPath.get("00280002")?.value).toBe("1");
    expect(byPath.get("00280103")?.value).toBe("0");
  });

  it.each([
    ["US", u16(65535), "65535"],
    ["SS", i16(-2), "-2"],
    ["UL", u32(4000000000), "4000000000"],
    ["SL", i32(-100000), "-100000"],
    ["FL", f32(0.5), "0.5"],
    ["FD", f64(1.25), "1.25"],
  ])("reads %s from a constructed element", (vr, body, expected) => {
    const node = read(shortVr(0x0009, 0x0000, vr, body))("00090000");
    expect(node?.vr).toBe(vr);
    expect(node?.value).toBe(expected);
  });

  it("reads an attribute tag as a formatted tag", () => {
    const node = read(shortVr(0x0009, 0x0001, "AT", [...u16(0x0010), ...u16(0x0010)]))("00090001");
    expect(node?.value).toBe("(0010,0010)");
  });

  it("pads and upper-cases the hex of an attribute tag", () => {
    const node = read(shortVr(0x0009, 0x0001, "AT", [...u16(0x00e1), ...u16(0x00ab)]))("00090001");
    expect(node?.value).toBe("(00E1,00AB)");
  });

  it("joins several values with a backslash, as DICOM does", () => {
    expect(read(shortVr(0x0009, 0x0002, "US", [...u16(1), ...u16(2), ...u16(3)]))("00090002")?.value).toBe("1\\2\\3");
    expect(read(shortVr(0x0009, 0x0002, "SS", [...i16(-1), ...i16(5)]))("00090002")?.value).toBe("-1\\5");
    expect(read(shortVr(0x0009, 0x0002, "FD", [...f64(0.5), ...f64(-2)]))("00090002")?.value).toBe("0.5\\-2");
    const two = shortVr(0x0009, 0x0002, "AT", [...u16(0x10), ...u16(0x10), ...u16(0x10), ...u16(0x20)]);
    expect(read(two)("00090002")?.value).toBe("(0010,0010)\\(0010,0020)");
  });

  it("shows sixteen values in full, and cuts a longer list with the count", () => {
    const list = (n: number) => shortVr(0x0009, 0x0003, "US", Array.from({ length: n }, (_, i) => u16(i + 1)).flat());
    const sixteen = Array.from({ length: 16 }, (_, i) => i + 1).join("\\");

    expect(read(list(16))("00090003")?.value).toBe(sixteen);
    expect(read(list(17))("00090003")?.value).toBe(`${sixteen} … (17 values in all)`);
    expect(read(list(30))("00090003")?.value).toBe(`${sixteen} … (30 values in all)`);
  });

  describe("a 32-bit float is written with the fewest digits that name the same float", () => {
    const fl = (n: number) => read(shortVr(0x0009, 0x0004, "FL", f32(n)))("00090004")?.value;

    it("shows the float32 nearest 0.1 as 0.1, not 0.10000000149011612", () => {
      expect(fl(0.1)).toBe("0.1");
      expect(fl(0.5)).toBe("0.5");
      expect(fl(-2.5)).toBe("-2.5");
    });

    it("keeps every digit a value needs", () => {
      // The float32 nearest 0.11708920449018478 needs nine significant digits.
      expect(fl(0.11708920449018478)).toBe("0.117089204");
      expect(fl(15.28294849395752)).toBe("15.2829485");
      expect(fl(3.4028234663852886e38)).toBe("3.4028235e+38");
    });

    it("round-trips zero, a negative, and large and small exponents", () => {
      for (const n of [0, -1.5, -0.001, 1e21, -1e21, 1e-45, 3.4028234663852886e38, 16777216, 123456.789]) {
        const shown = fl(n);
        expect(Math.fround(Number(shown)), String(n)).toBe(Math.fround(n));
      }
      expect(fl(0)).toBe("0");
      expect(fl(1e21)).toBe("1e+21");
      expect(fl(1e-45)).toBe("1e-45");
    });

    it("is never longer than the float's own default conversion, and never a different float", () => {
      for (let i = 0; i < 500; i++) {
        const n = Math.fround((i - 250) * 0.37 + i / 7);
        const shown = fl(n) as string;
        expect(shown.length, String(n)).toBeLessThanOrEqual(String(n).length);
        expect(Math.fround(Number(shown)), String(n)).toBe(n);
      }
    });

    it("leaves a 64-bit float alone: JavaScript's own conversion is already the shortest", () => {
      expect(read(shortVr(0x0009, 0x0005, "FD", f64(0.1)))("00090005")?.value).toBe("0.1");
      expect(read(shortVr(0x0009, 0x0005, "FD", f64(1 / 3)))("00090005")?.value).toBe(String(1 / 3));
    });

    it("keeps NaN and infinity readable", () => {
      expect(fl(NaN)).toBe("NaN");
      expect(fl(Infinity)).toBe("Infinity");
    });
  });

  it("gives a zero-length numeric element an empty value, as a string VR gets", () => {
    const node = read(shortVr(0x0009, 0x0007, "US", []))("00090007");
    expect(node).toHaveProperty("value", "");
  });

  it("leaves a length that is not a whole number of values unread, rather than guessing", () => {
    for (const [vr, bytes] of [["US", 3], ["UL", 6], ["FD", 4], ["AT", 2]] as const) {
      const node = read(shortVr(0x0009, 0x0008, vr, new Array<number>(bytes).fill(1)))("00090008");
      expect(node?.vr, vr).toBe(vr);
      expect(node, vr).not.toHaveProperty("value");
    }
  });

  // OV is left out: dicom-parser 1.8.21 gives it a 2-byte length like a short VR, so an explicit-VR
  // OV element cannot be built for it. That is a parser limitation, reported with 1.7a, not fixed.
  it("leaves the other VRs exactly as they were: UN, OB, OW, OF, OD, OL and SQ read no value", () => {
    for (const vr of ["OB", "OW", "OF", "OD", "OL", "UN"]) {
      const node = read(longVr(0x0009, 0x0009, vr, 4, [1, 2, 3, 4]))("00090009");
      expect(node, vr).not.toHaveProperty("value");
      expect(node?.length, vr).toBe(4);
    }
    const seq = flattenNodes(parseMetadata(undefinedLengthItemFile())).find((n) => n.tag === "00081140");
    expect(seq).not.toHaveProperty("value");
  });
});

describe("walk.ts stays free of the dictionary", () => {
  it("imports only the parser, the tag helpers, the VR helpers and types: the VR arrives by injection", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "walk.ts"), "utf8");
    const modules = source.split("\n").filter((line) => /^\s*import\b/.test(line)).map((line) => /from\s+["']([^"']+)["']/.exec(line)?.[1]);

    expect(modules.sort()).toEqual(["../model/tag", "../model/types", "../model/vr", "dicom-parser", "dicom-parser"]);
    expect(modules.filter((m) => /dictionary|annex-e|rules/.test(m ?? ""))).toEqual([]);
  });
});

describe("the injected VR callback", () => {
  // Implicit VR little endian: tag, 4-byte length, value. The stream carries no VR.
  const implicit = (elements: number[]): Uint8Array => {
    const ts = "1.2.840.10008.1.2\0";
    const body = [...tagBytes(2, 0x10), ...ascii("UI"), ...u16(ts.length), ...ascii(ts)];
    const meta = [...tagBytes(2, 0), ...ascii("UL"), ...u16(4), ...u32(body.length), ...body];
    return new Uint8Array([...new Array<number>(128).fill(0), ...ascii("DICM"), ...meta, ...elements]);
  };
  const el = (group: number, element: number, body: number[]): number[] => [...tagBytes(group, element), ...u32(body.length), ...body];
  const data = implicit([...el(0x10, 0x10, ascii("A^B ")), ...el(0x28, 0x10, u16(256)), ...el(0x29, 0x1001, ascii("SECRET"))]);
  const dictionary: Record<string, string> = { x00100010: "PN", x00280010: "US" };

  it("without one, behaves as before: every implicit element is UN and none has a value", () => {
    const nodes = parseMetadata(data);
    expect(nodes.filter((n) => n.tag !== "00020000" && n.tag !== "00020010").map((n) => [n.tag, n.vr])).toEqual([
      ["00100010", "UN"],
      ["00280010", "UN"],
      ["00291001", "UN"],
    ]);
    expect(nodes.filter((n) => "value" in n && n.tag !== "00020000" && n.tag !== "00020010")).toEqual([]);
  });

  it("with one, resolves the VR it returns and reads the value", () => {
    const nodes = parseMetadata(data, { vrCallback: (tag) => dictionary[tag] });
    const byTag = new Map(nodes.map((n) => [n.tag, n]));

    expect(byTag.get("00100010")).toMatchObject({ vr: "PN", value: "A^B" });
    expect(byTag.get("00280010")).toMatchObject({ vr: "US", value: "256" });
  });

  it("falls back to UN, with no value, where it returns undefined", () => {
    const nodes = parseMetadata(data, { vrCallback: (tag) => dictionary[tag] });
    const secret = nodes.find((n) => n.tag === "00291001");

    expect(secret?.vr).toBe("UN");
    expect(secret).not.toHaveProperty("value");
    expect(secret?.length).toBe(6);
  });

  it("is not called for an explicit-VR file, where the stream carries the VR", () => {
    const seen: string[] = [];
    const nodes = parseMetadata(bytes, { vrCallback: (tag) => (seen.push(tag), undefined) });

    expect(seen).toEqual([]);
    expect(nodes).toEqual(tree);
  });

  it("is given dicom-parser's own tag format: an x and eight lowercase hex characters", () => {
    const seen: string[] = [];
    parseMetadata(data, { vrCallback: (tag) => (seen.push(tag), undefined) });

    expect(seen).toEqual(["x00100010", "x00280010", "x00291001"]);
    for (const tag of seen) expect(tag).toMatch(/^x[0-9a-f]{8}$/);
  });
});

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
