import { describe, expect, it } from 'vitest';
import {
  applyPerspectiveTransform,
  createPerspectiveTransform,
  DEFAULT_DOCUMENT_CORNERS,
  estimateWarpSize,
  isValidDocumentCorners,
} from './geometry';
import type { DocumentCorners } from './types';

describe('document scanner geometry', () => {
  it('maps all four points through a perspective transform', () => {
    const destination: DocumentCorners = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 3 },
      { x: 0, y: 3 },
    ];
    const transform = createPerspectiveTransform(DEFAULT_DOCUMENT_CORNERS, destination);

    DEFAULT_DOCUMENT_CORNERS.forEach((point, index) => {
      const projected = applyPerspectiveTransform(transform, point);
      expect(projected.x).toBeCloseTo(destination[index].x, 8);
      expect(projected.y).toBeCloseTo(destination[index].y, 8);
    });
  });

  it('rejects crossed, tiny, and out-of-bounds crops', () => {
    expect(isValidDocumentCorners(DEFAULT_DOCUMENT_CORNERS)).toBe(true);
    expect(isValidDocumentCorners([
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.9 },
      { x: 0.9, y: 0.1 },
      { x: 0.1, y: 0.9 },
    ])).toBe(false);
    expect(isValidDocumentCorners([
      { x: -0.1, y: 0 },
      { x: 0.1, y: 0 },
      { x: 0.1, y: 0.1 },
      { x: 0, y: 0.1 },
    ])).toBe(false);
  });

  it('bounds the processed image while retaining its proportions', () => {
    expect(estimateWarpSize(DEFAULT_DOCUMENT_CORNERS, 4000, 2000, 2000)).toEqual({ width: 2000, height: 1000 });
  });
});
