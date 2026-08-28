import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureDocumentFrame, createDetectionFrame, stopDocumentCamera, supportsDocumentCamera } from './cameraUtils';

describe('document scanner camera utilities', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'mediaDevices');
    Reflect.deleteProperty(globalThis, 'isSecureContext');
  });

  it('requires a secure context and getUserMedia support', () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } });
    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true });
    expect(supportsDocumentCamera()).toBe(true);
    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: false });
    expect(supportsDocumentCamera()).toBe(false);
  });

  it('stops every owned media track', () => {
    const first = vi.fn();
    const second = vi.fn();
    stopDocumentCamera({ getTracks: () => [{ stop: first }, { stop: second }] } as unknown as MediaStream);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('captures a bounded metadata-free JPEG', async () => {
    const video = document.createElement('video');
    Object.defineProperties(video, {
      videoHeight: { configurable: true, value: 3000 },
      videoWidth: { configurable: true, value: 4000 },
    });
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob(['jpeg'], { type: 'image/jpeg' }));
    });

    const file = await captureDocumentFrame(video, 1234);

    expect(file.name).toBe('document-page-1234.jpg');
    expect(file.type).toBe('image/jpeg');
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.9);
  });

  it('bounds portrait detection frames by their longest edge without requiring ImageBitmap support', () => {
    const video = document.createElement('video');
    Object.defineProperties(video, {
      videoHeight: { configurable: true, value: 1920 },
      videoWidth: { configurable: true, value: 1080 },
    });
    const imageData = { data: new Uint8ClampedArray(720 * 405 * 4), height: 720, width: 405 } as ImageData;
    const getImageData = vi.fn(() => imageData);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: vi.fn(), getImageData }) as unknown as CanvasRenderingContext2D);
    const createBitmap = vi.fn();
    vi.stubGlobal('createImageBitmap', createBitmap);

    const frame = createDetectionFrame(video);

    expect(frame).toBe(imageData);
    expect(getImageData).toHaveBeenCalledWith(0, 0, 405, 720);
    expect(createBitmap).not.toHaveBeenCalled();
  });
});
