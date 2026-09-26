import { describe, expect, it } from 'vitest';
import { rotateFrame } from './rotateFrame';

function grayFrame(width: number, height: number, pixels: number[]): ImageData {
  return { width, height, data: new Uint8ClampedArray(pixels.flatMap((value) => [value, value, value, 255])), colorSpace: 'srgb' } as ImageData;
}

describe('bounded diagonal resampling', () => {
  it('preserves edge pixels at zero degrees without mutating the source', () => {
    const source = grayFrame(3, 2, [0, 50, 100, 150, 200, 250]);
    const result = rotateFrame(source, 0);
    expect(result.data).toEqual(source.data);
    expect(result.data).not.toBe(source.data);
  });
  it('pads rectangular frames to include their entire rotated extent', () => {
    const frame = grayFrame(4, 2, Array<number>(8).fill(0));
    const rotated = rotateFrame(frame, 45);
    expect([rotated.width, rotated.height]).toEqual([5, 5]);
    expect(rotated.data.slice(0, 4)).toEqual(new Uint8ClampedArray([255, 255, 255, 255]));
    expect(rotated.data.slice(48, 52)).toEqual(new Uint8ClampedArray([0, 0, 0, 255]));
    expect(frame.data[0]).toBe(0);
  });
});
