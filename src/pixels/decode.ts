import { parseDicom } from "dicom-parser";
import type { DataSet } from "dicom-parser";
import { extractFrameBytes } from "./pixel-data";

export type DecodedImage = { width: number; height: number; rgba: Uint8ClampedArray };
export type WindowSetting = { center: number; width: number };

const BIG_ENDIAN_EXPLICIT_UID = "1.2.840.10008.1.2.2";
const RLE_LOSSLESS_UID = "1.2.840.10008.1.2.5";

// Tag keys are spelled out here, in dicom-parser's own xGGGGEEEE form, rather than looked up by
// name — this module must not reach the dictionary (see src/invariants.test.ts).
const TAG = {
  transferSyntax: "x00020010",
  rows: "x00280010",
  columns: "x00280011",
  samplesPerPixel: "x00280002",
  photometricInterpretation: "x00280004",
  planarConfiguration: "x00280006",
  numberOfFrames: "x00280008",
  bitsAllocated: "x00280100",
  bitsStored: "x00280101",
  highBit: "x00280102",
  pixelRepresentation: "x00280103",
  rescaleIntercept: "x00281052",
  rescaleSlope: "x00281053",
  windowCenter: "x00281050",
  windowWidth: "x00281051",
  pixelData: "x7fe00010",
} as const;

function requireUint16(dataSet: DataSet, tag: string, name: string): number {
  const value = dataSet.uint16(tag);
  if (value === undefined) throw new Error(`Missing required attribute ${name}`);
  return value;
}

function readWord(bytes: Uint8Array, byteOffset: number, bytesPerSample: number): number {
  if (bytesPerSample === 1) return bytes[byteOffset];
  if (bytesPerSample === 2) return bytes[byteOffset] | (bytes[byteOffset + 1] << 8);
  throw new Error(`Unsupported BitsAllocated: ${bytesPerSample * 8}`);
}

