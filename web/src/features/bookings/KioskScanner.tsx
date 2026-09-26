import Barcode from 'lucide-react/dist/esm/icons/barcode';
import QrCode from 'lucide-react/dist/esm/icons/qr-code';
import Check from 'lucide-react/dist/esm/icons/check';
import ScanLine from 'lucide-react/dist/esm/icons/scan-line';
import X from 'lucide-react/dist/esm/icons/x';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProductBarcodeFormat } from '@/api/types';
import { ScanRearm } from './kioskScan';
import { useScannerViewport } from './scanner/useScannerViewport';
import { startKioskCamera } from './scanner/camera';
import styles from './KioskScanner.module.css';

/** Camera scanner properties shared by booking and catalog barcode capture. */
export interface KioskScannerProps {
  onClose: () => void;
  onScan: (value: string, format?: ProductBarcodeFormat | 'QR_CODE') => void;
  feedback?: string;
  feedbackTone?: 'default' | 'warning' | 'error';
  /** Product confirmation; a new id restarts the confirmation timer for repeated names. */
  success?: { id: number; message: string } | null;
  mode?: 'booking' | 'barcodeCapture';
  embedded?: boolean;
  cart?: ReactNode;
  cartExpanded?: boolean;
  onCollapseCart?: () => void;
  initialScanKey?: string;
  /** Canonical product identity; undefined keeps unknown-code feedback separate from product rearming. */
  resolveScanKey?: (value: string, format?: ProductBarcodeFormat | 'QR_CODE') => string | undefined;
  isScanBlocked?: () => boolean;
}

const linearFormats: readonly ProductBarcodeFormat[] = ['EAN_8', 'EAN_13', 'UPC_A', 'UPC_E', 'CODE_128'];
const SCAN_SUCCESS_DURATION_MS = 1_800;

function isLinearFormat(format: string | undefined): format is ProductBarcodeFormat {
  return linearFormats.some((candidate) => candidate === format);
}

/**
 * Opens a continuous camera decoder, imported only when the scanner is shown.
 *
 * @param props - Close, scan, and cart callbacks, optional booking feedback and success event, cart sheet, and scanner presentation.
 * @returns An accessible camera dialog for booking or catalog barcode capture.
 */
