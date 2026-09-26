import type { TagNode } from "./types";

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
