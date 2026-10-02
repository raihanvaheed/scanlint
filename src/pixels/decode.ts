import { parseDicom } from "dicom-parser";
import type { DataSet, Element } from "dicom-parser";
import { decodeJpegFragment } from "./jpeg";
import { NoPixelDataError, UnsupportedFormatError, UnsupportedSyntaxError } from "./errors";
import { extractEncapsulatedFragment, extractFrameBytes } from "./pixel-data";
import transferSyntaxRegistry from "./transfer-syntaxes.json";

// `window` is the centre/width actually applied - the caller's override, the file's own declared
// values, or the computed fallback - so 3.4's preview can show it without re-deriving it. Absent
// for colour images, which are not windowed at all, and for JPEG, which 3.6 established carries no
// rescale or window either (an 8-bit lossy modality has already mapped the data). `transferSyntaxUid`
// is the raw UID; turning it into words ("uncompressed", "RLE compressed") is presentation, and
// lives in the UI layer. `frame` and `numberOfFrames` (3.8) are the zero-based frame actually decoded
// and the file's own declared total - always present, `numberOfFrames` is 1 for a file that declares
// none, so the caller never has to special-case "absent" versus "one".
export type DecodedImage = { width: number; height: number; rgba: Uint8ClampedArray; window?: WindowSetting; transferSyntaxUid: string; frame: number; numberOfFrames: number };
export type WindowSetting = { center: number; width: number };

export const NO_PIXEL_DATA_MESSAGE = "No pixel data (7FE0,0010) in this file";

// The policy, not just data: every transfer syntax decodeImage actually handles, and how. Visible
// here, as a literal, so that adding a fifth one is a change someone has to mean - see 3.6's own
// write-up on why this stays hand-maintained rather than derived from transfer-syntaxes.json, which
// lists every transfer syntax the *standard* defines, supported or not.
const SUPPORTED_TRANSFER_SYNTAXES: Record<string, "native" | "rle" | "jpeg"> = {
  "1.2.840.10008.1.2": "native",
  "1.2.840.10008.1.2.1": "native",
  "1.2.840.10008.1.2.5": "rle",
  "1.2.840.10008.1.2.4.50": "jpeg",
};

function transferSyntaxName(uid: string): string {
  const entry = (transferSyntaxRegistry.transferSyntaxes as Record<string, { name: string }>)[uid];
  return entry?.name ?? "an unrecognised transfer syntax";
}

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
  throw new Error(`BitsAllocated ${bytesPerSample * 8} is neither 8 nor 16`);
}

function passthroughRgb(frameBytes: Uint8Array, rows: number, columns: number, transferSyntaxUid: string, frame: number, numberOfFrames: number): DecodedImage {
  const pixelCount = rows * columns;
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    rgba[i * 4] = frameBytes[i * 3];
    rgba[i * 4 + 1] = frameBytes[i * 3 + 1];
    rgba[i * 4 + 2] = frameBytes[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  return { width: columns, height: rows, rgba, transferSyntaxUid, frame, numberOfFrames };
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
  transferSyntaxUid: string,
  frame: number,
  numberOfFrames: number,
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

  return { width: columns, height: rows, rgba, window: { center, width }, transferSyntaxUid, frame, numberOfFrames };
}

const JPEG_PHOTOMETRIC_FORMS = new Set(["MONOCHROME1", "MONOCHROME2", "YBR_FULL", "YBR_FULL_422", "RGB"]);

// The browser's own JPEG decoder has already turned the compressed bytes into RGBA - MONOCHROME2,
// YBR_FULL, YBR_FULL_422 and RGB all pass straight through unmodified, since re-deriving a colour
// transform the decoder already applied is the classic double-conversion bug. The only photometric
// adjustment left for this module to make is the same one it already makes for uncompressed data:
// MONOCHROME1 inverts R, G and B (never alpha) after decode. The JPEG's own component count is not
// checked against SamplesPerPixel - a mismatch is invisible at this level and not this preview's
// question to answer.
//
// 3.6a: fragment resolution runs before the SamplesPerPixel/PhotometricInterpretation check, and
// Rows/Columns are read here rather than passed in, so that "frame boundaries indeterminable" (a
// stated ScanLint limitation) is checked before the plain failures below it, wherever the two are
// independently reachable - see decodeImage's own ordering comment.
async function decodeJpegImage(
  dataSet: DataSet,
  pixelDataElement: Element,
  frame: number,
  numberOfFrames: number,
  samplesPerPixel: number,
  photometricInterpretation: string,
  transferSyntaxUid: string,
): Promise<DecodedImage> {
  const fragment = extractEncapsulatedFragment(dataSet, pixelDataElement, frame, numberOfFrames);

  const formIsValid = (samplesPerPixel === 1 || samplesPerPixel === 3) && JPEG_PHOTOMETRIC_FORMS.has(photometricInterpretation);
  if (!formIsValid) {
    throw new Error(`SamplesPerPixel (${samplesPerPixel}) with PhotometricInterpretation (${photometricInterpretation || "none"}) is not a combination ScanLint decodes`);
  }

  const rows = requireUint16(dataSet, TAG.rows, "Rows");
  const columns = requireUint16(dataSet, TAG.columns, "Columns");
  const rgba = await decodeJpegFragment(fragment, { width: columns, height: rows });

  if (photometricInterpretation === "MONOCHROME1") {
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = 255 - rgba[i];
      rgba[i + 1] = 255 - rgba[i + 1];
      rgba[i + 2] = 255 - rgba[i + 2];
    }
  }

  // No rescale, no window: 3.6's own decision, same reasoning as uncompressed RGB in 3.2 - this is
  // 8-bit lossy data a modality has already mapped, and a `window` passed in by the caller is
  // ignored by never being read here.
  return { width: columns, height: rows, rgba, transferSyntaxUid, frame, numberOfFrames };
}

