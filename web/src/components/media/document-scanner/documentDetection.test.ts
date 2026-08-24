import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_CAPTURE_CONFIDENCE,
  assessDocumentCandidate,
  maximumCornerDistance,
  orderDocumentCorners,
  smoothDocumentCorners,
} from './documentDetection';
import type { DocumentCorners } from './types';

const FIRST: DocumentCorners = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.9, y: 0.9 },
  { x: 0.1, y: 0.9 },
];

describe('document detection geometry', () => {
  it('orders shuffled quadrilateral points clockwise from the top-left', () => {
    expect(orderDocumentCorners([FIRST[2], FIRST[0], FIRST[3], FIRST[1]])).toEqual(FIRST);
  });

  it('assigns high confidence to a centered document-like quadrilateral', () => {
    const candidate = assessDocumentCandidate([
      { x: 80, y: 50 },
      { x: 560, y: 60 },
      { x: 550, y: 430 },
      { x: 70, y: 420 },
    ], 640, 480, 177_600);

    expect(candidate?.confidence).toBeGreaterThan(DOCUMENT_CAPTURE_CONFIDENCE);
    expect(candidate?.corners[0]).toEqual({ x: 0.125, y: 50 / 480 });
  });

  it('rejects camera-frame contours and implausible quadrilaterals', () => {
    expect(assessDocumentCandidate([
      { x: 0, y: 0 },
      { x: 640, y: 0 },
      { x: 640, y: 480 },
      { x: 0, y: 480 },
    ], 640, 480, 307_200)).toBeUndefined();
    expect(assessDocumentCandidate([
      { x: 40, y: 40 },
      { x: 600, y: 40 },
      { x: 330, y: 100 },
      { x: 50, y: 440 },
    ], 640, 480, 120_000)).toBeUndefined();
  });

  it('smooths jitter without mutating either measurement', () => {
    const second = FIRST.map((point) => ({ x: point.x + 0.04, y: point.y + 0.02 })) as unknown as DocumentCorners;
    const smoothed = smoothDocumentCorners(FIRST, second, 0.25);

    expect(smoothed[0].x).toBeCloseTo(0.11);
    expect(smoothed[0].y).toBeCloseTo(0.105);
    expect(maximumCornerDistance(FIRST, second)).toBeCloseTo(Math.hypot(0.04, 0.02));
    expect(FIRST[0]).toEqual({ x: 0.1, y: 0.1 });
  });
});
