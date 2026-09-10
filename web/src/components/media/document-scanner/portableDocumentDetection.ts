import { assessDocumentCandidate, type DocumentCandidate } from './documentDetection';
import type { DetectionFrame, DocumentCorners, NormalizedPoint } from './types';

const MAX_WORKING_EDGE = 360;
const MAX_EDGE_POINTS = 12_000;
const HOUGH_ANGLE_BINS = 180;
const HOUGH_ANGLE_RADIUS = 2;
const MAX_HOUGH_LINES = 28;
const MAX_LINE_PAIRS = 18;
const MIN_DOCUMENT_AREA_RATIO = 0.16;

interface EdgePoint {
  magnitude: number;
  theta: number;
  x: number;
  y: number;
}

interface EdgeSurface {
  edgeMap: Uint8Array;
  height: number;
  points: EdgePoint[];
  width: number;
}

interface HoughLine {
  cosine: number;
  rho: number;
  score: number;
  sine: number;
}

interface LinePair {
  first: HoughLine;
  score: number;
  second: HoughLine;
}

const ANGLE_COSINES = Float64Array.from(
  { length: HOUGH_ANGLE_BINS },
  (_, index) => Math.cos(index * Math.PI / HOUGH_ANGLE_BINS),
);
const ANGLE_SINES = Float64Array.from(
  { length: HOUGH_ANGLE_BINS },
  (_, index) => Math.sin(index * Math.PI / HOUGH_ANGLE_BINS),
);

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizedAngleBin(angle: number): number {
  const degrees = Math.round(angle * HOUGH_ANGLE_BINS / Math.PI);
  return ((degrees % HOUGH_ANGLE_BINS) + HOUGH_ANGLE_BINS) % HOUGH_ANGLE_BINS;
}

/** Creates a small, luminance-only working surface without browser APIs. */
function createLuminanceSurface(frame: DetectionFrame): { data: Uint8Array; height: number; width: number } | undefined {
  const { data, height: sourceHeight, width: sourceWidth } = frame;
  if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight) || sourceWidth < 8 || sourceHeight < 8) return undefined;
  if (data.length !== sourceWidth * sourceHeight * 4) return undefined;

  const scale = Math.min(1, MAX_WORKING_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(8, Math.round(sourceWidth * scale));
  const height = Math.max(8, Math.round(sourceHeight * scale));
  const luminance = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor((y + 0.5) * sourceHeight / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor((x + 0.5) * sourceWidth / width));
      const sourceOffset = (sourceY * sourceWidth + sourceX) * 4;
      luminance[y * width + x] = (
        data[sourceOffset] * 77
        + data[sourceOffset + 1] * 150
        + data[sourceOffset + 2] * 29
      ) >> 8;
    }
  }
  return { data: luminance, height, width };
}

/** Applies a separable 1-2-1 blur to suppress sensor noise before edge extraction. */
function blurLuminance(source: Uint8Array, width: number, height: number): Uint8Array {
  const horizontal = new Uint16Array(source.length);
  const blurred = new Uint8Array(source.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    horizontal[row] = source[row] * 4;
    horizontal[row + width - 1] = source[row + width - 1] * 4;
    for (let x = 1; x < width - 1; x += 1) {
      horizontal[row + x] = source[row + x - 1] + source[row + x] * 2 + source[row + x + 1];
    }
  }
  for (let x = 0; x < width; x += 1) {
    blurred[x] = source[x];
    blurred[(height - 1) * width + x] = source[(height - 1) * width + x];
    for (let y = 1; y < height - 1; y += 1) {
      const offset = y * width + x;
      blurred[offset] = (
        horizontal[offset - width]
        + horizontal[offset] * 2
        + horizontal[offset + width]
      ) >> 4;
    }
  }
  return blurred;
}