/**
 * Decodes one frame of a DICOM file's pixel data into displayable RGBA. Re-parses `bytes` with
 * dicom-parser directly — independent of the metadata worker's parse, and deliberately not allowed
 * to import the dictionary or rules (see src/invariants.test.ts): this is the image path, not the
 * PHI path, and the two must not need each other's tables.
 *
 * VOILUTSequence, if present, is ignored in favour of the linear window computed here — a known
 * limitation, not an oversight.
 *
 * Async since 3.6: JPEG decoding goes through `createImageBitmap`, a promise. Dispatch is on the
 * transfer syntax alone (3.6), not on whether the pixel data element happens to be encapsulated -
 * branching on the element shape is what let a JPEG fragment get misread as RLE before this step.
 *
 * 3.6a: the order of the checks below is deliberate and pinned down here, after getting it wrong
 * twice in two consecutive steps (3.4 checked Rows before pixel data; 3.6 originally checked
 * no-pixel-data before the transfer syntax) - both bugs were caught, neither by a test that existed
 * before it, because nothing previously said what the order was *supposed* to be. Each step here is
 * placed as early as its own data dependencies allow, and a `reason`-carrying outcome is checked
 * before a plain one wherever the two are independently reachable - a reader should never be told
 * "this file is broken" when "ScanLint doesn't support this" was equally true and more useful:
 *
 *  1. Unsupported transfer syntax (`unsupported-syntax`) - without a readable pixel representation
 *     nothing below can be evaluated at all.
 *  2. No PixelData element (`no-pixel-data`) - before any check that reads the element itself.
 *  3. Transfer syntax disagrees with the element's length encoding (plain) - needs the element to
 *     exist, so cannot precede 2, but otherwise as early as possible: nothing past this point can
 *     trust which encoding the file actually uses.
 *  4. Declared-attribute refusals (`unsupported-format`): PALETTE COLOR; a frame index out of range
 *     (plain, but checked here regardless - a frame that does not exist is a precondition failure
 *     for resolving its fragments in 5, the same reasoning as 3 needing the element to exist); then,
 *     once native vs. JPEG is known, YBR_* on uncompressed data and PlanarConfiguration 1. All of
 *     these read only already-parsed, declared values - nothing here touches a fragment.
 *  5. Frame boundaries indeterminable (`unsupported-format`, inside `extractEncapsulatedFragment`,
 *     reached from the JPEG and RLE paths) - checked before 6 wherever independently reachable. For
 *     JPEG this is exact: `decodeJpegImage` resolves the fragment before reading Rows/Columns or
 *     checking the SamplesPerPixel/PhotometricInterpretation combination. For RLE it is not: reading
 *     Rows/Columns/BitsAllocated has to happen first regardless, because `extractFrameBytes` needs
 *     them as arguments to do the native-byte-slicing math even to begin resolving fragments -
 *     splitting that further was a larger change than this step makes.
 *  6. Everything else: BitsAllocated, Rows/Columns, a dimension mismatch, a truncated RLE segment,
 *     an unsupported SamplesPerPixel/PhotometricInterpretation combination. Genuine defects, so last.
 */
