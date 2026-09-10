import { describe, expect, it } from 'vitest';
import { DOCUMENT_CAPTURE_CONFIDENCE, DOCUMENT_DISPLAY_CONFIDENCE } from './documentDetection';
import { detectDocumentPortable } from './portableDocumentDetection';
import type { DetectionFrame, DocumentCorners, NormalizedPoint } from './types';

function crossProduct(first: NormalizedPoint, second: NormalizedPoint, point: NormalizedPoint): number {
  return (second.x - first.x) * (point.y - first.y) - (second.y - first.y) * (point.x - first.x);
}

function insideConvexPolygon(point: NormalizedPoint, corners: DocumentCorners): boolean {
  const signs = corners.map((corner, index) => crossProduct(corner, corners[(index + 1) % 4], point));
  return signs.every((value) => value >= 0) || signs.every((value) => value <= 0);
}

function syntheticFrame(width: number, height: number, corners?: DocumentCorners): DetectionFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const inside = corners && insideConvexPolygon({ x, y }, corners);
      const texture = ((x * 17 + y * 29) % 11) - 5;
      const value = (inside ? 226 : 47) + texture;
      data[offset] = value;
      data[offset + 1] = inside ? value - 5 : value + 3;
      data[offset + 2] = inside ? value - 12 : value + 7;
      data[offset + 3] = 255;
    }
  }
  return { data, height, width };
}

function expectCornersClose(actual: DocumentCorners | undefined, expected: DocumentCorners, tolerance: number): void {
  expect(actual).toBeDefined();
  actual?.forEach((point, index) => {
    expect(point.x).toBeCloseTo(expected[index].x / 480, tolerance);
    expect(point.y).toBeCloseTo(expected[index].y / 360, tolerance);
  });
}

describe('portable document detection', () => {
  it('finds a centered rectangular page with automatic-capture confidence', () => {
    const corners: DocumentCorners = [
      { x: 78, y: 42 },
      { x: 405, y: 42 },
      { x: 405, y: 320 },
      { x: 78, y: 320 },
    ];

    const candidate = detectDocumentPortable(syntheticFrame(480, 360, corners));

    expect(candidate?.confidence).toBeGreaterThan(DOCUMENT_CAPTURE_CONFIDENCE);
    expectCornersClose(candidate?.corners, corners, 1);
  });

  it('finds a perspective page against a lightly textured background', () => {
    const corners: DocumentCorners = [
      { x: 105, y: 48 },
      { x: 404, y: 72 },
      { x: 430, y: 310 },
      { x: 70, y: 328 },
    ];

    const candidate = detectDocumentPortable(syntheticFrame(480, 360, corners));

    expect(candidate?.confidence).toBeGreaterThan(DOCUMENT_DISPLAY_CONFIDENCE);
    expectCornersClose(candidate?.corners, corners, 1);
  });

  it('does not invent a document in a uniform frame', () => {
    const data = new Uint8ClampedArray(320 * 240 * 4).fill(80);
    for (let offset = 3; offset < data.length; offset += 4) data[offset] = 255;

    expect(detectDocumentPortable({ data, height: 240, width: 320 })).toBeUndefined();
  });

  it('rejects malformed frame buffers without throwing', () => {
    expect(detectDocumentPortable({
      data: new Uint8ClampedArray(12),
      height: 360,
      width: 480,
    })).toBeUndefined();
  });
});
