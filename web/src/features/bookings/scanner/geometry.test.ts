import { describe, expect, it } from 'vitest';
import { getScanCrop } from './geometry';

describe('visible camera region mapping', () => {
  it('excludes the source pixels hidden by portrait object-fit cover', () => {
    expect(getScanCrop({ width: 640, height: 480 }, { x: 0, y: 76, width: 390, height: 768 }, { x: 35, y: 300, width: 320, height: 320 }))
      .toEqual({ x: 220, y: 140, width: 200, height: 200 });
  });
  it('maps a landscape cover crop with vertical clipping', () => {
    expect(getScanCrop({ width: 480, height: 640 }, { x: 50, y: 20, width: 960, height: 400 }, { x: 330, y: 60, width: 320, height: 320 }))
      .toEqual({ x: 140, y: 240, width: 160, height: 160 });
  });
  it('intersects partially clipped regions and rounds inward', () => {
    expect(getScanCrop({ width: 640, height: 480 }, { x: 0, y: 0, width: 640, height: 480 }, { x: -10.2, y: 20.1, width: 200, height: 100 }))
      .toEqual({ x: 0, y: 21, width: 189, height: 99 });
  });
  it('never falls back to the full frame for missing or invalid geometry', () => {
    const video = { x: 0, y: 0, width: 640, height: 480 };
    for (const region of [{ ...video, width: 0 }, { ...video, x: 700 }, { ...video, y: NaN }]) {
      expect(getScanCrop(video, video, region)).toBeNull();
    }
    expect(getScanCrop({ width: 0, height: 0 }, video, video)).toBeNull();
  });
});
