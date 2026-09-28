import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { crossProduct, normalize, orientationsAgree, projectOntoNormal, sliceNormal } from "./geometry";
import type { Orientation, Vector3 } from "./geometry";

describe("geometry.ts imports nothing", () => {
  it("has no import statements at all", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "geometry.ts"), "utf8");
    expect(source.split("\n").filter((line) => /^\s*import\b/.test(line))).toEqual([]);
  });
});

describe("crossProduct", () => {
  // Hand-computed, not derived from the function under test.
  it("axial: (1,0,0) x (0,1,0) = (0,0,1)", () => {
    expect(crossProduct([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
  });

  it("sagittal: (0,1,0) x (0,0,-1) = (-1,0,0)", () => {
    expect(crossProduct([0, 1, 0], [0, 0, -1])).toEqual([-1, 0, 0]);
  });

  it("coronal: (1,0,0) x (0,0,-1) = (0,1,0)", () => {
    // The x component is 0*-1 - 0*0: IEEE 754 makes that -0, not +0. Mathematically the same
    // value; toEqual distinguishes the sign of zero, so the literal says exactly what it is.
    expect(crossProduct([1, 0, 0], [0, 0, -1])).toEqual([-0, 1, 0]);
  });

  it("a hand-worked non-axis-aligned case: (2,1,0) x (0,3,1) = (1,-2,6)", () => {
    // i(1*1 - 0*3) - j(2*1 - 0*0) + k(2*3 - 1*0) = (1, -2, 6)
    expect(crossProduct([2, 1, 0], [0, 3, 1])).toEqual([1, -2, 6]);
  });
});

describe("normalize", () => {
  it("a non-unit input produces a unit vector, worked out by hand: (3,4,0) -> (0.6,0.8,0)", () => {
    expect(normalize([3, 4, 0])).toEqual([0.6, 0.8, 0]);
  });

  it("(0,0,5) -> (0,0,1)", () => {
    expect(normalize([0, 0, 5])).toEqual([0, 0, 1]);
  });

  it("a vector already of unit length is unchanged", () => {
    expect(normalize([1, 0, 0])).toEqual([1, 0, 0]);
  });

  it("(1,2,2) has length 3, so normalizes to (1/3, 2/3, 2/3)", () => {
    const [x, y, z] = normalize([1, 2, 2]);
    expect(x).toBeCloseTo(1 / 3, 12);
    expect(y).toBeCloseTo(2 / 3, 12);
    expect(z).toBeCloseTo(2 / 3, 12);
  });
});

describe("sliceNormal", () => {
  it("axial orientation gives the unit +z normal", () => {
    expect(sliceNormal([1, 0, 0, 0, 1, 0])).toEqual([0, 0, 1]);
  });

  it("sagittal orientation gives the unit -x normal", () => {
    expect(sliceNormal([0, 1, 0, 0, 0, -1])).toEqual([-1, 0, 0]);
  });

  it("coronal orientation gives the unit +y normal", () => {
    expect(sliceNormal([1, 0, 0, 0, 0, -1])).toEqual([-0, 1, 0]); // see the crossProduct test above
  });

  it("a non-unit row/column pair still yields a unit normal", () => {
    // row (2,0,0), column (0,3,0): cross product is (0,0,6), normalized to (0,0,1).
    const normal = sliceNormal([2, 0, 0, 0, 3, 0]);
    expect(normal).toEqual([0, 0, 1]);
  });
});

describe("projectOntoNormal", () => {
  it("a known point onto a known normal gives the hand-worked scalar", () => {
    // (3,4,5) . (0,0,1) = 5
    expect(projectOntoNormal([3, 4, 5], [0, 0, 1])).toBe(5);
  });

  it("worked with a non-axis-aligned unit normal: (1,2,3) . (0.6,0.8,0) = 0.6 + 1.6 = 2.2", () => {
    expect(projectOntoNormal([1, 2, 3], [0.6, 0.8, 0])).toBeCloseTo(2.2, 12);
  });

  it("scaling every position by the same normal preserves order: two points 3 apart along z project 3 apart", () => {
    const normal: Vector3 = [0, 0, 1];
    const a = projectOntoNormal([-100, -100, 0], normal);
    const b = projectOntoNormal([-100, -100, 3], normal);
    expect(b - a).toBe(3);
  });
});

describe("orientationsAgree", () => {
  const axial: Orientation = [1, 0, 0, 0, 1, 0];

  it("identical orientations agree", () => {
    expect(orientationsAgree(axial, axial)).toBe(true);
  });

  it("differing by 5e-5 in one component still agrees (within the 1e-4 tolerance)", () => {
    const nudged: Orientation = [1 + 5e-5, 0, 0, 0, 1, 0];
    expect(orientationsAgree(axial, nudged)).toBe(true);
  });

  it("differing by exactly 1e-4 agrees (the boundary is inclusive)", () => {
    const nudged: Orientation = [1 + 1e-4, 0, 0, 0, 1, 0];
    expect(orientationsAgree(axial, nudged)).toBe(true);
  });

  it("differing by 5e-3 in one component does not agree", () => {
    const different: Orientation = [1 + 5e-3, 0, 0, 0, 1, 0];
    expect(orientationsAgree(axial, different)).toBe(false);
  });

  it("checks every one of the six components, not just the first to differ", () => {
    const differsOnlyInLastComponent: Orientation = [1, 0, 0, 0, 0, -1]; // coronal, not axial
    expect(orientationsAgree(axial, differsOnlyInLastComponent)).toBe(false);
  });

  it("a difference just over tolerance in the sixth component alone is caught", () => {
    const nudgedLast: Orientation = [1, 0, 0, 0, 1, 5e-3];
    expect(orientationsAgree(axial, nudgedLast)).toBe(false);
  });
});
