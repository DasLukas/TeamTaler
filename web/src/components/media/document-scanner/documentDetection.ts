import { isValidDocumentCorners } from './geometry';
import type { DocumentCorners, NormalizedPoint } from './types';

/** Minimum detector confidence required before a contour is shown or used by manual capture. */
export const DOCUMENT_DISPLAY_CONFIDENCE = 0.62;

/** Minimum detector confidence required for automatic capture. */
export const DOCUMENT_CAPTURE_CONFIDENCE = 0.76;

/** Maximum normalized corner movement accepted as one stable camera frame. */
export const DOCUMENT_STABLE_DISTANCE = 0.018;

/** Minimum normalized movement required before a captured document can re-arm automatic capture. */
export const DOCUMENT_REARM_DISTANCE = 0.065;

/** Maximum age of a validated contour accepted by a manual capture. */
export const DOCUMENT_DETECTION_MAX_AGE_MS = 1_200;

/** A geometrically assessed quadrilateral returned by the OpenCV detector. */
export interface DocumentCandidate {
  /** Corners normalized to the camera frame. */
  corners: DocumentCorners;
  /** Geometry-derived confidence from zero to one. */
  confidence: number;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function distance(first: NormalizedPoint, second: NormalizedPoint): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function angleDegrees(previous: NormalizedPoint, center: NormalizedPoint, next: NormalizedPoint): number {
  const first = { x: previous.x - center.x, y: previous.y - center.y };
  const second = { x: next.x - center.x, y: next.y - center.y };
  const denominator = Math.hypot(first.x, first.y) * Math.hypot(second.x, second.y);
  if (denominator <= 1e-6) return 0;
  return Math.acos(clamp((first.x * second.x + first.y * second.y) / denominator, -1, 1)) * 180 / Math.PI;
}

/**
 * Orders four arbitrary points clockwise from the top-left corner.
 *
 * @param points - Four points in a common coordinate system.
 * @returns The same four points ordered top-left, top-right, bottom-right, bottom-left.
 * @throws {Error} When exactly four finite points are not supplied.
 *
 * @example
 * orderDocumentCorners([{ x: 10, y: 10 }, { x: 90, y: 90 }, { x: 90, y: 10 }, { x: 10, y: 90 }]);
 */
export function orderDocumentCorners(points: readonly NormalizedPoint[]): DocumentCorners {
  if (points.length !== 4 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    throw new Error('Document detection requires exactly four finite points.');
  }
  const center = points.reduce((result, point) => ({ x: result.x + point.x / 4, y: result.y + point.y / 4 }), { x: 0, y: 0 });
  const clockwise = [...points].sort((first, second) => (
    Math.atan2(first.y - center.y, first.x - center.x) - Math.atan2(second.y - center.y, second.x - center.x)
  ));
  const topLeftIndex = clockwise.reduce((best, point, index) => (
    point.x + point.y < clockwise[best].x + clockwise[best].y ? index : best
  ), 0);
  return Array.from({ length: 4 }, (_, offset) => clockwise[(topLeftIndex + offset) % 4]) as unknown as DocumentCorners;
}

/**
 * Scores an OpenCV quadrilateral by document-like geometry instead of area alone.
 *
 * Candidates touching multiple frame edges, implausibly small or large shapes,
 * non-document angles, and heavily unbalanced opposite edges are rejected or
 * penalized. This prevents the camera frame and furniture edges from outranking
 * the actual page simply because they cover more pixels.
 *
 * @param points - Four candidate corners in source-frame pixels.
 * @param frameWidth - Source-frame width in pixels.
 * @param frameHeight - Source-frame height in pixels.
 * @param contourArea - OpenCV contour area in pixels.
 * @returns A normalized candidate and confidence, or `undefined` for invalid geometry.
 *
 * @example
 * assessDocumentCandidate([{ x: 80, y: 50 }, { x: 560, y: 60 }, { x: 550, y: 430 }, { x: 70, y: 420 }], 640, 480, 177600);
 */
export function assessDocumentCandidate(
  points: readonly NormalizedPoint[],
  frameWidth: number,
  frameHeight: number,
  contourArea: number,
): DocumentCandidate | undefined {
  if (frameWidth <= 0 || frameHeight <= 0 || !Number.isFinite(contourArea)) return undefined;
  let pixelCorners: DocumentCorners;
  try {
    pixelCorners = orderDocumentCorners(points);
  } catch {
    return undefined;
  }
  const corners = pixelCorners.map((point) => ({ x: point.x / frameWidth, y: point.y / frameHeight })) as unknown as DocumentCorners;
  if (!isValidDocumentCorners(corners)) return undefined;

  const areaRatio = Math.abs(contourArea) / (frameWidth * frameHeight);
  if (areaRatio < 0.1 || areaRatio > 0.94) return undefined;
  const frameDiagonal = Math.hypot(frameWidth, frameHeight);
  const pixelDistance = (first: NormalizedPoint, second: NormalizedPoint) => Math.hypot(first.x - second.x, first.y - second.y);
  const sideLengths = pixelCorners.map((point, index) => pixelDistance(point, pixelCorners[(index + 1) % 4]));
  if (Math.min(...sideLengths) < frameDiagonal * 0.07) return undefined;

  const angles = pixelCorners.map((point, index) => angleDegrees(pixelCorners[(index + 3) % 4], point, pixelCorners[(index + 1) % 4]));
  if (angles.some((angle) => angle < 30 || angle > 150)) return undefined;
  const borderHits = corners.filter((point) => point.x < 0.018 || point.x > 0.982 || point.y < 0.018 || point.y > 0.982).length;
  if (borderHits >= 2 && areaRatio > 0.8) return undefined;

  const angleScore = 1 - angles.reduce((total, angle) => total + Math.abs(angle - 90) / 60, 0) / 4;
  const oppositeScore = (
    Math.min(sideLengths[0], sideLengths[2]) / Math.max(sideLengths[0], sideLengths[2])
    + Math.min(sideLengths[1], sideLengths[3]) / Math.max(sideLengths[1], sideLengths[3])
  ) / 2;
  const center = corners.reduce((result, point) => ({ x: result.x + point.x / 4, y: result.y + point.y / 4 }), { x: 0, y: 0 });
  const centerScore = 1 - clamp(Math.hypot(center.x - 0.5, center.y - 0.5) / 0.65);
  const minimumMargin = Math.min(...corners.flatMap((point) => [point.x, 1 - point.x, point.y, 1 - point.y]));
  const borderScore = borderHits === 0 ? clamp(minimumMargin / 0.045) : 0.15;
  const areaScore = areaRatio < 0.22
    ? 0.45 + (areaRatio - 0.1) / 0.12 * 0.55
    : areaRatio <= 0.72
      ? 1
      : 1 - (areaRatio - 0.72) / 0.22 * 0.55;
  const confidence = clamp(
    areaScore * 0.28
    + clamp(angleScore) * 0.3
    + oppositeScore * 0.16
    + centerScore * 0.14
    + borderScore * 0.12,
  );
  return { confidence, corners };
}

/**
 * Blends two ordered contours to reduce visible camera jitter.
 *
 * @param previous - Previously displayed corners.
 * @param current - Newly detected corners.
 * @param currentWeight - Weight assigned to the new measurement.
 * @returns Smoothed ordered corners.
 */
export function smoothDocumentCorners(previous: DocumentCorners, current: DocumentCorners, currentWeight = 0.38): DocumentCorners {
  const weight = clamp(currentWeight);
  return previous.map((point, index) => ({
    x: point.x * (1 - weight) + current[index].x * weight,
    y: point.y * (1 - weight) + current[index].y * weight,
  })) as unknown as DocumentCorners;
}

/**
 * Returns the greatest normalized displacement between corresponding corners.
 *
 * @param first - First ordered contour.
 * @param second - Second ordered contour.
 * @returns Maximum Euclidean corner distance in normalized coordinates.
 */
export function maximumCornerDistance(first: DocumentCorners, second: DocumentCorners): number {
  return Math.max(...first.map((point, index) => distance(point, second[index])));
}
