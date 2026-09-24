import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BarcodeFormat } from '@zxing/library';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KioskScanner } from './KioskScanner';

const decoder = vi.hoisted(() => ({
  callback: undefined as ((result?: { getText: () => string; getBarcodeFormat: () => number }) => void) | undefined,
  formats: [] as number[],
  stop: vi.fn(),
}));

vi.mock('@zxing/browser', () => ({
  BrowserMultiFormatReader: class {
    set possibleFormats(formats: number[]) { decoder.formats = formats; }
    async decodeFromConstraints(_constraints: unknown, _video: unknown, callback: typeof decoder.callback) {
      decoder.callback = callback;
      return { stop: decoder.stop };
    }
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'common.close': 'Schließen',
      'kiosk.scannerTitle': 'Scan & Go',
      'kiosk.scannerHint': 'Scanne ein Produkt.',
      'kiosk.cameraUnavailable': 'Die Kamera ist nicht verfügbar.',
      'kiosk.barcodeCaptureTitle': 'Produkt-Barcode erfassen',
      'kiosk.barcodeCaptureHint': 'Halte einen EAN-, UPC- oder Code-128-Barcode in den Rahmen.',
      'kiosk.barcodeCameraUnavailable': 'Gib den Barcode im Produktformular ein.',
    })[key] ?? key,
  }),
}));

function decoded(value: string, format: BarcodeFormat) {
  return { getText: () => value, getBarcodeFormat: () => format };
}

describe('KioskScanner modes', () => {
  beforeEach(() => {
    decoder.callback = undefined;
    decoder.formats = [];
    decoder.stop.mockClear();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } });
    vi.stubGlobal('MediaStream', class MediaStream {});
    Object.defineProperty(HTMLDialogElement.prototype, 'show', { configurable: true, value: vi.fn(function show(this: HTMLDialogElement) { this.setAttribute('open', ''); }) });
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); });
    vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function close(this: HTMLDialogElement) { this.removeAttribute('open'); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'show');
    Reflect.deleteProperty(navigator, 'mediaDevices');
  });

  it('keeps booking QR scanning and the manual product fallback', async () => {
    const onScan = vi.fn();
    const { unmount } = render(<KioskScanner onClose={vi.fn()} onScan={onScan} />);

    expect(screen.getByRole('dialog', { name: 'Scan & Go' })).toBeVisible();
    expect(screen.getByText('Scanne ein Produkt.')).toBeVisible();
    await waitFor(() => expect(decoder.callback).toBeDefined());
    expect(decoder.formats).toContain(BarcodeFormat.QR_CODE);
    expect(decoder.formats).toContain(BarcodeFormat.EAN_13);

    act(() => decoder.callback?.(decoded('https://example.test/book?group=one', BarcodeFormat.QR_CODE)));
    expect(onScan).toHaveBeenCalledWith('https://example.test/book?group=one', 'QR_CODE');
    unmount();
    expect(decoder.stop).toHaveBeenCalledOnce();
  });

  it('returns to manual selection through the close control without a separate footer', () => {
    const onClose = vi.fn();
    render(<KioskScanner onClose={onClose} onScan={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Produkt manuell auswählen' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('opens an embedded scanner without making the adjacent cart inert', async () => {
    const onScan = vi.fn();
    render(<KioskScanner embedded onClose={vi.fn()} onScan={onScan} />);

    expect(screen.getByRole('dialog', { name: 'Scan & Go' })).toBeVisible();
    expect(HTMLDialogElement.prototype.show).toHaveBeenCalledOnce();
    expect(HTMLDialogElement.prototype.showModal).not.toHaveBeenCalled();
    await waitFor(() => expect(decoder.callback).toBeDefined());
    act(() => decoder.callback?.(decoded('4006381333931', BarcodeFormat.EAN_13)));
    expect(onScan).toHaveBeenCalledExactlyOnceWith('4006381333931', 'EAN_13');
  });

  it('keeps the cart in the scan dialog and pauses decoding while its details are open', async () => {
    const onScan = vi.fn();
    const { rerender } = render(<KioskScanner cart={<div>Cart summary</div>} cartExpanded onClose={vi.fn()} onScan={onScan} />);

    expect(screen.getByRole('dialog')).toHaveTextContent('Cart summary');
    await waitFor(() => expect(decoder.callback).toBeDefined());
    act(() => decoder.callback?.(decoded('https://example.test/book?group=one', BarcodeFormat.QR_CODE)));
    expect(onScan).not.toHaveBeenCalled();

    const pausedCallback = decoder.callback;
    rerender(<KioskScanner cart={<div>Cart summary</div>} cartExpanded={false} onClose={vi.fn()} onScan={onScan} />);
    await waitFor(() => expect(decoder.callback).not.toBe(pausedCallback));
    act(() => decoder.callback?.(decoded('https://example.test/book?group=one', BarcodeFormat.QR_CODE)));
    expect(onScan).toHaveBeenCalledOnce();
  });

  it('collapses expanded cart details when the camera background is clicked', () => {
    const onCollapseCart = vi.fn();
    const { container, rerender } = render(<KioskScanner cart={<button type="button">Cart action</button>} cartExpanded onClose={vi.fn()} onCollapseCart={onCollapseCart} onScan={vi.fn()} />);
    const viewport = container.querySelector('video')?.parentElement;
    expect(viewport).not.toBeNull();

    fireEvent.click(viewport!);
    expect(onCollapseCart).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Cart action' }));
    expect(onCollapseCart).toHaveBeenCalledOnce();

    rerender(<KioskScanner cart={<button type="button">Cart action</button>} cartExpanded={false} onClose={vi.fn()} onCollapseCart={onCollapseCart} onScan={vi.fn()} />);
    fireEvent.click(viewport!);
    expect(onCollapseCart).toHaveBeenCalledOnce();
  });

  it('presents a compact catalog dialog that ignores QR codes and accepts linear formats', async () => {
    const onScan = vi.fn();
    function CatalogCapture() {
      const [open, setOpen] = useState(true);
      return open ? <KioskScanner mode="barcodeCapture" onClose={() => setOpen(false)} onScan={(value, format) => {
        onScan(value, format);
        setOpen(false);
      }} /> : null;
    }
    render(<CatalogCapture />);

    expect(screen.getByRole('dialog', { name: 'Produkt-Barcode erfassen' })).toBeVisible();
    expect(screen.getByText('Halte einen EAN-, UPC- oder Code-128-Barcode in den Rahmen.')).toBeVisible();
    expect(screen.queryByText('Scan & Go')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Produkt manuell auswählen' })).not.toBeInTheDocument();
    await waitFor(() => expect(decoder.callback).toBeDefined());
    expect(decoder.formats).toEqual([BarcodeFormat.EAN_8, BarcodeFormat.EAN_13, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128]);

    act(() => decoder.callback?.(decoded('https://example.test/book?group=one', BarcodeFormat.QR_CODE)));
    expect(onScan).not.toHaveBeenCalled();
    act(() => decoder.callback?.(decoded('01234565', BarcodeFormat.UPC_E)));
    expect(onScan).toHaveBeenCalledExactlyOnceWith('01234565', 'UPC_E');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(decoder.stop).toHaveBeenCalledOnce();
  });

  it('gives catalog-specific guidance when camera access is unavailable', async () => {
    Reflect.deleteProperty(navigator, 'mediaDevices');
    render(<KioskScanner mode="barcodeCapture" onClose={vi.fn()} onScan={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Gib den Barcode im Produktformular ein.');
  });
});
