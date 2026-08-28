import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentAttachmentSummary } from '@/api/types';
import i18n from '@/i18n';
import { PaymentAttachmentAction } from './PaymentAttachmentAction';

const mocks = vi.hoisted(() => ({ getPaymentAttachment: vi.fn() }));

vi.mock('@/api/client', () => ({ api: mocks }));

const pdfAttachment: PaymentAttachmentSummary = {
  fileName: 'receipt.pdf',
  mediaType: 'application/pdf',
  sizeBytes: 128,
  url: '/api/groups/group-a/payments/payment-a/attachment',
};

function renderAction(attachment = pdfAttachment) {
  return render(<PaymentAttachmentAction attachment={attachment} groupId="group-a" paymentId="payment-a" />);
}

function createPreviewWindow() {
  const previewDocument = document.implementation.createHTMLDocument('');
  const replacePreviewLocation = vi.fn();
  const closePreview = vi.fn();
  const previewWindow = {
    closed: false,
    close: closePreview,
    document: previewDocument,
    location: { replace: replacePreviewLocation },
    opener: window,
  } as unknown as Window;
  return { closePreview, previewDocument, previewWindow, replacePreviewLocation };
}

describe('PaymentAttachmentAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:receipt') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });

  it('opens PDF receipts in a synchronously prepared native preview tab', async () => {
    const { closePreview, previewDocument, previewWindow, replacePreviewLocation } = createPreviewWindow();
    let resolveReceipt!: (blob: Blob) => void;
    mocks.getPaymentAttachment.mockReturnValue(new Promise<Blob>((resolve) => { resolveReceipt = resolve; }));
    vi.spyOn(window, 'open').mockReturnValue(previewWindow);
    renderAction();

    fireEvent.click(screen.getByRole('button', { name: i18n.t('paymentAttachment.action') }));

    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(previewDocument.title).toBe(i18n.t('exports.table.previewTitle', { title: pdfAttachment.fileName }));
    expect(previewDocument.body.textContent).toContain(i18n.t('exports.table.previewLoading'));
    expect(mocks.getPaymentAttachment).toHaveBeenCalledWith('group-a', 'payment-a');

    resolveReceipt(new Blob(['%PDF-receipt'], { type: 'application/pdf' }));
    await waitFor(() => expect(replacePreviewLocation).toHaveBeenCalledWith('blob:receipt'));
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.objectContaining({
      name: pdfAttachment.fileName,
      type: 'application/pdf',
    }));
    expect(closePreview).not.toHaveBeenCalled();
  });

  it('does not request a PDF receipt when the browser blocks its preview tab', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    renderAction();

    fireEvent.click(screen.getByRole('button', { name: i18n.t('paymentAttachment.action') }));

    expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('exports.table.previewBlocked'));
    expect(mocks.getPaymentAttachment).not.toHaveBeenCalled();
  });

  it('closes the placeholder tab when loading a PDF receipt fails', async () => {
    const { closePreview, previewWindow } = createPreviewWindow();
    mocks.getPaymentAttachment.mockRejectedValueOnce(new Error('network unavailable'));
    vi.spyOn(window, 'open').mockReturnValue(previewWindow);
    renderAction();

    fireEvent.click(screen.getByRole('button', { name: i18n.t('paymentAttachment.action') }));

    expect(await screen.findByRole('alert')).toHaveTextContent('network unavailable');
    expect(closePreview).toHaveBeenCalledTimes(1);
  });

  it('keeps image receipts in the in-app preview dialog', async () => {
    mocks.getPaymentAttachment.mockResolvedValueOnce(new Blob(['image'], { type: 'image/jpeg' }));
    const openWindow = vi.spyOn(window, 'open');
    renderAction({ ...pdfAttachment, fileName: 'receipt.jpg', mediaType: 'image/jpeg' });

    fireEvent.click(screen.getByRole('button', { name: i18n.t('paymentAttachment.action') }));

    expect(await screen.findByRole('dialog', { name: 'receipt.jpg' })).toBeVisible();
    expect(screen.getByRole('img', { name: 'receipt.jpg' })).toHaveAttribute('src', 'blob:receipt');
    expect(openWindow).not.toHaveBeenCalled();
  });
});
