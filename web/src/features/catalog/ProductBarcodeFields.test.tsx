import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductBarcode } from '@/api/types';
import i18n from '@/i18n';
import { ProductBarcodeFields } from './ProductBarcodeFields';

const mocks = vi.hoisted(() => ({ toCanvas: vi.fn() }));
vi.mock('@bwip-js/browser', () => ({ toCanvas: mocks.toCanvas }));

const valid: ProductBarcode = { format: 'EAN_13', value: '4006381333931' };

describe('ProductBarcodeFields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a scannable canvas only for a valid barcode', async () => {
    render(<ProductBarcodeFields barcodes={[valid]} disabled={false} onCapture={vi.fn()} onChange={vi.fn()} />);

    const canvas = await screen.findByRole('img', { name: i18n.t('kiosk.barcodePreview', { number: 1 }) });
    await waitFor(() => expect(mocks.toCanvas).toHaveBeenCalledWith(canvas, expect.objectContaining({ bcid: 'ean13', text: valid.value, scale: 2 })));
    expect(screen.getByRole('textbox', { name: i18n.t('kiosk.barcodeValue', { number: 1 }) })).toHaveAttribute('aria-invalid', 'false');
  });

  it('marks a bad check digit at the field and omits the preview', () => {
    render(<ProductBarcodeFields barcodes={[{ ...valid, value: '4006381333932' }]} disabled={false} onCapture={vi.fn()} onChange={vi.fn()} />);

    expect(screen.getByRole('textbox', { name: i18n.t('kiosk.barcodeValue', { number: 1 }) })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('kiosk.barcodeErrors.checkDigit'));
    expect(screen.queryByRole('img', { name: i18n.t('kiosk.barcodePreview', { number: 1 }) })).not.toBeInTheDocument();
    expect(mocks.toCanvas).not.toHaveBeenCalled();
  });

  it('keeps a newly empty row optional while the parent skips it on save', async () => {
    const user = userEvent.setup();
    render(<ProductBarcodeFields barcodes={[{ format: 'EAN_13', value: '' }]} disabled={false} onCapture={vi.fn()} onChange={vi.fn()} />);

    const value = screen.getByRole('textbox', { name: i18n.t('kiosk.barcodeValue', { number: 1 }) });
    expect(value).toHaveAttribute('aria-invalid', 'false');
    await user.click(value);
    await user.tab();
    expect(value).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('adds, removes, and delegates camera capture', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onCapture = vi.fn();
    const { rerender } = render(<ProductBarcodeFields barcodes={[]} disabled={false} onCapture={onCapture} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: i18n.t('kiosk.addBarcode') }));
    expect(onChange).toHaveBeenCalledWith([{ format: 'EAN_13', value: '' }]);
    await user.click(screen.getByRole('button', { name: i18n.t('kiosk.captureBarcode') }));
    expect(onCapture).toHaveBeenCalledTimes(1);

    rerender(<ProductBarcodeFields barcodes={[valid]} disabled={false} onCapture={onCapture} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: i18n.t('kiosk.removeBarcode', { number: 1 }) }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
