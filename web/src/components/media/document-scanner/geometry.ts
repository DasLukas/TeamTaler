import type { DocumentCorners, NormalizedPoint } from './types';

/** Default crop with a small inset so every corner handle remains reachable. */
export const DEFAULT_DOCUMENT_CORNERS: DocumentCorners = [
  { x: 0.04, y: 0.04 },
  { x: 0.96, y: 0.04 },
  { x: 0.96, y: 0.96 },
  { x: 0.04, y: 0.96 },
];

/** Three-by-three projective transform stored in row-major order. */
export type PerspectiveTransform = readonly [number, number, number, number, number, number, number, number, number];

/**
 * Constrains an editor point to normalized image coordinates.
 *
 * @param point - Potentially out-of-bounds point.
 * @returns A new point with both coordinates in the inclusive zero-to-one range.
 */
export function constrainPoint(point: NormalizedPoint): NormalizedPoint {
  return {
    x: Math.max(0, Math.min(1, point.x)),
    y: Math.max(0, Math.min(1, point.y)),
  };
}

function cross(a: NormalizedPoint, b: NormalizedPoint, c: NormalizedPoint): number {
  return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
}

function polygonArea(points: DocumentCorners): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum) / 2;
}

/**
 * Validates that crop points form a sufficiently large, convex quadrilateral.
 *
 * @param corners - Clockwise document corners in normalized coordinates.
 * @returns `true` when the quadrilateral is safe to transform.
 */
export function isValidDocumentCorners(corners: DocumentCorners): boolean {
  if (corners.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) {
    return false;
  }
  if (polygonArea(corners) < 0.025) return false;
  const signs = corners.map((point, index) => cross(point, corners[(index + 1) % 4], corners[(index + 2) % 4]));
  return signs.every((value) => value > 0.0001) || signs.every((value) => value < -0.0001);
}

function solveLinearSystem(matrix: number[][], values: number[]): number[] {
  const size = values.length;
  const augmented = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-10) throw new Error('The perspective transform is singular.');
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let index = column; index <= size; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index <= size; index += 1) augmented[row][index] -= factor * augmented[column][index];
    }
  }
  return augmented.map((row) => row[size]);
}

/**
 * Builds a homography that maps four source points onto four destination points.
 *
 * @param source - Source quadrilateral ordered clockwise from top-left.
 * @param destination - Destination quadrilateral in the corresponding order.
 * @returns A row-major projective transform with a normalized final element.
 * @throws {Error} When the input quadrilateral is singular.
 */
export function createPerspectiveTransform(source: DocumentCorners, destination: DocumentCorners): PerspectiveTransform {
  const matrix: number[][] = [];
  const values: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const from = source[index];
    const to = destination[index];
    matrix.push([from.x, from.y, 1, 0, 0, 0, -to.x * from.x, -to.x * from.y]);
    values.push(to.x);
    matrix.push([0, 0, 0, from.x, from.y, 1, -to.y * from.x, -to.y * from.y]);
    values.push(to.y);
  }
  const result = solveLinearSystem(matrix, values);
  return [result[0], result[1], result[2], result[3], result[4], result[5], result[6], result[7], 1];
}

/**
 * Projects a point through a homography.
 *
 * @param transform - Row-major projective transform.
 * @param point - Point in the transform's source coordinate space.
 * @returns The projected point.
 * @throws {Error} When the projection lies at infinity.
 */
export function applyPerspectiveTransform(transform: PerspectiveTransform, point: NormalizedPoint): NormalizedPoint {
  const denominator = transform[6] * point.x + transform[7] * point.y + transform[8];
  if (Math.abs(denominator) < 1e-10) throw new Error('The projected point lies at infinity.');
  return {
    x: (transform[0] * point.x + transform[1] * point.y + transform[2]) / denominator,
    y: (transform[3] * point.x + transform[4] * point.y + transform[5]) / denominator,
  };
}

/**
 * Calculates an output size that preserves the detected document proportions.
 *
 * @param corners - Normalized source quadrilateral.
 * @param sourceWidth - Decoded source width in pixels.
 * @param sourceHeight - Decoded source height in pixels.
 * @param longestEdge - Maximum output edge in pixels.
 * @returns Bounded integer output dimensions.
 */
export function estimateWarpSize(corners: DocumentCorners, sourceWidth: number, sourceHeight: number, longestEdge = 2200): { width: number; height: number } {
  const distance = (a: NormalizedPoint, b: NormalizedPoint) => Math.hypot((a.x - b.x) * sourceWidth, (a.y - b.y) * sourceHeight);
  const width = Math.max(distance(corners[0], corners[1]), distance(corners[3], corners[2]));
  const height = Math.max(distance(corners[0], corners[3]), distance(corners[1], corners[2]));
  const scale = Math.min(1, longestEdge / Math.max(width, height));
  return {
    width: Math.max(32, Math.round(width * scale)),
    height: Math.max(32, Math.round(height * scale)),
  };
}
