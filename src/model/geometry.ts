// The vector maths behind spatial slice ordering. Imports nothing, and is imported by nothing
// that needs a tag, a node, or a file: this is pure arithmetic, kept separate so a subtle sign or
// axis error is caught here, by a hand-computed test, rather than inside a larger function.

/** x, y, z. */
export type Vector3 = readonly [number, number, number];

/** The six direction cosines DICOM stores for ImageOrientationPatient: the row axis, then the
 * column axis. */
export type Orientation = readonly [number, number, number, number, number, number];

const AGREEMENT_TOLERANCE = 1e-4;

export function crossProduct(r: Vector3, c: Vector3): Vector3 {
  return [r[1] * c[2] - r[2] * c[1], r[2] * c[0] - r[0] * c[2], r[0] * c[1] - r[1] * c[0]];
}

export function normalize(v: Vector3): Vector3 {
  const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** The unit normal to the slice plane: the row direction crossed with the column direction. */
export function sliceNormal(orientation: Orientation): Vector3 {
  const row: Vector3 = [orientation[0], orientation[1], orientation[2]];
  const column: Vector3 = [orientation[3], orientation[4], orientation[5]];
  return normalize(crossProduct(row, column));
}

/** How far a point sits along a (unit) normal. The value ordering depends on: the sort key. */
export function projectOntoNormal(position: Vector3, normal: Vector3): number {
  return position[0] * normal[0] + position[1] * normal[1] + position[2] * normal[2];
}

/** Whether two orientations describe the same plane closely enough to share one normal: every
 * one of the six components must differ by no more than 1e-4, the rounding a decimal-string
 * DICOM value can pick up, but far less than two genuinely different planes ever differ by. */
export function orientationsAgree(a: Orientation, b: Orientation): boolean {
  for (let i = 0; i < 6; i++) {
    if (Math.abs(a[i] - b[i]) > AGREEMENT_TOLERANCE) return false;
  }
  return true;
}
