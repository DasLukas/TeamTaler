import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DOCUMENT_CORNERS } from './geometry';
import { renderDocumentFilterPreview, renderDocumentPage } from './imageProcessing';
import type { ScannerPage } from './types';

function scannerPage(filter: ScannerPage['filter']): ScannerPage {
  return {
    corners: DEFAULT_DOCUMENT_CORNERS,
    file: new File(['image'], 'page.png', { type: 'image/png' }),
    filter,
    id: 'page',
    previewUrl: 'blob:page',
    rotation: 0,
    sourceHeight: 140,
    sourceWidth: 100,
  };
}

describe('document image processing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the same explicit grayscale pixels for editor preview and PDF rendering', async () => {
    const processed: Uint8ClampedArray[] = [];
    const context = {
      beginPath: vi.fn(),
      clip: vi.fn(),
      closePath: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray([
          10, 80, 180, 255,
          80, 150, 220, 255,
          160, 210, 240, 255,
          240, 250, 255, 255,
        ]),
        height: 2,
        width: 2,
      })),
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      putImageData: vi.fn((image: ImageData) => { processed.push(new Uint8ClampedArray(image.data)); }),
      restore: vi.fn(),
      rotate: vi.fn(),
      save: vi.fn(),
      setTransform: vi.fn(),
      translate: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(new Blob(['jpeg'], { type: 'image/jpeg' })));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn(), height: 140, width: 100 }) as unknown as ImageBitmap));

    await renderDocumentFilterPreview(scannerPage('grayscale'));
    await renderDocumentPage(scannerPage('grayscale'));

    expect(processed).toHaveLength(2);
    expect(processed[0]).toEqual(processed[1]);
    for (const pixels of processed) {
      for (let offset = 0; offset < pixels.length; offset += 4) {
        expect(pixels[offset]).toBe(pixels[offset + 1]);
        expect(pixels[offset + 1]).toBe(pixels[offset + 2]);
      }
    }
  });

  it('does not read or rewrite pixels in original mode', async () => {
    const getImageData = vi.fn();
    const putImageData = vi.fn();
    const context = {
      drawImage: vi.fn(),
      getImageData,
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      putImageData,
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(new Blob(['jpeg'], { type: 'image/jpeg' })));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn(), height: 140, width: 100 }) as unknown as ImageBitmap));

    await renderDocumentFilterPreview(scannerPage('original'));

    expect(getImageData).not.toHaveBeenCalled();
    expect(putImageData).not.toHaveBeenCalled();
  });
});
