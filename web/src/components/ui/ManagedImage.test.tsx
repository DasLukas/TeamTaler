import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ManagedImage, ManagedImageFrame } from './ManagedImage';
import { supportsManagedImageVariants } from './managedImageSources';

const imageKey = `${'a'.repeat(64)}.png`;
const managedSource = `/api/v1/groups/group-a/images/${imageKey}`;

describe('ManagedImage', () => {
  it('builds bounded responsive sources for protected managed images', () => {
    render(<ManagedImage alt="Product" sizes="108px" src={managedSource} />);
    const image = screen.getByRole('img', { name: 'Product' });
    expect(image).toHaveAttribute('src', `${managedSource}?width=384`);
    expect(image).toHaveAttribute('srcset', `${managedSource}?width=128 128w, ${managedSource}?width=256 256w, ${managedSource}?width=384 384w`);
    expect(image).toHaveAttribute('sizes', '108px');
  });

  it('reveals an image only after asynchronous decoding completes', async () => {
    let finishDecoding: (() => void) | undefined;
    const decode = vi.fn(() => new Promise<void>((resolve) => { finishDecoding = resolve; }));
    render(<ManagedImage alt="Product" src={managedSource} />);
    const image = screen.getByRole('img', { name: 'Product' }) as HTMLImageElement;
    Object.defineProperty(image, 'decode', { configurable: true, value: decode });
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 384 });
    fireEvent.load(image);
    expect(image).toHaveAttribute('data-managed-image-state', 'loading');
    finishDecoding?.();
    await vi.waitFor(() => expect(image).toHaveAttribute('data-managed-image-state', 'ready'));
  });

  it('retries the canonical PNG when a display variant fails', () => {
    render(<ManagedImage alt="Product" src={managedSource} />);
    const image = screen.getByRole('img', { name: 'Product' });
    fireEvent.error(image);
    expect(image).toHaveAttribute('src', managedSource);
    expect(image).not.toHaveAttribute('srcset');
  });

  it('keeps an ordinary asset URL unchanged and provides a stable fallback frame', () => {
    render(<ManagedImageFrame alt="" fallback="C" frameClassName="product-frame" src="/assets/cola.webp" />);
    expect(document.querySelector('img')).toHaveAttribute('src', '/assets/cola.webp');
    expect(document.querySelector('.product-frame')).toHaveTextContent('C');
    expect(supportsManagedImageVariants('/assets/cola.webp')).toBe(false);
  });
});
