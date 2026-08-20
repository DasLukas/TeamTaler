import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderDocumentPage } from './imageProcessing';
import type { ScannerPage } from './types';

const { createPdf } = vi.hoisted(() => ({ createPdf: vi.fn() }));

vi.mock('./imageProcessing', () => ({ renderDocumentPage: vi.fn() }));
vi.mock('pdf-lib', () => ({ PDFDocument: { create: createPdf } }));

function scannerPage(index: number): ScannerPage {
  return {
    corners: [{ x: 0.04, y: 0.04 }, { x: 0.96, y: 0.04 }, { x: 0.96, y: 0.96 }, { x: 0.04, y: 0.96 }],
    file: new File(['source'], `page-${index}.jpg`, { type: 'image/jpeg' }),
    filter: 'color',
    id: `page-${index}`,
    previewUrl: `blob:page-${index}`,
    rotation: 0,
    sourceHeight: 100,
    sourceWidth: 100,
  };
}

function pdfDocument(savedSizes: number[]) {
  const drawImage = vi.fn();
  const save = vi.fn();
  for (const size of savedSizes) save.mockResolvedValueOnce(new Uint8Array(size));
  return {
    addPage: vi.fn(() => ({ drawImage })),
    drawImage,
    embedJpg: vi.fn().mockResolvedValue({}),
    save,
  };
}

describe('createDocumentPdf', () => {
  beforeEach(() => {
    createPdf.mockReset();
    vi.mocked(renderDocumentPage).mockReset();
  });

  it('aborts before rendering another page when embedded JPEG data already exceeds the limit', async () => {
    const pdf = pdfDocument([]);
    createPdf.mockResolvedValue(pdf);
    vi.mocked(renderDocumentPage).mockResolvedValue({ blob: new Blob([new Uint8Array(101)]), height: 100, width: 100 });
    const { createDocumentPdf } = await import('./createDocumentPdf');

    await expect(createDocumentPdf([scannerPage(1), scannerPage(2)], 100)).rejects.toThrow('exceeds');

    expect(renderDocumentPage).toHaveBeenCalledTimes(1);
    expect(pdf.embedJpg).not.toHaveBeenCalled();
    expect(pdf.save).not.toHaveBeenCalled();
  });

  it('checks serialized PDF size after each four-page batch', async () => {
    const pdf = pdfDocument([1_001]);
    createPdf.mockResolvedValue(pdf);
    vi.mocked(renderDocumentPage).mockResolvedValue({ blob: new Blob([new Uint8Array(10)]), height: 100, width: 100 });
    const { createDocumentPdf } = await import('./createDocumentPdf');

    await expect(createDocumentPdf(Array.from({ length: 5 }, (_, index) => scannerPage(index)), 1_000)).rejects.toThrow('exceeds');

    expect(renderDocumentPage).toHaveBeenCalledTimes(4);
    expect(pdf.save).toHaveBeenCalledTimes(1);
  });

  it('stops before embedding a page that crosses the aggregate rendered-pixel budget', async () => {
    const pdf = pdfDocument([]);
    createPdf.mockResolvedValue(pdf);
    vi.mocked(renderDocumentPage).mockResolvedValue({ blob: new Blob(['jpeg']), height: 11_000, width: 11_000 });
    const { createDocumentPdf } = await import('./createDocumentPdf');

    await expect(createDocumentPdf([scannerPage(1), scannerPage(2)], 1_000)).rejects.toThrow('pixel budget');

    expect(renderDocumentPage).toHaveBeenCalledTimes(1);
    expect(pdf.embedJpg).not.toHaveBeenCalled();
  });
});
