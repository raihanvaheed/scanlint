import { readEncapsulatedPixelData } from "dicom-parser";
import type { DataSet, Element } from "dicom-parser";
import { decodeRleFrame } from "./rle";

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
): Uint8Array {
  if (pixelDataElement.encapsulatedPixelData) {
    const compressed = readEncapsulatedPixelData(dataSet, pixelDataElement, frame);
    return decodeRleFrame(compressed, pixelsPerFrame, samplesPerPixel, bytesPerSample);
  }

  const bytesPerFrame = pixelsPerFrame * samplesPerPixel * bytesPerSample;
  const byteArray = dataSet.byteArray as Uint8Array;
  const start = pixelDataElement.dataOffset + frame * bytesPerFrame;
  return byteArray.subarray(start, start + bytesPerFrame);
}
