import { parseDicom } from "dicom-parser";
import type { DataSet } from "dicom-parser";
import { formatTag, normalizeTag, tagGroup } from "../model/tag";
import { isBinaryVr } from "../model/vr";
import type { TagNode } from "../model/types";

const STRING_VRS = new Set([
  "AE", "AS", "CS", "DA", "DS", "DT", "IS", "LO", "LT", "PN", "SH", "ST", "TM", "UC", "UI", "UR", "UT",
]);

// The 32-bit value dicom-parser reports for an element encoded with undefined length.
const UNDEFINED_LENGTH = 0xffffffff;

// Numeric VRs: how wide one value is, and how to read the nth one.
type Numeric = { width: number; read: (dataSet: DataSet, key: string, index: number) => string | undefined };

const str = (n: number | undefined): string | undefined => (n === undefined ? undefined : String(n));

// The fewest digits that still name exactly this 32-bit float. It is not rounding: the result converts
// back to the same float32. (A float32 read into a JS number carries 17 digits, most of them noise.)
function formatFloat32(v: number): string {
  for (let p = 1; p <= 9; p++) {
    const s = v.toPrecision(p);
    if (Math.fround(Number(s)) === v) return String(Number(s));
  }
  return String(v);
}

const NUMERIC_VRS: Record<string, Numeric> = {
  US: { width: 2, read: (d, k, i) => str(d.uint16(k, i)) },
  SS: { width: 2, read: (d, k, i) => str(d.int16(k, i)) },
  UL: { width: 4, read: (d, k, i) => str(d.uint32(k, i)) },
  SL: { width: 4, read: (d, k, i) => str(d.int32(k, i)) },
  FL: { width: 4, read: (d, k, i) => { const v = d.float(k, i); return v === undefined ? undefined : formatFloat32(v); } },
  FD: { width: 8, read: (d, k, i) => str(d.double(k, i)) },
  // An attribute tag is a tag, so it is shown as one.
  AT: {
    width: 4,
    read: (d, k, i) => {
      const group = d.uint16(k, 2 * i);
      const element = d.uint16(k, 2 * i + 1);
      if (group === undefined || element === undefined) return undefined;
      return formatTag(group.toString(16).padStart(4, "0") + element.toString(16).padStart(4, "0"));
    },
  },
};

const MAX_VALUES = 16;

// Values are joined with DICOM's own delimiter. A length that is not a whole number of values is
// malformed, and is left unread rather than guessed at.
function readNumeric(dataSet: DataSet, key: string, vr: string, length: number): string | undefined {
  const numeric = NUMERIC_VRS[vr];
  if (numeric === undefined || length === UNDEFINED_LENGTH || length % numeric.width !== 0) return undefined;
  if (length === 0) return "";

  const count = length / numeric.width;
  const shown: string[] = [];
  for (let i = 0; i < Math.min(count, MAX_VALUES); i++) {
    const value = numeric.read(dataSet, key, i);
    if (value === undefined) return undefined;
    shown.push(value);
  }
  return count > MAX_VALUES ? `${shown.join("\\")} … (${count} values in all)` : shown.join("\\");
}

function walkDataSet(dataSet: DataSet, prefix: string): TagNode[] {
  const nodes: TagNode[] = [];

  for (const [key, element] of Object.entries(dataSet.elements)) {
    const tag = normalizeTag(key);
    if (tagGroup(tag) === 0xfffe) continue;
    const path = prefix === "" ? tag : `${prefix}/${tag}`;
    const vr = element.vr ?? "UN";
    const node: TagNode = { tag, path, vr };

    if (STRING_VRS.has(vr)) {
      const value = dataSet.string(key);
      if (value !== undefined) node.value = value;
    } else {
      const value = readNumeric(dataSet, key, vr, element.length);
      if (value !== undefined) node.value = value;
    }

    // Byte counts only, never bytes. Undefined length (encapsulated pixel data) has no count to show.
    if (isBinaryVr(vr) && element.length !== UNDEFINED_LENGTH) node.length = element.length;

    if (element.items !== undefined) {
      node.items = element.items.map((item, index) =>
        item.dataSet ? walkDataSet(item.dataSet, `${path}/${index}`) : [],
      );
      node.lengthEncoding = element.hadUndefinedLength === true ? "undefined" : "defined";
    }

    nodes.push(node);
  }

  return nodes;
}

type ParseOptions = {
  /**
   * Supplies a VR for a tag in implicit-VR data, where the stream carries none. It is injected so
   * this file stays free of the dictionary. Receives dicom-parser's own tag format.
   */
  vrCallback?: (tag: string) => string | undefined;
};

export function parseMetadata(bytes: Uint8Array, options: ParseOptions = {}): TagNode[] {
  const dataSet = parseDicom(bytes, { untilTag: "x7fe00010", vrCallback: options.vrCallback });
  return walkDataSet(dataSet, "");
}
