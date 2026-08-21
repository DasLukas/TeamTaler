import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { createDocumentPdf } from './createDocumentPdf';
import { DocumentScannerWorkspace } from './DocumentScannerWorkspace';

const cameraState = vi.hoisted(() => ({ file: null as File | null }));

vi.mock('./createDocumentPdf', () => ({ createDocumentPdf: vi.fn() }));
vi.mock('./DocumentCamera', () => ({
  DocumentCamera: ({ active, onCapture }: { active: boolean; onCapture: (file: File, corners: Array<{ x: number; y: number }>) => void }) => (
    <section aria-label={i18n.t('documentScanner.cameraTitle')}>
      <button
        aria-label={i18n.t('documentScanner.capturePage')}
        disabled={!active}
        onClick={() => {
          if (cameraState.file) onCapture(cameraState.file, [{ x: 0.04, y: 0.04 }, { x: 0.96, y: 0.04 }, { x: 0.96, y: 0.96 }, { x: 0.04, y: 0.96 }]);
        }}
        type="button"
      />
    </section>
  ),
}));

const createObjectURL = vi.fn((file: File) => `blob:${file.name}-${Math.random()}`);
const revokeObjectURL = vi.fn();

function imageFile(name: string, type: 'image/jpeg' | 'image/png' | 'image/webp' = 'image/png', width = 100, height = 140, size = 32): File {
  const bytes = new Uint8Array(Math.max(size, type === 'image/webp' ? 30 : 24));
  const view = new DataView(bytes.buffer);
  if (type === 'image/png') {
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12);
    view.setUint32(16, width);
    view.setUint32(20, height);
  } else if (type === 'image/jpeg') {
    bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08]);
    view.setUint16(7, height);
    view.setUint16(9, width);
  } else {
    bytes.set([0x52, 0x49, 0x46, 0x46]);
    view.setUint32(4, 22, true);
    bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 8);
    view.setUint32(16, 10, true);
    const widthMinusOne = width - 1;
    const heightMinusOne = height - 1;
    bytes.set([widthMinusOne & 0xff, (widthMinusOne >> 8) & 0xff, (widthMinusOne >> 16) & 0xff], 24);
    bytes.set([heightMinusOne & 0xff, (heightMinusOne >> 8) & 0xff, (heightMinusOne >> 16) & 0xff], 27);
  }
  return new File([bytes], name, { type });
}

async function capture(file: File): Promise<void> {
  cameraState.file = file;
  await userEvent.click(screen.getByRole('button', { name: i18n.t('documentScanner.capturePage') }));
}

