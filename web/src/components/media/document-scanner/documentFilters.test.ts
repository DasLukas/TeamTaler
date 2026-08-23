import { describe, expect, it } from 'vitest';
import { applyDocumentFilter, type DocumentPixelSurface } from './documentFilters';

function surface(pixels: readonly number[][], width = pixels.length): DocumentPixelSurface {
  return {
    data: new Uint8ClampedArray(pixels.flat()),
    height: pixels.length / width,
    width,
  };
}

describe('document filters', () => {
  it('leaves original pixels byte-identical', () => {
    const image = surface([[20, 90, 180, 255], [240, 180, 40, 128]]);
    const before = new Uint8ClampedArray(image.data);

    applyDocumentFilter(image, 'original');

    expect(image.data).toEqual(before);
  });

  it('creates true grayscale pixels with normalized contrast and preserved alpha', () => {
    const image = surface([
      [20, 80, 160, 255],
      [80, 160, 220, 200],
      [160, 210, 240, 128],
      [240, 250, 255, 64],
    ], 2);

    applyDocumentFilter(image, 'grayscale');

    for (let offset = 0; offset < image.data.length; offset += 4) {
      expect(image.data[offset]).toBe(image.data[offset + 1]);
      expect(image.data[offset + 1]).toBe(image.data[offset + 2]);
    }
    expect([image.data[3], image.data[7], image.data[11], image.data[15]]).toEqual([255, 200, 128, 64]);
    expect(image.data[0]).toBeLessThan(image.data[12]);
  });

  it('visibly corrects a strong color cast without removing alpha', () => {
    const image = surface([
      [35, 170, 55, 255],
      [70, 220, 95, 255],
      [20, 110, 35, 255],
      [150, 250, 175, 180],
    ], 2);
    const before = new Uint8ClampedArray(image.data);
    const originalGreenDominance = before[1] - before[0];

    applyDocumentFilter(image, 'color');

    expect(image.data).not.toEqual(before);
    expect(image.data[1] - image.data[0]).toBeLessThan(originalGreenDominance);
    expect(image.data[15]).toBe(180);
  });

  it('rejects inconsistent dimensions', () => {
    expect(() => applyDocumentFilter({ data: new Uint8ClampedArray(4), height: 2, width: 2 }, 'color')).toThrow('dimensions');
  });
});
