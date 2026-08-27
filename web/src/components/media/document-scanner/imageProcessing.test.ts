import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderDocumentFilterPreview, renderDocumentPage } from './imageProcessing';
import type { DocumentCorners, ScannerPage } from './types';

const FULL_DOCUMENT_CORNERS: DocumentCorners = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

function scannerPage(filter: ScannerPage['filter']): ScannerPage {
  return {
    corners: FULL_DOCUMENT_CORNERS,
    file: new File(['image'], 'page.png', { type: 'image/png' }),
    filter,
    id: 'page',
    previewUrl: 'blob:page',
    rotation: 0,
    sourceHeight: 32,
    sourceWidth: 32,
  };
}

function sourcePixels(): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(32 * 32 * 4);
  for (let pixel = 0; pixel < 32 * 32; pixel += 1) {
    const offset = pixel * 4;
    pixels[offset] = (pixel * 17) % 256;
    pixels[offset + 1] = (pixel * 29) % 256;
    pixels[offset + 2] = (pixel * 43) % 256;
    pixels[offset + 3] = 255;
  }
  return pixels;
}

function mockCanvasPipeline() {
  const initialPixels = sourcePixels();
  const storedImages = new WeakMap<HTMLCanvasElement, ImageData>();
  const writtenImages: ImageData[] = [];
  const contexts: Array<{ clip: ReturnType<typeof vi.fn>; setTransform: ReturnType<typeof vi.fn> }> = [];
  const getImageData = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext(this: HTMLCanvasElement) {
    const clip = vi.fn();
    const setTransform = vi.fn();
    contexts.push({ clip, setTransform });
    return {
      clip,
      createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4), height, width }) as ImageData,
      drawImage: vi.fn(() => {
        storedImages.set(this, { data: new Uint8ClampedArray(initialPixels), height: this.height, width: this.width } as ImageData);
      }),
      getImageData: getImageData.mockImplementation(() => storedImages.get(this)),
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      putImageData: vi.fn((image: ImageData) => {
        const copy = { data: new Uint8ClampedArray(image.data), height: image.height, width: image.width } as ImageData;
        storedImages.set(this, copy);
        writtenImages.push(copy);
      }),
      rotate: vi.fn(),
      setTransform,
      translate: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(new Blob(['jpeg'], { type: 'image/jpeg' })));
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn(), height: 32, width: 32 }) as unknown as ImageBitmap));
  return { contexts, getImageData, initialPixels, writtenImages };
}

describe('document image processing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the same explicit grayscale pixels for editor preview and PDF rendering', async () => {
    const { writtenImages } = mockCanvasPipeline();

    await renderDocumentFilterPreview(scannerPage('grayscale'));
    await renderDocumentPage(scannerPage('grayscale'));

    const previewPixels = writtenImages[0].data;
    const renderedPixels = writtenImages.at(-1)?.data;
    expect(renderedPixels).toEqual(previewPixels);
    for (let offset = 0; offset < previewPixels.length; offset += 4) {
      expect(previewPixels[offset]).toBe(previewPixels[offset + 1]);
      expect(previewPixels[offset + 1]).toBe(previewPixels[offset + 2]);
    }
  });

  it('does not read or rewrite pixels in original filter previews', async () => {
    const { getImageData, writtenImages } = mockCanvasPipeline();

    await renderDocumentFilterPreview(scannerPage('original'));

    expect(getImageData).not.toHaveBeenCalled();
    expect(writtenImages).toHaveLength(0);
  });

  it('rasterizes a continuous perspective result without clipped triangle seams', async () => {
    const { contexts, initialPixels, writtenImages } = mockCanvasPipeline();

    await renderDocumentPage(scannerPage('original'));

    expect(writtenImages).toHaveLength(1);
    expect(writtenImages[0].data).toEqual(initialPixels);
    expect(contexts.every((context) => context.clip.mock.calls.length === 0)).toBe(true);
    expect(contexts.every((context) => context.setTransform.mock.calls.length === 0)).toBe(true);
  });
});