/** Chooses a bounded adaptive gradient threshold from the current camera frame. */
function gradientThreshold(histogram: Uint32Array, pixelCount: number): number {
  const percentile = Math.max(0.88, 1 - MAX_EDGE_POINTS / Math.max(1, pixelCount));
  const target = Math.floor(pixelCount * percentile);
  let seen = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value];
    if (seen >= target) return Math.max(24, value);
  }
  return 255;
}

/** Extracts non-maximal Sobel edges and their normal directions. */
function createEdgeSurface(frame: DetectionFrame): EdgeSurface | undefined {
  const surface = createLuminanceSurface(frame);
  if (!surface) return undefined;
  const { height, width } = surface;
  const luminance = blurLuminance(surface.data, width, height);
  const length = width * height;
  const gradientX = new Int16Array(length);
  const gradientY = new Int16Array(length);
  const magnitudes = new Uint8Array(length);
  const histogram = new Uint32Array(256);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const offset = y * width + x;
      const topLeft = luminance[offset - width - 1];
      const top = luminance[offset - width];
      const topRight = luminance[offset - width + 1];
      const left = luminance[offset - 1];
      const right = luminance[offset + 1];
      const bottomLeft = luminance[offset + width - 1];
      const bottom = luminance[offset + width];
      const bottomRight = luminance[offset + width + 1];
      const horizontal = topRight + right * 2 + bottomRight - topLeft - left * 2 - bottomLeft;
      const vertical = bottomLeft + bottom * 2 + bottomRight - topLeft - top * 2 - topRight;
      const magnitude = Math.min(255, (Math.abs(horizontal) + Math.abs(vertical)) >> 2);
      gradientX[offset] = horizontal;
      gradientY[offset] = vertical;
      magnitudes[offset] = magnitude;
      histogram[magnitude] += 1;
    }
  }

  const threshold = gradientThreshold(histogram, Math.max(1, (width - 2) * (height - 2)));
  const edgeMap = new Uint8Array(length);
  const points: EdgePoint[] = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const offset = y * width + x;
      const magnitude = magnitudes[offset];
      if (magnitude < threshold) continue;
      const horizontal = gradientX[offset];
      const vertical = gradientY[offset];
      const absoluteHorizontal = Math.abs(horizontal);
      const absoluteVertical = Math.abs(vertical);
      let before: number;
      let after: number;
      if (absoluteHorizontal > absoluteVertical * 2) {
        before = magnitudes[offset - 1];
        after = magnitudes[offset + 1];
      } else if (absoluteVertical > absoluteHorizontal * 2) {
        before = magnitudes[offset - width];
        after = magnitudes[offset + width];
      } else if (horizontal * vertical >= 0) {
        before = magnitudes[offset - width - 1];
        after = magnitudes[offset + width + 1];
      } else {
        before = magnitudes[offset - width + 1];
        after = magnitudes[offset + width - 1];
      }
      if (magnitude < before || magnitude < after) continue;
      edgeMap[offset] = 1;
      points.push({ magnitude, theta: Math.atan2(vertical, horizontal), x, y });
    }
  }
  if (points.length <= MAX_EDGE_POINTS) return { edgeMap, height, points, width };
  const boundedPoints = Array.from(
    { length: MAX_EDGE_POINTS },
    (_, index) => points[Math.floor(index * points.length / MAX_EDGE_POINTS)],
  );
  return { edgeMap, height, points: boundedPoints, width };
}

function alignedLineDistance(first: HoughLine, second: HoughLine): number {
  const direction = first.cosine * second.cosine + first.sine * second.sine;
  return Math.abs(first.rho - (direction >= 0 ? second.rho : -second.rho));
}

function lineAngleDifference(first: HoughLine, second: HoughLine): number {
  const cosine = Math.abs(first.cosine * second.cosine + first.sine * second.sine);
  return Math.acos(clamp(cosine, -1, 1)) * 180 / Math.PI;
}

