import { readEncapsulatedPixelDataFromFragments } from "dicom-parser";
import type { DataSet, Element } from "dicom-parser";
import { UnsupportedFormatError } from "./errors";
import { decodeRleFrame } from "./rle";

/**
 * Resolves which fragments make up one frame of encapsulated pixel data, and concatenates their
 * raw (still-compressed) bytes - pad byte and all (3.5a: PS3.5 Annex A.4 pads an odd-length
 * fragment to even; that pad is legal DICOM every decoder has to tolerate, so it is never trimmed
 * here). dicom-parser's own `readEncapsulatedPixelData` does almost this, but is deprecated, and -
 * being built for the single-frame case it was first written for - does not implement the empty
 * Basic Offset Table rule below at all (it ignores `frame` entirely and returns every fragment
 * regardless of which one was asked for). This implements PS3.5's actual rule, in the order the
 * standard gives it:
 *
 *  1. NumberOfFrames of 1 or absent: every fragment belongs to the one frame, whatever the offset
 *     table says. This is also the common legacy case, where some encoders write no offset table
 *     at all.
 *  2. A non-empty Basic Offset Table: frame boundaries come from its offsets - a frame is every
 *     fragment from its offset up to the next frame's (or the end, for the last frame).
 *  3. An empty table, with the fragment count equal to NumberOfFrames: one fragment per frame.
 *  4. Anything else: refused, naming both counts. Resolving it needs per-codec marker scanning,
 *     which is out of scope here.
 */
export function extractEncapsulatedFragment(dataSet: DataSet, pixelDataElement: Element, frame: number, numberOfFrames: number): Uint8Array {
  const fragments = pixelDataElement.fragments ?? [];
  const basicOffsetTable = pixelDataElement.basicOffsetTable ?? [];

  if (numberOfFrames <= 1) {
    return readEncapsulatedPixelDataFromFragments(dataSet, pixelDataElement, 0, fragments.length, fragments);
  }

  if (basicOffsetTable.length > 0) {
    const startIndex = frame < basicOffsetTable.length ? fragments.findIndex((f) => f.offset === basicOffsetTable[frame]) : -1;
    const isLastFrame = frame === basicOffsetTable.length - 1;
    const endIndex = startIndex === -1 ? -1 : isLastFrame ? fragments.length : fragments.findIndex((f, i) => i > startIndex && f.offset === basicOffsetTable[frame + 1]);

    if (startIndex !== -1 && endIndex !== -1) {
      return readEncapsulatedPixelDataFromFragments(dataSet, pixelDataElement, startIndex, endIndex - startIndex, fragments);
    }
    throw new UnsupportedFormatError(
      `Frame ${frame} of ${numberOfFrames} could not be matched to a Basic Offset Table entry: it has ${basicOffsetTable.length} entries for ${fragments.length} fragment(s). ` +
        "ScanLint shows images whose frame boundaries the Basic Offset Table or fragment count can resolve.",
    );
  }

  if (fragments.length === numberOfFrames) {
    return readEncapsulatedPixelDataFromFragments(dataSet, pixelDataElement, frame, 1, fragments);
  }

  throw new UnsupportedFormatError(
    `This file declares ${numberOfFrames} frame(s), an empty Basic Offset Table, and ${fragments.length} fragment(s), so frame boundaries are not determinable without per-codec analysis. ` +
      "ScanLint shows images whose frame boundaries the Basic Offset Table or fragment count can resolve.",
  );
}

/**
 * One frame's sample bytes, little-endian, uncompressed — decompressing RLE first when that is how
 * the file stores them. A multi-frame file's pixel data is just every frame's bytes end to end.
 * Exported (not just internal to decode.ts) because the test suite needs the same raw bytes to
 * check against the fixture manifest's own pixel-array hash.
 */
export function extractFrameBytes(
  dataSet: DataSet,
  pixelDataElement: Element,
  frame: number,
  pixelsPerFrame: number,
  samplesPerPixel: number,
  bytesPerSample: number,
  numberOfFrames = 1,
): Uint8Array {
  if (pixelDataElement.encapsulatedPixelData) {
    const compressed = extractEncapsulatedFragment(dataSet, pixelDataElement, frame, numberOfFrames);
    return decodeRleFrame(compressed, pixelsPerFrame, samplesPerPixel, bytesPerSample);
  }

  const bytesPerFrame = pixelsPerFrame * samplesPerPixel * bytesPerSample;
  const byteArray = dataSet.byteArray as Uint8Array;
  const start = pixelDataElement.dataOffset + frame * bytesPerFrame;
  return byteArray.subarray(start, start + bytesPerFrame);
}
