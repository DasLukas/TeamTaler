import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DOCUMENT_CORNERS } from './geometry';
import { renderDocumentPage } from './imageProcessing';
import { DocumentPageThumbnail } from './DocumentPageThumbnail';
import type { ScannerPage } from './types';

vi.mock('./imageProcessing', () => ({ renderDocumentPage: vi.fn() }));

function scannerPage(): ScannerPage {
  return {
    corners: DEFAULT_DOCUMENT_CORNERS,
    file: new File(['source'], 'page.jpg', { type: 'image/jpeg' }),
    filter: 'grayscale',
    id: 'page',
    previewUrl: 'blob:source-page',
    rotation: 90,
    sourceHeight: 140,
    sourceWidth: 100,
  };
}

describe('DocumentPageThumbnail', () => {
  beforeEach(() => {
    vi.mocked(renderDocumentPage).mockReset().mockResolvedValue({
      blob: new Blob(['rendered'], { type: 'image/jpeg' }),
      height: 100,
      width: 140,
    });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:rendered-page') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });

  it('replaces the source fallback with the cropped, rotated, and filtered page result', async () => {
    const page = scannerPage();
    const { unmount } = render(<DocumentPageThumbnail alt="Page 1" page={page} />);
    const image = screen.getByAltText('Page 1');
    expect(image).toHaveAttribute('src', page.previewUrl);
    expect(image).toHaveAttribute('data-rendered-preview', 'false');

    await waitFor(() => expect(image).toHaveAttribute('src', 'blob:rendered-page'));

    expect(image).toHaveAttribute('data-rendered-preview', 'true');
    expect(renderDocumentPage).toHaveBeenCalledWith(page, 720);
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:rendered-page');
  });
});