/** Finds the strongest distinct straight edges with gradient-guided Hough voting. */
function findHoughLines(surface: EdgeSurface): HoughLine[] {
  if (surface.points.length < 16) return [];
  const rhoOffset = Math.ceil(Math.hypot(surface.width, surface.height));
  const rhoBins = rhoOffset * 2 + 1;
  const accumulator = new Uint32Array(HOUGH_ANGLE_BINS * rhoBins);
  let maximumScore = 0;
  for (const point of surface.points) {
    const centerBin = normalizedAngleBin(point.theta);
    const weight = 1 + (point.magnitude >> 5);
    for (let delta = -HOUGH_ANGLE_RADIUS; delta <= HOUGH_ANGLE_RADIUS; delta += 1) {
      const theta = (centerBin + delta + HOUGH_ANGLE_BINS) % HOUGH_ANGLE_BINS;
      const rho = Math.round(point.x * ANGLE_COSINES[theta] + point.y * ANGLE_SINES[theta]) + rhoOffset;
      if (rho < 0 || rho >= rhoBins) continue;
      const index = theta * rhoBins + rho;
      const score = accumulator[index] + weight;
      accumulator[index] = score;
      maximumScore = Math.max(maximumScore, score);
    }
  }
  const minimumScore = Math.max(Math.min(surface.width, surface.height) * 0.22, maximumScore * 0.14);
  if (maximumScore < minimumScore || maximumScore === 0) return [];

  const candidates: HoughLine[] = [];
  for (let theta = 0; theta < HOUGH_ANGLE_BINS; theta += 1) {
    for (let rho = 0; rho < rhoBins; rho += 1) {
      const score = accumulator[theta * rhoBins + rho];
      if (score >= minimumScore) {
        candidates.push({
          cosine: ANGLE_COSINES[theta],
          rho: rho - rhoOffset,
          score,
          sine: ANGLE_SINES[theta],
        });
      }
    }
  }
  candidates.sort((first, second) => second.score - first.score);

  const distinct: HoughLine[] = [];
  for (const candidate of candidates) {
    const duplicate = distinct.some((line) => (
      lineAngleDifference(line, candidate) <= 4 && alignedLineDistance(line, candidate) <= 7
    ));
    if (!duplicate) distinct.push(candidate);
    if (distinct.length >= MAX_HOUGH_LINES) break;
  }
  return distinct;
}

/** Creates plausible pairs of approximately parallel document sides. */
function createLinePairs(lines: readonly HoughLine[], surface: EdgeSurface): LinePair[] {
  const pairs: LinePair[] = [];
  const minimumSeparation = Math.min(surface.width, surface.height) * 0.13;
  const maximumSeparation = Math.hypot(surface.width, surface.height) * 0.96;
  for (let firstIndex = 0; firstIndex < lines.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < lines.length; secondIndex += 1) {
      const first = lines[firstIndex];
      const second = lines[secondIndex];
      if (lineAngleDifference(first, second) > 24) continue;
      const separation = alignedLineDistance(first, second);
      if (separation < minimumSeparation || separation > maximumSeparation) continue;
      pairs.push({ first, score: Math.min(first.score, second.score), second });
    }
  }
  return pairs.sort((first, second) => second.score - first.score).slice(0, MAX_LINE_PAIRS);
}

function lineIntersection(first: HoughLine, second: HoughLine): NormalizedPoint | undefined {
  const determinant = first.cosine * second.sine - second.cosine * first.sine;
  if (Math.abs(determinant) < 0.08) return undefined;
  return {
    x: (first.rho * second.sine - second.rho * first.sine) / determinant,
    y: (first.cosine * second.rho - second.cosine * first.rho) / determinant,
  };
}

function polygonArea(points: readonly NormalizedPoint[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += current.x * next.y - current.y * next.x;
  }
  return Math.abs(twiceArea) / 2;
}