export async function decodeImage(bytes: Uint8Array, options: { frame?: number; window?: WindowSetting } = {}): Promise<DecodedImage> {
  const frame = options.frame ?? 0;
  const dataSet = parseDicom(bytes);

  const transferSyntaxUid = dataSet.string(TAG.transferSyntax) ?? "";

  // 1. Unsupported transfer syntax.
  const kind = SUPPORTED_TRANSFER_SYNTAXES[transferSyntaxUid];
  if (!kind) {
    const name = transferSyntaxName(transferSyntaxUid);
    throw new UnsupportedSyntaxError(`This image is stored as ${name} (${transferSyntaxUid}). ScanLint shows uncompressed, RLE and JPEG baseline images.`, transferSyntaxUid);
  }

  // 2. No PixelData element.
  const pixelDataElement = dataSet.elements[TAG.pixelData];
  if (!pixelDataElement) throw new NoPixelDataError(NO_PIXEL_DATA_MESSAGE);

  // 3. Transfer syntax vs. element encoding mismatch.
  const elementIsEncapsulated = Boolean(pixelDataElement.encapsulatedPixelData);
  const syntaxIsEncapsulated = kind !== "native";
  if (syntaxIsEncapsulated !== elementIsEncapsulated) {
    throw new Error(
      `Transfer syntax ${transferSyntaxUid} (${transferSyntaxName(transferSyntaxUid)}) is ${syntaxIsEncapsulated ? "encapsulated" : "native"}, but the pixel data element has ` +
        `${elementIsEncapsulated ? "an undefined length" : "a defined length"} - this file is inconsistent about how its own pixel data is stored.`,
    );
  }

  // 4. Declared-attribute refusals, and the frame-range precondition for 5.
  const samplesPerPixel = dataSet.uint16(TAG.samplesPerPixel) ?? 1;
  const planarConfiguration = dataSet.uint16(TAG.planarConfiguration) ?? 0;
  const photometricInterpretation = dataSet.string(TAG.photometricInterpretation) ?? "";
  const numberOfFrames = dataSet.intString(TAG.numberOfFrames) ?? 1;

  if (photometricInterpretation === "PALETTE COLOR") {
    throw new UnsupportedFormatError("This image is stored as PALETTE COLOR, which ScanLint does not render. ScanLint renders greyscale and interleaved RGB images.");
  }
  if (frame < 0 || frame >= numberOfFrames) {
    throw new Error(`Frame ${frame} is out of range: this file has ${numberOfFrames} frame(s)`);
  }

  if (kind === "jpeg") {
    return decodeJpegImage(dataSet, pixelDataElement, frame, numberOfFrames, samplesPerPixel, photometricInterpretation, transferSyntaxUid);
  }

  if (photometricInterpretation.startsWith("YBR")) {
    throw new UnsupportedFormatError(`This image is stored as ${photometricInterpretation}, which ScanLint does not render. ScanLint renders greyscale and interleaved RGB images.`);
  }
  if (samplesPerPixel === 3 && photometricInterpretation === "RGB" && planarConfiguration !== 0) {
    throw new UnsupportedFormatError("This image is stored with PlanarConfiguration 1 (colour-plane order), which ScanLint does not render. ScanLint renders greyscale and interleaved RGB images.");
  }

  // 5 (RLE only, not independently orderable before 6 here - see the function comment) / 6.
  const rows = requireUint16(dataSet, TAG.rows, "Rows");
  const columns = requireUint16(dataSet, TAG.columns, "Columns");
  const bitsAllocated = requireUint16(dataSet, TAG.bitsAllocated, "BitsAllocated");
  const bitsStored = requireUint16(dataSet, TAG.bitsStored, "BitsStored");
  const highBit = requireUint16(dataSet, TAG.highBit, "HighBit");
  const pixelRepresentation = dataSet.uint16(TAG.pixelRepresentation) ?? 0;

  if (bitsAllocated !== 8 && bitsAllocated !== 16) {
    throw new Error(`BitsAllocated ${bitsAllocated} is neither 8 nor 16`);
  }

  const bytesPerSample = bitsAllocated / 8;
  const pixelCount = rows * columns;

  if (samplesPerPixel === 3 && photometricInterpretation === "RGB") {
    const frameBytes = extractFrameBytes(dataSet, pixelDataElement, frame, pixelCount, samplesPerPixel, bytesPerSample, numberOfFrames);
    return passthroughRgb(frameBytes, rows, columns, transferSyntaxUid, frame, numberOfFrames);
  }

  if (samplesPerPixel !== 1 || (photometricInterpretation !== "MONOCHROME1" && photometricInterpretation !== "MONOCHROME2")) {
    throw new Error(`SamplesPerPixel (${samplesPerPixel}) with PhotometricInterpretation (${photometricInterpretation || "none"}) is not a combination ScanLint decodes`);
  }

  const rescaleSlope = dataSet.floatString(TAG.rescaleSlope, 0) ?? 1;
  const rescaleIntercept = dataSet.floatString(TAG.rescaleIntercept, 0) ?? 0;
  const declaredCenter = dataSet.floatString(TAG.windowCenter, 0);
  const declaredWidth = dataSet.floatString(TAG.windowWidth, 0);
  const window = options.window ?? (declaredCenter !== undefined && declaredWidth !== undefined ? { center: declaredCenter, width: declaredWidth } : undefined);

  const frameBytes = extractFrameBytes(dataSet, pixelDataElement, frame, pixelCount, samplesPerPixel, bytesPerSample, numberOfFrames);
  return decodeGrayscale(frameBytes, rows, columns, bytesPerSample, bitsStored, highBit, pixelRepresentation, rescaleSlope, rescaleIntercept, photometricInterpretation, window, transferSyntaxUid, frame, numberOfFrames);
}
