const NORMALIZED = /^[0-9a-f]{8}$/;

const ACCEPTED_FORMS: RegExp[] = [
  /^\(([0-9a-f]{4}),([0-9a-f]{4})\)$/i,
  /^([0-9a-f]{4}),([0-9a-f]{4})$/i,
  /^(?:0x|x)?([0-9a-f]{4})([0-9a-f]{4})$/i,
];

/** The only way a tag string enters the project: 8 lowercase hex characters. */
export function normalizeTag(input: string): string {
  const trimmed = String(input).trim();
  for (const form of ACCEPTED_FORMS) {
    const match = form.exec(trimmed);
    if (match) return (match[1] + match[2]).toLowerCase();
  }
  throw new TypeError(`Invalid DICOM tag "${String(input)}"`);
}

/** Throws unless `tag` is already normalised. Used instead of normalising silently. */
export function assertNormalizedTag(tag: string): void {
  if (!NORMALIZED.test(tag)) {
    throw new TypeError(
      `Expected a normalised tag (8 lowercase hex characters), got "${String(tag)}"`,
    );
  }
}

export function formatTag(tag: string): string {
  assertNormalizedTag(tag);
  return `(${tag.slice(0, 4).toUpperCase()},${tag.slice(4).toUpperCase()})`;
}

export function tagGroup(tag: string): number {
  assertNormalizedTag(tag);
  return parseInt(tag.slice(0, 4), 16);
}

export function tagElement(tag: string): number {
  assertNormalizedTag(tag);
  return parseInt(tag.slice(4), 16);
}

export function isPrivateTag(tag: string): boolean {
  return tagGroup(tag) % 2 === 1;
}

export function isPrivateCreator(tag: string): boolean {
  const element = tagElement(tag);
  return isPrivateTag(tag) && element >= 0x0010 && element <= 0x00ff;
}
