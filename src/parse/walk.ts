import { parseDicom } from "dicom-parser";
import type { DataSet } from "dicom-parser";
import { normalizeTag } from "../model/tag";
import type { TagNode } from "../model/types";

const STRING_VRS = new Set([
  "AE", "AS", "CS", "DA", "DS", "DT", "IS", "LO", "LT", "PN", "SH", "ST", "TM", "UC", "UI", "UR", "UT",
]);

function walkDataSet(dataSet: DataSet, prefix: string): TagNode[] {
  const nodes: TagNode[] = [];

  for (const [key, element] of Object.entries(dataSet.elements)) {
    const tag = normalizeTag(key);
    const path = prefix === "" ? tag : `${prefix}/${tag}`;
    const vr = element.vr ?? "UN";
    const node: TagNode = { tag, path, vr };

    if (STRING_VRS.has(vr)) {
      const value = dataSet.string(key);
      if (value !== undefined) node.value = value;
    }

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

export function parseMetadata(bytes: Uint8Array): TagNode[] {
  const dataSet = parseDicom(bytes, { untilTag: "x7fe00010" });
  return walkDataSet(dataSet, "");
}

export function flattenNodes(nodes: TagNode[]): TagNode[] {
  const flat: TagNode[] = [];
  for (const node of nodes) {
    flat.push(node);
    for (const item of node.items ?? []) {
      flat.push(...flattenNodes(item));
    }
  }
  return flat;
}
