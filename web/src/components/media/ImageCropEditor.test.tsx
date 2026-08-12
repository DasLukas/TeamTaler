import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageCropEditor } from './ImageCropEditor';
import { DEFAULT_IMAGE_TRANSFORM, type ImageTransform } from './imageUpload';

function EditorHarness({ file }: { file: File }) {
  const [transform, setTransform] = useState<ImageTransform>(DEFAULT_IMAGE_TRANSFORM);
  return <ImageCropEditor alt="Local preview" file={file} onChange={setTransform} value={transform} />;
}

describe('ImageCropEditor', () => {
  const bitmaps: Array<ImageBitmap & { close: ReturnType<typeof vi.fn> }> = [];
  const context = {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    bitmaps.length = 0;
    vi.stubGlobal('createImageBitmap', vi.fn(async () => {
      const bitmap = {
        close: vi.fn(),
        height: 100,
        width: 100,
      } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
      bitmaps.push(bitmap);
      return bitmap;
    }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps one decoded bitmap alive across the Strict Mode effect restart', async () => {
    const file = new File(['image'], 'avatar.png', { type: 'image/png' });
    const { unmount } = render(<StrictMode><EditorHarness file={file} /></StrictMode>);

    await waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(context.drawImage).toHaveBeenCalledWith(bitmaps[1], 0, 0, 512, 512));
    expect(bitmaps[0].close).toHaveBeenCalledTimes(1);
    expect(bitmaps[1].close).not.toHaveBeenCalled();

    unmount();
    expect(bitmaps[1].close).toHaveBeenCalledTimes(1);
  });

  it('decodes an adversarially named file directly into the preview canvas', async () => {
    const file = new File(['image'], '"><svg onload=alert(1)>.png', { type: 'image/png' });
    const rendered = render(<EditorHarness file={file} />);

    await waitFor(() => expect(context.drawImage).toHaveBeenCalledWith(bitmaps[0], 0, 0, 512, 512));
    expect(createImageBitmap).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(rendered.container.querySelector('img')).not.toBeInTheDocument();
    expect(rendered.container.querySelector('[src]')).not.toBeInTheDocument();
    expect(rendered.container.querySelector('[onload]')).not.toBeInTheDocument();
  });

  it('moves the crop with pointer dragging', async () => {
    const file = new File(['image'], 'product.png', { type: 'image/png' });
    const onChange = vi.fn();
    render(<ImageCropEditor alt="Product preview" file={file} onChange={onChange} value={{ x: 0, y: 0, zoom: 2 }} />);
    const preview = screen.getByRole('img', { name: 'Product preview' });
    Object.defineProperties(preview, {
      getBoundingClientRect: { configurable: true, value: () => ({ width: 200, height: 200 }) },
      setPointerCapture: { configurable: true, value: vi.fn() },
    });
    await waitFor(() => expect(context.drawImage).toHaveBeenCalled());

    fireEvent.pointerDown(preview, { button: 0, clientX: 100, clientY: 100, pointerId: 7 });
    fireEvent.pointerMove(preview, { clientX: 120, clientY: 80, pointerId: 7 });

    expect(onChange).toHaveBeenCalledWith({ x: 0.2, y: -0.2, zoom: 2 });
  });
});
