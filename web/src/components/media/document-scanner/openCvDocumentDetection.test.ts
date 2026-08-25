import { loadOpenCV } from '@opencvjs/web';
import { beforeAll, describe, expect, it } from 'vitest';
import { DOCUMENT_CAPTURE_CONFIDENCE } from './documentDetection';
import { detectDocumentWithOpenCv, type OpenCvRuntime } from './openCvDocumentDetection';

function frame(width: number, height: number, document?: { bottom: number; left: number; right: number; top: number }): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const inside = document && x >= document.left && x <= document.right && y >= document.top && y <= document.bottom;
      const value = inside ? 232 : 38;
      data[offset] = value;
      data[offset + 1] = inside ? 228 : value;
      data[offset + 2] = inside ? 218 : value;
      data[offset + 3] = 255;
    }
  }
  return { colorSpace: 'srgb', data, height, width } as ImageData;
}

describe('OpenCV document detection', () => {
  let runtime: OpenCvRuntime;

  beforeAll(async () => {
    runtime = await loadOpenCV();
  });

  it('finds a centered high-contrast page through the production WASM pipeline', () => {
    const candidate = detectDocumentWithOpenCv(frame(640, 480, { bottom: 410, left: 100, right: 540, top: 70 }), runtime);

    expect(candidate?.confidence).toBeGreaterThan(DOCUMENT_CAPTURE_CONFIDENCE);
    expect(candidate?.corners[0].x).toBeCloseTo(100 / 640, 1);
    expect(candidate?.corners[0].y).toBeCloseTo(70 / 480, 1);
    expect(candidate?.corners[2].x).toBeCloseTo(540 / 640, 1);
    expect(candidate?.corners[2].y).toBeCloseTo(410 / 480, 1);
  });

  it('returns no contour for a uniform frame', () => {
    expect(detectDocumentWithOpenCv(frame(320, 240), runtime)).toBeUndefined();
  });
});
