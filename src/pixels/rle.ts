// PS3.5 Annex G: DICOM's own byte-oriented run-length scheme, distinct from the RLE Lossless
// *transfer syntax framing* (fragments, basic offset table) that dicom-parser already understands.
// dicom-parser hands back the still-packed bytes for a frame; unpacking them is ours to do, since
// dicom-parser is a parser, not a codec, and no codec dependency was approved for this step.

// A 64-byte header: an item count, then up to 15 segment start offsets, all uint32 little endian.
const HEADER_LENGTH = 64;
const MAX_SEGMENTS = 15;

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

// One segment is a PackBits-style stream: a control byte, signed, then its payload.
// 0..127: the next (n+1) bytes are literal. -1..-127 (129..255 unsigned): the next byte repeats
// (257-n) times. -128 (128 unsigned) is a no-op some encoders emit as padding.
function unpackSegment(segment: Uint8Array, expectedLength: number): Uint8Array {
  const out = new Uint8Array(expectedLength);
  let outPos = 0;
  let inPos = 0;

  // Centralises the bounds check so a literal run or a replicated value that runs past the
  // segment's own end throws, the same as running out of room for a control byte - a truncated
  // segment silently zero-filling the rest of the image is worse than refusing it.
  function nextByte(): number {
    if (inPos >= segment.length) {
      throw new Error("RLE segment ended before producing the expected number of pixels");
    }
    return segment[inPos++];
  }

  while (outPos < expectedLength) {
    const control = nextByte();

    if (control <= 127) {
      const count = control + 1;
      for (let i = 0; i < count && outPos < expectedLength; i++) out[outPos++] = nextByte();
    } else if (control === 128) {
      // no-op
    } else {
      const count = 257 - control;
      const value = nextByte();
      for (let i = 0; i < count && outPos < expectedLength; i++) out[outPos++] = value;
    }
  }

  return out;
}

/**
 * Unpacks one RLE-compressed frame (the bytes for a single fragment/frame, already assembled by
 * dicom-parser) into raw little-endian pixel bytes, as if BitsAllocated bytes per sample had never
 * been compressed. Annex G stores each sample's bytes most-significant-first, one segment per byte
 * per sample — the opposite order from little-endian storage — so this also does that reordering.
 */
export function decodeRleFrame(frame: Uint8Array, pixelCount: number, samplesPerPixel: number, bytesPerSample: number): Uint8Array {
  const numSegments = readUint32LE(frame, 0);
  const expectedSegments = samplesPerPixel * bytesPerSample;
  if (numSegments !== expectedSegments) {
    throw new Error(`RLE frame declares ${numSegments} segment(s), expected ${expectedSegments} for ${samplesPerPixel} sample(s) at ${bytesPerSample} byte(s) each`);
  }
  if (numSegments > MAX_SEGMENTS) {
    throw new Error(`RLE frame declares ${numSegments} segments, more than Annex G's maximum of ${MAX_SEGMENTS}`);
  }

  const offsets: number[] = [];
  for (let i = 0; i < numSegments; i++) offsets.push(readUint32LE(frame, 4 + i * 4));

  // Each offset is already measured from the start of the header, not from the end of it - so the
  // first segment always starts exactly at HEADER_LENGTH.
  if (offsets[0] !== HEADER_LENGTH) {
    throw new Error(`RLE frame's first segment offset is ${offsets[0]}, expected ${HEADER_LENGTH}`);
  }

  const segments: Uint8Array[] = offsets.map((start, i) => {
    const end = i + 1 < numSegments ? offsets[i + 1] : frame.length;
    return unpackSegment(frame.subarray(start, end), pixelCount);
  });

  const bytesPerPixel = numSegments;
  const out = new Uint8Array(pixelCount * bytesPerPixel);
  for (let sample = 0; sample < samplesPerPixel; sample++) {
    for (let byteInSample = 0; byteInSample < bytesPerSample; byteInSample++) {
      const segment = segments[sample * bytesPerSample + byteInSample];
      // byteInSample 0 is the most significant byte; little-endian storage wants it last.
      const littleEndianIndex = bytesPerSample - 1 - byteInSample;
      const destBase = sample * bytesPerSample + littleEndianIndex;
      for (let p = 0; p < pixelCount; p++) out[p * bytesPerPixel + destBase] = segment[p];
    }
  }

  return out;
}
