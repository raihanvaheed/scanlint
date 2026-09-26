import annexE from "./annex-e.json";
import { assertNormalizedTag } from "./tag";

export type AnnexEEntry = {
  tag: string;
  name: string;
  retired: boolean;
  inStandardCompositeIod: boolean | null;
  actions: Record<string, string | null>;
};

export type AnnexEPattern = {
  tagPattern: string;
  match: "nibbleMask" | "oddGroup";
  mask?: string;
  name: string;
  retired: boolean;
  inStandardCompositeIod: boolean | null;
  actions: Record<string, string | null>;
};

type RawPattern = Omit<AnnexEPattern, "match" | "mask"> & {
  match: string;
  mask?: string;
};

export const ANNEX_E_EDITION: string = annexE.source.edition;

const NORMALIZED_TAG = /^[0-9a-f]{8}$/;
const NIBBLE_MASK = /^[0-9a-fx]{8}$/;

const entriesByTag = new Map<string, AnnexEEntry>();
for (const entry of annexE.attributes) {
  if (!NORMALIZED_TAG.test(entry.tag)) {
    throw new Error(`annex-e.json: tag is not normalised: "${entry.tag}"`);
  }
  entriesByTag.set(entry.tag, entry);
}

function toPattern(raw: RawPattern): AnnexEPattern {
  if (raw.match === "nibbleMask") {
    if (raw.mask === undefined || !NIBBLE_MASK.test(raw.mask)) {
      throw new Error(
        `annex-e.json: invalid mask for ${raw.tagPattern}: "${String(raw.mask)}"`,
      );
    }
    return { ...raw, match: raw.match };
  }
  if (raw.match === "oddGroup") {
    return { ...raw, match: raw.match };
  }
  throw new Error(`annex-e.json: unknown match "${raw.match}" for ${raw.tagPattern}`);
}

const nibbleMasks: { pattern: AnnexEPattern; mask: string }[] = [];
for (const raw of annexE.patterns) {
  const pattern = toPattern(raw);
  if (pattern.match === "nibbleMask" && pattern.mask !== undefined) {
    nibbleMasks.push({ pattern, mask: pattern.mask });
  }
}

function maskMatches(tag: string, mask: string): boolean {
  for (let i = 0; i < 8; i++) {
    if (mask[i] !== "x" && mask[i] !== tag[i]) return false;
  }
  return true;
}

/** Exact match only. Never consults patterns. Takes a normalised tag. */
export function lookupAnnexE(tag: string): AnnexEEntry | undefined {
  assertNormalizedTag(tag);
  return entriesByTag.get(tag);
}

// The oddGroup pattern (Private Attributes) is stored so the JSON mirrors the published
// table, but it is never matched here. ScanLint classifies private tags with
// isPrivateTag, as kind "private" with no action; matching them here as well would give
// one tag two classifications.
export function matchAnnexEPattern(tag: string): AnnexEPattern | undefined {
  assertNormalizedTag(tag);
  return nibbleMasks.find(({ mask }) => maskMatches(tag, mask))?.pattern;
}

/** An exact entry always wins over a pattern. */
export function basicProfileAction(tag: string): string | undefined {
  const exact = lookupAnnexE(tag);
  if (exact) return exact.actions.basic ?? undefined;
  return matchAnnexEPattern(tag)?.actions.basic ?? undefined;
}