describe('DocumentScannerWorkspace', () => {
  beforeEach(() => {
    cameraState.file = null;
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    vi.mocked(createDocumentPdf).mockReset();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
  });

  it('renders an accessible camera-only workspace without visible dialog chrome or file sources', () => {
    render(<DocumentScannerWorkspace maxBytes={1024} onCancel={vi.fn()} onComplete={vi.fn()} open />);

    const dialog = screen.getByRole('dialog', { name: i18n.t('documentScanner.title') });
    expect(within(dialog).queryByRole('button', { name: i18n.t('dialog.close') })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('navigation')).not.toBeInTheDocument();
    expect(dialog.querySelector('input[type="file"]')).toBeNull();
    expect(within(dialog).getByRole('region', { name: i18n.t('documentScanner.cameraTitle') })).toBeInTheDocument();
  });

  it('adds camera captures, enforces the page limit, and releases previews on close', async () => {
    const { rerender } = render(
      <DocumentScannerWorkspace maxBytes={1024} maxPages={2} onCancel={vi.fn()} onComplete={vi.fn()} open />,
    );
    await capture(imageFile('first.jpg', 'image/jpeg'));
    await waitFor(() => expect(screen.getByText(i18n.t('documentScanner.pageCount', { count: 1, maxPages: 2 }))).toBeInTheDocument());
    await capture(imageFile('second.png'));

    expect(await screen.findByText(i18n.t('documentScanner.pageCount', { count: 2, maxPages: 2 }))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: i18n.t('documentScanner.capturePage') })).toBeDisabled();
    expect(createObjectURL).toHaveBeenCalledTimes(2);

    rerender(<DocumentScannerWorkspace maxBytes={1024} maxPages={2} onCancel={vi.fn()} onComplete={vi.fn()} open={false} />);
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledTimes(2));
  });

  it('disables the camera after the twentieth captured page', async () => {
    render(<DocumentScannerWorkspace maxBytes={4096} onCancel={vi.fn()} onComplete={vi.fn()} open />);
    for (let index = 1; index <= 20; index += 1) {
      await capture(imageFile(`page-${index}.png`));
      await waitFor(() => expect(screen.getByText(i18n.t('documentScanner.pageCount', { count: index, maxPages: 20 }))).toBeInTheDocument());
    }

    expect(screen.getByRole('button', { name: i18n.t('documentScanner.capturePage') })).toBeDisabled();
  });

  it('reorders and removes captured pages without mutating the source files', async () => {
    const user = userEvent.setup();
    render(<DocumentScannerWorkspace maxBytes={1024} onCancel={vi.fn()} onComplete={vi.fn()} open />);
    await capture(imageFile('first.jpg'));
    await waitFor(() => expect(screen.getByText(i18n.t('documentScanner.pageCount', { count: 1, maxPages: 20 }))).toBeInTheDocument());
    await capture(imageFile('second.jpg'));

    await user.click((await screen.findAllByRole('button', { name: i18n.t('documentScanner.moveLater') }))[0]);
    const pageImages = [
      screen.getByAltText(i18n.t('documentScanner.pageNumber', { number: 1 })),
      screen.getByAltText(i18n.t('documentScanner.pageNumber', { number: 2 })),
    ];
    expect(pageImages[0]).toHaveAttribute('src', expect.stringContaining('second.jpg'));

    await user.click(screen.getAllByRole('button', { name: i18n.t('documentScanner.deletePage') })[0]);
    expect(screen.getByText(i18n.t('documentScanner.pageCount', { count: 1, maxPages: 20 }))).toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('returns the generated PDF and preserves pages while generation is in progress', async () => {
    const user = userEvent.setup();
    const result = new File(['pdf'], 'scan.pdf', { type: 'application/pdf' });
    vi.mocked(createDocumentPdf).mockResolvedValue(result);
    const onComplete = vi.fn();
    render(<DocumentScannerWorkspace maxBytes={1024} onCancel={vi.fn()} onComplete={onComplete} open />);
    await capture(imageFile('page.jpg'));
    await waitFor(() => expect(screen.getByText(i18n.t('documentScanner.pageCount', { count: 1, maxPages: 20 }))).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: i18n.t('documentScanner.useDocument') }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(result));
    expect(createDocumentPdf).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ file: expect.any(File) })]), 1024);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('routes Escape through scanner cancellation without closing caller-owned state', () => {
    const onCancel = vi.fn();
    render(<DocumentScannerWorkspace maxBytes={1024} onCancel={onCancel} onComplete={vi.fn()} open />);
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('enforces aggregate source-byte and pixel budgets before retaining captures', async () => {
    const { rerender } = render(<DocumentScannerWorkspace maxBytes={1024} onCancel={vi.fn()} onComplete={vi.fn()} open />);
    for (let index = 1; index <= 5; index += 1) {
      await capture(imageFile(`${index}.png`, 'image/png', 100, 100, 900));
    }

    expect(await screen.findByText(i18n.t('documentScanner.pageCount', { count: 4, maxPages: 20 }))).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('documentScanner.resourceBudgetExceeded'));

    rerender(<DocumentScannerWorkspace maxBytes={1024} onCancel={vi.fn()} onComplete={vi.fn()} open={false} />);
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledTimes(4));

    rerender(<DocumentScannerWorkspace maxBytes={1024} onCancel={vi.fn()} onComplete={vi.fn()} open />);
    await capture(imageFile('large-one.png', 'image/png', 10_000, 10_000));
    await waitFor(() => expect(screen.getByText(i18n.t('documentScanner.pageCount', { count: 1, maxPages: 20 }))).toBeInTheDocument());
    await capture(imageFile('large-two.png', 'image/png', 10_000, 10_000));
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('documentScanner.resourceBudgetExceeded'));
  });

  it('opens an isolated editor and commits or discards a local page draft', async () => {
    const user = userEvent.setup();
    render(<DocumentScannerWorkspace maxBytes={1024} onCancel={vi.fn()} onComplete={vi.fn()} open />);
    await capture(imageFile('page.png', 'image/png', 100, 200));
    const thumbnail = await screen.findByAltText(i18n.t('documentScanner.pageNumber', { number: 1 }));
    const thumbnailButton = thumbnail.closest('button') as HTMLButtonElement;
    await user.click(thumbnailButton);

    const preview = await screen.findByAltText(i18n.t('documentScanner.pagePreview'));
    expect(screen.getByRole('heading', { name: i18n.t('documentScanner.editTitle') })).toHaveFocus();
    expect(screen.queryByRole('region', { name: i18n.t('documentScanner.cameraTitle') })).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: i18n.t('documentScanner.pages') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: i18n.t('documentScanner.capturePage') })).not.toBeInTheDocument();
    expect(preview).toHaveAttribute('data-rotation', '0');
    const firstHandle = screen.getByRole('button', { name: i18n.t('documentScanner.moveCorner', { corner: 'top left' }) });
    expect(firstHandle).toHaveStyle({ left: '4%', top: '4%' });

    await user.click(screen.getByRole('button', { name: i18n.t('documentScanner.rotate') }));
    expect(preview).toHaveAttribute('data-rotation', '90');
    expect(preview).toHaveStyle({ transform: 'translate(-50%, -50%) rotate(90deg)' });
    expect(firstHandle).toHaveStyle({ left: '96%', top: '4%' });

    await user.click(screen.getByRole('button', { name: i18n.t('common.cancel') }));
    expect(screen.getByRole('region', { name: i18n.t('documentScanner.cameraTitle') })).toBeInTheDocument();
    const returnedThumbnailButton = screen.getByAltText(i18n.t('documentScanner.pageNumber', { number: 1 })).closest('button') as HTMLButtonElement;
    await waitFor(() => expect(returnedThumbnailButton).toHaveFocus());

    await user.click(returnedThumbnailButton);
    expect(screen.getByAltText(i18n.t('documentScanner.pagePreview'))).toHaveAttribute('data-rotation', '0');
    await user.click(screen.getByRole('button', { name: i18n.t('documentScanner.rotate') }));
    await user.click(screen.getByRole('button', { name: i18n.t('documentScanner.applyChanges') }));
    await user.click(screen.getByAltText(i18n.t('documentScanner.pageNumber', { number: 1 })).closest('button') as HTMLButtonElement);
    expect(screen.getByAltText(i18n.t('documentScanner.pagePreview'))).toHaveAttribute('data-rotation', '90');
  });

  it('routes Escape from the editor back to the scanner without cancelling the session', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<DocumentScannerWorkspace maxBytes={1024} onCancel={onCancel} onComplete={vi.fn()} open />);
    await capture(imageFile('page.png'));
    await user.click((await screen.findByAltText(i18n.t('documentScanner.pageNumber', { number: 1 }))).closest('button') as HTMLButtonElement);

    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));

    expect(screen.getByRole('region', { name: i18n.t('documentScanner.cameraTitle') })).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
