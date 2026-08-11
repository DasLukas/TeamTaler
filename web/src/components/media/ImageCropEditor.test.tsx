import { fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageCropEditor } from './ImageCropEditor';
import { DEFAULT_IMAGE_TRANSFORM, type ImageTransform } from './imageUpload';

function EditorHarness({ file }: { file: File }) {
  const [transform, setTransform] = useState<ImageTransform>(DEFAULT_IMAGE_TRANSFORM);
  return <ImageCropEditor alt="Local preview" file={file} onChange={setTransform} value={transform} />;
}

describe('ImageCropEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let sequence = 0;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => `blob:preview-${++sequence}`),
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });

  it('keeps a valid local preview URL across the Strict Mode effect restart', () => {
    const file = new File(['image'], 'avatar.png', { type: 'image/png' });
    const { unmount } = render(<StrictMode><EditorHarness file={file} /></StrictMode>);
    const previewImage = screen.getByRole('img', { name: 'Local preview' }).querySelector('img');

    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:preview-2');
    expect(previewImage).toHaveAttribute('src', 'blob:preview-2');

    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-2');
  });

  it('moves the crop with pointer dragging', () => {
    const file = new File(['image'], 'product.png', { type: 'image/png' });
    const onChange = vi.fn();
    render(<ImageCropEditor alt="Product preview" file={file} onChange={onChange} value={{ x: 0, y: 0, zoom: 2 }} />);
    const preview = screen.getByRole('img', { name: 'Product preview' });
    Object.defineProperties(preview, {
      getBoundingClientRect: { configurable: true, value: () => ({ width: 200, height: 200 }) },
      setPointerCapture: { configurable: true, value: vi.fn() },
    });

    fireEvent.pointerDown(preview, { button: 0, clientX: 100, clientY: 100, pointerId: 7 });
    fireEvent.pointerMove(preview, { clientX: 120, clientY: 80, pointerId: 7 });

    expect(onChange).toHaveBeenCalledWith({ x: 0.2, y: -0.2, zoom: 2 });
  });
});
