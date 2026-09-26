import { lookupAnnexE, matchAnnexEPattern } from "../model/annex-e";
import { isPrivateTag } from "../model/tag";
import type { Finding, FindingKind, TagNode } from "../model/types";
import { flattenNodes } from "../model/tree";

const BURNED_IN_ANNOTATION = "00280301";

function toFinding(node: TagNode, kind: FindingKind, action?: string | null): Finding {
  const finding: Finding = { path: node.path, tag: node.tag, vr: node.vr, kind };
  if (node.name !== undefined) finding.name = node.name;
  if (action) finding.action = action;
  if (node.value !== undefined) finding.value = node.value;
  if (node.lengthEncoding !== undefined) finding.lengthEncoding = node.lengthEncoding;
  return finding;
}

export function classifyNode(node: TagNode): Finding | undefined {
  if (node.tag === BURNED_IN_ANNOTATION) return toFinding(node, "burned-in");

  // Private classification comes from isPrivateTag alone, never from Annex E's oddGroup row.
  if (isPrivateTag(node.tag)) return toFinding(node, "private");

  const exact = lookupAnnexE(node.tag);
  if (exact) return toFinding(node, "annex-e", exact.actions.basic);

  const pattern = matchAnnexEPattern(node.tag);
  if (pattern) return toFinding(node, "annex-e", pattern.actions.basic);

  return undefined;
}

export function classify(nodes: TagNode[]): Finding[] {
  return flattenNodes(nodes)
    .flatMap((node) => {
      const finding = classifyNode(node);
      return finding ? [finding] : [];
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
