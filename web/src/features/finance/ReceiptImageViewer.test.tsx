import { describe, expect, it } from 'vitest';
import { imagePreviewGeometry } from './receiptImageGeometry';

describe('imagePreviewGeometry', () => {
  it('fits a large landscape image without upscaling it', () => {
    expect(imagePreviewGeometry({ width: 1000, height: 500 }, { width: 600, height: 400 }, 100, 0)).toEqual({
      imageWidth: 568,
      imageHeight: 284,
      frameWidth: 568,
      frameHeight: 284,
    });
  });

  it('swaps oriented bounds after rotation and grows the scroll frame on zoom', () => {
    const rotated = imagePreviewGeometry({ width: 1000, height: 500 }, { width: 600, height: 400 }, 200, 90);
    expect(rotated).toEqual({ imageWidth: 736, imageHeight: 368, frameWidth: 368, frameHeight: 736 });
  });

  it('waits for valid image and viewport measurements', () => {
    expect(imagePreviewGeometry({ width: 0, height: 500 }, { width: 600, height: 400 }, 100, 0)).toBeNull();
    expect(imagePreviewGeometry({ width: 1000, height: 500 }, { width: 0, height: 400 }, 100, 0)).toBeNull();
  });
});
