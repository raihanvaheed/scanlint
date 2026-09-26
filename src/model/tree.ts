import type { Finding, TagNode } from "./types";

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

/** The findings that count as identifying. The burned-in flag is a statement about the image, reported separately. */
export function identifyingFindings(findings: Finding[]): Finding[] {
  return findings.filter((finding) => finding.kind !== "burned-in");
}