export function KioskScanner({ onClose, onScan, feedback, feedbackTone = 'default', success, mode = 'booking', embedded = false, cart, cartExpanded = false, onCollapseCart, initialScanKey, resolveScanKey, isScanBlocked }: KioskScannerProps) {
  const { t } = useTranslation();
  const isBarcodeCapture = mode === 'barcodeCapture';
  const title = t(isBarcodeCapture ? 'kiosk.barcodeCaptureTitle' : 'kiosk.scannerTitle');
  const videoRef = useRef<HTMLVideoElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useScannerViewport(dialogRef, embedded || isBarcodeCapture);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const callbackRef = useRef(onScan);
  const closeCallbackRef = useRef(onClose);
  const regionRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef({ resolveScanKey, isScanBlocked, onCollapseCart });
  const [gates] = useState(() => ({ product: new ScanRearm(initialScanKey), feedback: new ScanRearm() }));
  const [ambiguous, setAmbiguous] = useState(false);
  const cameraError = t(isBarcodeCapture ? 'kiosk.barcodeCameraUnavailable' : 'kiosk.cameraUnavailable');
  const [error, setError] = useState('');
  const [dismissedSuccessId, setDismissedSuccessId] = useState<number | null>(null);
  const visibleSuccess = success && success.id !== dismissedSuccessId ? success : null;
  const feedbackClassName = `${styles.feedback} ${feedbackTone === 'warning' ? styles.feedbackWarning : feedbackTone === 'error' ? styles.feedbackError : ''}`;
  const feedbackRole = feedbackTone === 'default' ? 'status' : 'alert';

  useEffect(() => { callbackRef.current = onScan; }, [onScan]);
  useEffect(() => { closeCallbackRef.current = onClose; }, [onClose]);
  useEffect(() => { optionsRef.current = { resolveScanKey, isScanBlocked, onCollapseCart }; }, [resolveScanKey, isScanBlocked, onCollapseCart]);
  useEffect(() => {
    if (!success) return undefined;
    const timeout = window.setTimeout(() => setDismissedSuccessId(success.id), SCAN_SUCCESS_DURATION_MS);
    return () => window.clearTimeout(timeout);
  }, [success]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog) return;
    if (embedded) dialog.show();
    else dialog.showModal();
    if (previouslyFocused && dialog.contains(previouslyFocused) && previouslyFocused.matches('input, textarea, select')) previouslyFocused.focus();
    else closeButtonRef.current?.focus();
    const cancel = (event: Event) => { event.preventDefault(); closeCallbackRef.current(); };
    dialog.addEventListener('cancel', cancel);
    return () => {
      dialog.removeEventListener('cancel', cancel);
      dialog.close();
      previouslyFocused?.focus();
    };
  }, [embedded]);

  useEffect(() => {
    const video = videoRef.current;
    const region = regionRef.current;
    if (!video || !region) return;
    const suspend = () => { gates.product.suspend(); gates.feedback.suspend(); };
    return startKioskCamera({
      video, region, barcodeOnly: isBarcodeCapture,
      isBlocked: () => Boolean(optionsRef.current.isScanBlocked?.()),
      onReady: () => setError(''),
      onError: () => setError(cameraError),
      onSuspend: suspend,
      onCodes: (codes) => {
        if (document.hidden || optionsRef.current.isScanBlocked?.()) { suspend(); return; }
        const candidates = codes.filter(({ format }) => !isBarcodeCapture || isLinearFormat(format));
        setAmbiguous(candidates.length > 1);
        if (candidates.length > 1) { suspend(); return; }
        const now = performance.now();
        if (!candidates.length) { gates.product.missing(now); gates.feedback.missing(now); return; }
        const { value, format } = candidates[0];
        const rawKey = `${format}:${value}`;
        const resolveKey = optionsRef.current.resolveScanKey;
        const key = resolveKey ? resolveKey(value, format) : rawKey;
        const gate = key === undefined ? gates.feedback : gates.product;
        if (gate.accept(key ?? rawKey, now)) callbackRef.current(value, format);
      },
    });
  }, [gates, isBarcodeCapture, cameraError]);

  return <dialog aria-label={title} className={`${styles.overlay} ${embedded ? styles.embedded : ''} ${isBarcodeCapture ? styles.barcodeCapture : ''}`} data-kiosk-embedded={embedded || undefined} ref={dialogRef}>
    <div className={styles.header}><div><ScanLine aria-hidden="true" size={24} /><strong>{title}</strong></div><button aria-label={t('common.close')} className={styles.close} onClick={onClose} ref={closeButtonRef} type="button"><X size={24} /></button></div>
    <div className={styles.viewport} onClick={cartExpanded ? onCollapseCart : undefined}>
      <video autoPlay muted playsInline ref={videoRef} />
      <div aria-hidden="true" className={styles.reticle} data-scan-region ref={regionRef} />
    </div>
    <div className={styles.footer}>
      <p className={styles.keyboardHint}>{t('kiosk.editingPaused')}</p>
      <div className={styles.formatLabels}>
        {!isBarcodeCapture ? <span><QrCode aria-hidden="true" size={22} />QR-Code</span> : null}
        <span><Barcode aria-hidden="true" size={24} />Barcode</span>
      </div>
      <div className={styles.scanMessage}>
        {error ? <p className={styles.error} role="alert">{error}</p>
          : ambiguous ? <p className={styles.feedbackWarning} role="status">{t('kiosk.multipleCodes')}</p>
          : feedback ? <p className={feedbackClassName} role={feedbackRole}>{feedback}</p>
          : visibleSuccess ? <p className={styles.successNotice} role="status"><Check aria-hidden="true" size={22} /><strong>{visibleSuccess.message}</strong></p>
          : <p>{t(isBarcodeCapture ? 'kiosk.barcodeCaptureHint' : 'kiosk.scannerHint')}</p>}
      </div>
    </div>
    {cart ? <div className={styles.scannerCart}>{cart}</div> : null}
  </dialog>;
}
