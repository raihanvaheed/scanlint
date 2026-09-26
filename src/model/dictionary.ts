import dictionary from "./dictionary.json";
import { assertNormalizedTag, isPrivateTag } from "./tag";
import type { TagNode } from "./types";

// Readonly because lookupAttribute hands out the dictionary's own objects, not copies.
export type Attribute = { readonly name: string; readonly vr?: string };

const NORMALIZED_TAG = /^[0-9a-f]{8}$/;
const NIBBLE_MASK = /^[0-9a-fx]{8}$/;

const attributes: Record<string, Attribute> = dictionary.attributes;

for (const tag of Object.keys(attributes)) {
  if (!NORMALIZED_TAG.test(tag)) {
    throw new Error(`dictionary.json: tag is not normalised: "${tag}"`);
  }
}

// Kept in file order: the first matching pattern wins.
const patterns: { mask: string; attribute: Attribute }[] = dictionary.patterns.map((pattern) => {
  if (!NIBBLE_MASK.test(pattern.mask)) {
    throw new Error(`dictionary.json: invalid mask for ${pattern.tagPattern}: "${pattern.mask}"`);
  }
  const attribute: Attribute = pattern.vr === undefined ? { name: pattern.name } : { name: pattern.name, vr: pattern.vr };
  return { mask: pattern.mask, attribute };
});

// Synthesised, not a table row: group length elements (gggg,0000) are a PS3.5 convention that
// the registry does not list. Their VR is UL, which implicit-VR data needs in order to read them.
const GROUP_LENGTH: Attribute = Object.freeze({ name: "Group Length", vr: "UL" });

function maskMatches(tag: string, mask: string): boolean {
  for (let i = 0; i < 8; i++) {
    if (mask[i] !== "x" && mask[i] !== tag[i]) return false;
  }
  return true;
}

/** Takes a normalised tag. Exact entry, then the first matching pattern, then group length. */
export function lookupAttribute(tag: string): Attribute | undefined {
  assertNormalizedTag(tag);

  // Private tags have no registry name. Checking first also stops a loose pattern such as
  // (50xx,0010) from naming an odd-group tag.
  if (isPrivateTag(tag)) return undefined;

  const exact = attributes[tag];
  if (exact) return exact;

  const pattern = patterns.find(({ mask }) => maskMatches(tag, mask));
  if (pattern) return pattern.attribute;

  return tag.endsWith("0000") ? GROUP_LENGTH : undefined;
}

/** Returns new nodes with `name` added where the tag resolves. Does not mutate its input. */
export function applyNames(nodes: TagNode[]): TagNode[] {
  return nodes.map((node) => {
    const attribute = lookupAttribute(node.tag);
    const named: TagNode = attribute ? { ...node, name: attribute.name } : { ...node };
    if (node.items) named.items = node.items.map(applyNames);
    return named;
  });
}
