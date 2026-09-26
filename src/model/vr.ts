const BINARY_VRS = new Set(["OB", "OW", "OF", "OD", "OL", "OV", "UN"]);

/** VRs whose value is bytes. Their contents are never read or displayed, only their length. */
export function isBinaryVr(vr: string): boolean {
  return BINARY_VRS.has(vr);
}

/**
 * The dictionary lists 38 attributes whose VR depends on context, as "US or SS" or "OB or OW".
 * Implicit VR needs one answer, so this takes the first listed. It only affects how a value is
 * read, never how the stream is walked: implicit VR gives every element a 4-byte length.
 */
export function splitVr(vr: string): string {
  return vr.split(" or ")[0].trim();
}
