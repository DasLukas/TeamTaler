import { describe, expect, it } from 'vitest';
import { calculateImagePlacement } from './imageUpload';

describe('calculateImagePlacement', () => {
  it('covers a square frame and exposes only valid movement on a wide image', () => {
    const placement = calculateImagePlacement(1600, 800, { x: 1, y: -1, zoom: 1 });

    expect(placement).toEqual({
      width: 2,
      height: 1,
      centerX: 1,
      centerY: 0.5,
      maxOffsetX: 0.5,
      maxOffsetY: 0,
    });
  });

  it('adds gap-free movement on both axes after zooming', () => {
    const placement = calculateImagePlacement(800, 1600, { x: -1, y: 0.5, zoom: 2 });

    expect(placement.width).toBe(2);
    expect(placement.height).toBe(4);
    expect(placement.centerX).toBe(0);
    expect(placement.centerY).toBe(1.25);
  });

  it('clamps position and zoom to the supported editor range', () => {
    const placement = calculateImagePlacement(100, 100, { x: 4, y: -4, zoom: 6 });

    expect(placement.width).toBe(3);
    expect(placement.centerX).toBe(1.5);
    expect(placement.centerY).toBe(-0.5);
  });

  it('rejects invalid source dimensions', () => {
    expect(() => calculateImagePlacement(0, 100, { x: 0, y: 0, zoom: 1 })).toThrow('Image dimensions must be positive.');
  });
});