function sideEdgeSupport(first: NormalizedPoint, second: NormalizedPoint, surface: EdgeSurface): number {
  const length = Math.hypot(second.x - first.x, second.y - first.y);
  const samples = clamp(Math.ceil(length), 12, 180);
  let supported = 0;
  for (let sample = 0; sample <= samples; sample += 1) {
    const progress = sample / samples;
    const centerX = Math.round(first.x + (second.x - first.x) * progress);
    const centerY = Math.round(first.y + (second.y - first.y) * progress);
    let found = false;
    for (let deltaY = -2; deltaY <= 2 && !found; deltaY += 1) {
      const y = centerY + deltaY;
      if (y < 0 || y >= surface.height) continue;
      for (let deltaX = -2; deltaX <= 2; deltaX += 1) {
        const x = centerX + deltaX;
        if (x >= 0 && x < surface.width && surface.edgeMap[y * surface.width + x] !== 0) {
          found = true;
          break;
        }
      }
    }
    if (found) supported += 1;
  }
  return supported / (samples + 1);
}

/** Scores a four-line intersection against both geometry and visible edge support. */
function assessLineCombination(first: LinePair, second: LinePair, surface: EdgeSurface): DocumentCandidate | undefined {
  if (lineAngleDifference(first.first, second.first) < 48) return undefined;
  const intersections = [
    lineIntersection(first.first, second.first),
    lineIntersection(first.first, second.second),
    lineIntersection(first.second, second.second),
    lineIntersection(first.second, second.first),
  ];
  if (intersections.some((point) => !point)) return undefined;
  const points = intersections as NormalizedPoint[];
  const area = polygonArea(points);
  if (area / (surface.width * surface.height) < MIN_DOCUMENT_AREA_RATIO) return undefined;
  const geometric = assessDocumentCandidate(points, surface.width, surface.height, area);
  if (!geometric) return undefined;

  const pixelCorners = geometric.corners.map((point) => ({
    x: point.x * surface.width,
    y: point.y * surface.height,
  })) as unknown as DocumentCorners;
  const sideSupport = pixelCorners.map((point, index) => (
    sideEdgeSupport(point, pixelCorners[(index + 1) % 4], surface)
  ));
  const weakestSupport = Math.min(...sideSupport);
  const averageSupport = sideSupport.reduce((total, value) => total + value, 0) / sideSupport.length;
  if (weakestSupport < 0.18 || averageSupport < 0.42) return undefined;

  const supportFactor = 0.72 + Math.min(0.16, averageSupport * 0.2) + Math.min(0.12, weakestSupport * 0.16);
  return {
    confidence: clamp(geometric.confidence * supportFactor, 0, 1),
    corners: geometric.corners,
  };
}

/**
 * Detects a document-shaped quadrilateral with a CSP-safe pixel pipeline.
 *
 * The implementation uses only typed arrays and deterministic JavaScript. It
 * performs adaptive Sobel edge extraction, gradient-guided Hough voting, and
 * confidence-gated quadrilateral scoring, so it runs inside module workers on
 * Safari without WebAssembly, dynamic code generation, canvas, or DOM access.
 *
 * @param frame - Bounded RGBA camera frame.
 * @returns The highest-confidence document candidate, or `undefined` when no safe contour exists.
 *
 * @example
 * const candidate = detectDocumentPortable(cameraFrame);
 */
export function detectDocumentPortable(frame: DetectionFrame): DocumentCandidate | undefined {
  const surface = createEdgeSurface(frame);
  if (!surface) return undefined;
  const lines = findHoughLines(surface);
  const pairs = createLinePairs(lines, surface);
  let best: DocumentCandidate | undefined;
  for (let firstIndex = 0; firstIndex < pairs.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < pairs.length; secondIndex += 1) {
      const candidate = assessLineCombination(pairs[firstIndex], pairs[secondIndex], surface);
      if (candidate && (!best || candidate.confidence > best.confidence)) best = candidate;
    }
  }
  return best;
}