function passthroughRgb(frameBytes: Uint8Array, rows: number, columns: number): DecodedImage {
  const pixelCount = rows * columns;
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    rgba[i * 4] = frameBytes[i * 3];
    rgba[i * 4 + 1] = frameBytes[i * 3 + 1];
    rgba[i * 4 + 2] = frameBytes[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  return { width: columns, height: rows, rgba };
}

function decodeGrayscale(
  frameBytes: Uint8Array,
  rows: number,
  columns: number,
  bytesPerSample: number,
  bitsStored: number,
  highBit: number,
  pixelRepresentation: number,
  rescaleSlope: number,
  rescaleIntercept: number,
  photometricInterpretation: string,
  window: WindowSetting | undefined,
): DecodedImage {
  const pixelCount = rows * columns;
  const shift = highBit + 1 - bitsStored;
  const mask = (1 << bitsStored) - 1;
  const signBit = 1 << (bitsStored - 1);
  const signExtension = 1 << bitsStored;

  // Rescaled values, computed once: needed for every pixel's grey level, and again (as min/max) if
  // no window was declared.
  const rescaled = new Float64Array(pixelCount);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pixelCount; i++) {
    const word = readWord(frameBytes, i * bytesPerSample, bytesPerSample);
    let raw = (word >> shift) & mask;
    if (pixelRepresentation === 1 && (raw & signBit) !== 0) raw -= signExtension;
    const value = raw * rescaleSlope + rescaleIntercept;
    rescaled[i] = value;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  let center: number;
  let width: number;
  if (window) {
    ({ center, width } = window);
  } else {
    center = (min + max) / 2;
    width = max - min || 1;
  }

  // PS3.3 C.11.2.1.2, the default LINEAR VOI LUT function, written exactly as specified: the -0.5
  // and (width - 1) terms are load-bearing, not simplifiable.
  const lowThreshold = center - 0.5 - (width - 1) / 2;
  const highThreshold = center - 0.5 + (width - 1) / 2;
  const invert = photometricInterpretation === "MONOCHROME1";

  const rgba = new Uint8ClampedArray(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    const x = rescaled[i];
    let y: number;
    if (x <= lowThreshold) y = 0;
    else if (x > highThreshold) y = 255;
    else y = Math.round(((x - (center - 0.5)) / (width - 1) + 0.5) * 255);
    if (invert) y = 255 - y;

    const o = i * 4;
    rgba[o] = y;
    rgba[o + 1] = y;
    rgba[o + 2] = y;
    rgba[o + 3] = 255;
  }

  return { width: columns, height: rows, rgba };
}

/**
 * Decodes one frame of a DICOM file's pixel data into displayable RGBA. Re-parses `bytes` with
 * dicom-parser directly — independent of the metadata worker's parse, and deliberately not allowed
 * to import the dictionary or rules (see src/invariants.test.ts): this is the image path, not the
 * PHI path, and the two must not need each other's tables.
 *
 * VOILUTSequence, if present, is ignored in favour of the linear window computed here — a known
 * limitation, not an oversight.
 */
export function decodeImage(bytes: Uint8Array, options: { frame?: number; window?: WindowSetting } = {}): DecodedImage {
  const frame = options.frame ?? 0;
  const dataSet = parseDicom(bytes);

  const transferSyntaxUid = dataSet.string(TAG.transferSyntax);
  if (transferSyntaxUid === BIG_ENDIAN_EXPLICIT_UID) {
    throw new Error("Explicit VR Big Endian (1.2.840.10008.1.2.2) is not supported: it is retired and rare, and byte-swapped rendering would be worse than refusing");
  }

  const rows = requireUint16(dataSet, TAG.rows, "Rows");
  const columns = requireUint16(dataSet, TAG.columns, "Columns");
  const bitsAllocated = requireUint16(dataSet, TAG.bitsAllocated, "BitsAllocated");
  const bitsStored = requireUint16(dataSet, TAG.bitsStored, "BitsStored");
  const highBit = requireUint16(dataSet, TAG.highBit, "HighBit");
  const pixelRepresentation = dataSet.uint16(TAG.pixelRepresentation) ?? 0;
  const samplesPerPixel = dataSet.uint16(TAG.samplesPerPixel) ?? 1;
  const planarConfiguration = dataSet.uint16(TAG.planarConfiguration) ?? 0;
  const photometricInterpretation = dataSet.string(TAG.photometricInterpretation) ?? "";
  const numberOfFrames = dataSet.intString(TAG.numberOfFrames) ?? 1;

  if (bitsAllocated !== 8 && bitsAllocated !== 16) {
    throw new Error(`Unsupported BitsAllocated: ${bitsAllocated}`);
  }
  if (frame < 0 || frame >= numberOfFrames) {
    throw new Error(`Frame ${frame} is out of range: this file has ${numberOfFrames} frame(s)`);
  }

  const pixelDataElement = dataSet.elements[TAG.pixelData];
  if (!pixelDataElement) throw new Error("No pixel data (7FE0,0010) in this file");
  if (transferSyntaxUid === RLE_LOSSLESS_UID && !pixelDataElement.encapsulatedPixelData) {
    throw new Error("RLE Lossless transfer syntax but pixel data is not encapsulated");
  }

  const bytesPerSample = bitsAllocated / 8;
  const pixelCount = rows * columns;

  if (photometricInterpretation === "PALETTE COLOR") {
    throw new Error("PALETTE COLOR is not supported");
  }
  if (photometricInterpretation.startsWith("YBR")) {
    throw new Error(`${photometricInterpretation} is not supported`);
  }

  if (samplesPerPixel === 3 && photometricInterpretation === "RGB") {
    if (planarConfiguration !== 0) {
      throw new Error("PlanarConfiguration 1 (colour-plane order) is not supported");
    }
    const frameBytes = extractFrameBytes(dataSet, pixelDataElement, frame, pixelCount, samplesPerPixel, bytesPerSample);
    return passthroughRgb(frameBytes, rows, columns);
  }

  if (samplesPerPixel !== 1 || (photometricInterpretation !== "MONOCHROME1" && photometricInterpretation !== "MONOCHROME2")) {
    throw new Error(`Unsupported combination of SamplesPerPixel (${samplesPerPixel}) and PhotometricInterpretation (${photometricInterpretation || "none"})`);
  }

  const rescaleSlope = dataSet.floatString(TAG.rescaleSlope, 0) ?? 1;
  const rescaleIntercept = dataSet.floatString(TAG.rescaleIntercept, 0) ?? 0;
  const declaredCenter = dataSet.floatString(TAG.windowCenter, 0);
  const declaredWidth = dataSet.floatString(TAG.windowWidth, 0);
  const window = options.window ?? (declaredCenter !== undefined && declaredWidth !== undefined ? { center: declaredCenter, width: declaredWidth } : undefined);

  const frameBytes = extractFrameBytes(dataSet, pixelDataElement, frame, pixelCount, samplesPerPixel, bytesPerSample);
  return decodeGrayscale(frameBytes, rows, columns, bytesPerSample, bitsStored, highBit, pixelRepresentation, rescaleSlope, rescaleIntercept, photometricInterpretation, window);
}
