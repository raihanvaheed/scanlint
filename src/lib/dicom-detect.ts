const MAGIC_OFFSET = 128;
const MAGIC = "DICM";

/** True when the header carries the Part 10 preamble's "DICM" magic at byte 128. */
export function hasDicomMagic(header: ArrayBuffer): boolean {
  if (header.byteLength < MAGIC_OFFSET + MAGIC.length) return false;
  const bytes = new Uint8Array(header, MAGIC_OFFSET, MAGIC.length);
  return String.fromCharCode(...bytes) === MAGIC;
}

const MEDIA_STORAGE_DIRECTORY_SOP_CLASS = "1.2.840.10008.1.3.10";

/** A Media Storage Directory (DICOMDIR): valid DICOM, but not an image, identified by SOP Class. */
export function isDicomDir(nodes: { tag: string; value?: string }[]): boolean {
  return nodes.some((node) => node.tag === "00020002" && node.value === MEDIA_STORAGE_DIRECTORY_SOP_CLASS);
}
