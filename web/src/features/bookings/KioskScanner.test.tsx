import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { KioskCameraOptions } from './scanner/camera';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KioskScanner } from './KioskScanner';

const decoder = vi.hoisted(() => ({ options: undefined as KioskCameraOptions | undefined, start: vi.fn(), stop: vi.fn() }));
vi.mock('./scanner/camera', () => ({ startKioskCamera: (options: KioskCameraOptions) => {
  decoder.start();
  decoder.options = options;
  return decoder.stop;
} }));
const BarcodeFormat = { QR_CODE: 'QR_CODE', EAN_13: 'EAN_13', UPC_E: 'UPC_E' } as const;
const emit = (value: string, format: 'QR_CODE' | 'EAN_13' | 'UPC_E') => decoder.options?.onCodes([{ value, format }]);

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

describe('KioskScanner modes', () => {
  beforeEach(() => {
    decoder.options = undefined;
    decoder.start.mockClear();
    decoder.stop.mockClear();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } });
    vi.stubGlobal('MediaStream', class MediaStream {});
    Object.defineProperty(HTMLDialogElement.prototype, 'show', { configurable: true, value: vi.fn(function show(this: HTMLDialogElement) { this.setAttribute('open', ''); }) });
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); });
    vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function close(this: HTMLDialogElement) { this.removeAttribute('open'); });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    await waitFor(() => expect(decoder.options).toBeDefined());
    expect(decoder.options?.barcodeOnly).toBe(false);

    act(() => emit('https://example.test/book?group=one', BarcodeFormat.QR_CODE));
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
    await waitFor(() => expect(decoder.options).toBeDefined());
    act(() => emit('4006381333931', BarcodeFormat.EAN_13));
    expect(onScan).toHaveBeenCalledExactlyOnceWith('4006381333931', 'EAN_13');
  });

  it('shows each successful scan briefly while decoding remains available', async () => {
    const onScan = vi.fn();
    const { rerender } = render(<KioskScanner onClose={vi.fn()} onScan={onScan} />);
    await waitFor(() => expect(decoder.options).toBeDefined());
    vi.useFakeTimers();

    rerender(<KioskScanner onClose={vi.fn()} onScan={onScan} success={{ id: 1, message: 'Water added to cart' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Water added to cart');
    await act(async () => {});
    act(() => emit('4006381333931', BarcodeFormat.EAN_13));
    expect(onScan).toHaveBeenCalledExactlyOnceWith('4006381333931', 'EAN_13');

    act(() => vi.advanceTimersByTime(900));
    rerender(<KioskScanner onClose={vi.fn()} onScan={onScan} success={{ id: 2, message: 'Water added to cart' }} />);
    act(() => vi.advanceTimersByTime(950));
    expect(screen.getByRole('status')).toHaveTextContent('Water added to cart');
    act(() => vi.advanceTimersByTime(850));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps decoding behind expanded details without restarting the camera', async () => {
    const onScan = vi.fn();
    const { rerender } = render(<KioskScanner cart={<div>Cart summary</div>} cartExpanded onClose={vi.fn()} onScan={onScan} />);

    expect(screen.getByRole('dialog')).toHaveTextContent('Cart summary');
    await waitFor(() => expect(decoder.options).toBeDefined());
    act(() => emit('https://example.test/book?group=one', BarcodeFormat.QR_CODE));
    expect(onScan).toHaveBeenCalledOnce();

    const pausedCallback = decoder.options;
    rerender(<KioskScanner cart={<div>Cart summary</div>} cartExpanded={false} onClose={vi.fn()} onScan={onScan} />);
    expect(decoder.options).toBe(pausedCallback);
    expect(decoder.stop).not.toHaveBeenCalled();
    act(() => emit('https://example.test/book?group=one', BarcodeFormat.QR_CODE));
    expect(onScan).toHaveBeenCalledOnce();
  });

  it('protects external identities across formats and defers new products during interaction', async () => {
    const onScan = vi.fn();
    let blocked = true;
    render(<KioskScanner cartExpanded initialScanKey="product:water" resolveScanKey={(value) => value === 'qr-water' || value === 'barcode-water' ? 'product:water' : value} isScanBlocked={() => blocked} onClose={vi.fn()} onScan={onScan} />);
    await waitFor(() => expect(decoder.options).toBeDefined());
    act(() => emit('qr-water', BarcodeFormat.QR_CODE));
    act(() => emit('barcode-water', BarcodeFormat.EAN_13));
    act(() => emit('next', BarcodeFormat.EAN_13));
    expect(onScan).not.toHaveBeenCalled();
    blocked = false;
    act(() => emit('next', BarcodeFormat.EAN_13));
    expect(onScan).toHaveBeenCalledExactlyOnceWith('next', 'EAN_13');
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
    await waitFor(() => expect(decoder.options).toBeDefined());
    expect(decoder.options?.barcodeOnly).toBe(true);

    act(() => emit('https://example.test/book?group=one', BarcodeFormat.QR_CODE));
    expect(onScan).not.toHaveBeenCalled();
    act(() => emit('01234565', BarcodeFormat.UPC_E));
    expect(onScan).toHaveBeenCalledExactlyOnceWith('01234565', 'UPC_E');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(decoder.stop).toHaveBeenCalledOnce();
  });

  it('shows catalog capture conflicts as a themed warning inside the scanner footer', () => {
    render(<KioskScanner feedback="Dieser Barcode wird bereits für „Club-Mate“ verwendet." feedbackTone="warning" mode="barcodeCapture" onClose={vi.fn()} onScan={vi.fn()} />);

    const warning = screen.getByRole('alert');
    expect(warning).toHaveTextContent('Club-Mate');
    expect(warning.className).toContain('feedbackWarning');
    expect(screen.getByRole('dialog', { name: 'Produkt-Barcode erfassen' })).toContainElement(warning);
  });

  it('keeps the latest identity across phone rotation and cart layout changes', () => {
    const onScan = vi.fn();
    const { rerender } = render(<KioskScanner initialScanKey="QR_CODE:water" onClose={vi.fn()} onScan={onScan} />);
    act(() => emit('spezi', 'QR_CODE'));
    rerender(<KioskScanner embedded initialScanKey="QR_CODE:water" onClose={vi.fn()} onScan={onScan} />);
    act(() => { decoder.options?.onSuspend(); emit('spezi', 'QR_CODE'); });
    expect(decoder.start).toHaveBeenCalledOnce();
    expect(onScan).toHaveBeenCalledOnce();
  });

  it('refuses ambiguous frames without rearming the current product', () => {
    const onScan = vi.fn();
    render(<KioskScanner onClose={vi.fn()} onScan={onScan} />);
    act(() => emit('water', 'QR_CODE'));
    act(() => decoder.options?.onCodes([{ value: 'water', format: 'QR_CODE' }, { value: 'spezi', format: 'QR_CODE' }]));
    expect(screen.getByRole('status')).toHaveTextContent('kiosk.multipleCodes');
    act(() => emit('water', 'QR_CODE'));
    expect(onScan).toHaveBeenCalledOnce();
  });

  it('gives catalog-specific guidance when camera access is unavailable', async () => {
    render(<KioskScanner mode="barcodeCapture" onClose={vi.fn()} onScan={vi.fn()} />);
    act(() => decoder.options?.onError());
    expect(await screen.findByRole('alert')).toHaveTextContent('Gib den Barcode im Produktformular ein.');
  });
});
