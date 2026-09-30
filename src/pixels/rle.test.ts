import { describe, expect, it } from "vitest";
import { decodeRleFrame } from "./rle";

// A minimal Annex G frame: numSegments, then 15 offsets (derived from each segment's own length,
// as a real encoder's would be), then the segment data itself starting at byte 64.
function buildFrame(segmentBytes: number[][]): Uint8Array {
  const segments = segmentBytes.map((bytes) => Uint8Array.from(bytes));
  const header = new Uint8Array(64);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, segments.length, true);
  let offset = 64;
  segments.forEach((segment, i) => {
    headerView.setUint32(4 + i * 4, offset, true);
    offset += segment.length;
  });
  const total = new Uint8Array(64 + segments.reduce((n, s) => n + s.length, 0));
  total.set(header, 0);
  let pos = 64;
  for (const segment of segments) {
    total.set(segment, pos);
    pos += segment.length;
  }
  return total;
}

describe("decodeRleFrame", () => {
  it("handles PackBits's -128 no-op, which pydicom's own encoder never emits", () => {
    // control 128 (-128 signed): no-op, consumes nothing. control 3: 4 literal bytes follow.
    const frame = buildFrame([[128, 3, 10, 20, 30, 40]]);
    expect(decodeRleFrame(frame, 4, 1, 1)).toEqual(Uint8Array.from([10, 20, 30, 40]));
  });

  it("a literal run and a replicated run in the same segment", () => {
    // control 1: 2 literal bytes (10, 20). control 254 (-2 signed): next byte (3) repeats 3 times.
    const frame = buildFrame([[1, 10, 20, 254, 3, 3, 3]]);
    expect(decodeRleFrame(frame, 5, 1, 1)).toEqual(Uint8Array.from([10, 20, 3, 3, 3]));
  });

  it("reassembles a 16-bit sample from its two segments, most-significant byte first", () => {
    // Two pixels, BitsAllocated 16: segment 0 is the MSB of each pixel, segment 1 the LSB.
    const frame = buildFrame([[1, 0x01, 0x02], [1, 0x03, 0x04]]);
    const bytes = decodeRleFrame(frame, 2, 1, 2);
    // Little-endian storage wants the LSB first: pixel 0 = 0x0203, pixel 1 = 0x0204.
    expect(Array.from(bytes)).toEqual([0x03, 0x01, 0x04, 0x02]);
  });

  it("throws when the segment count does not match SamplesPerPixel x BitsAllocated/8", () => {
    const frame = buildFrame([[0, 1]]);
    expect(() => decodeRleFrame(frame, 1, 1, 2)).toThrow(/segment/);
  });

  it("throws when a segment ends before producing the expected number of pixels", () => {
    const frame = buildFrame([[1, 10]]); // claims 2 literal bytes, supplies 1
    expect(() => decodeRleFrame(frame, 2, 1, 1)).toThrow(/ended before/);
  });
});
