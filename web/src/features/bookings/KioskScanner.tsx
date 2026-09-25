import Check from 'lucide-react/dist/esm/icons/check';
import ScanLine from 'lucide-react/dist/esm/icons/scan-line';
import X from 'lucide-react/dist/esm/icons/x';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProductBarcodeFormat } from '@/api/types';
import { ScanRearm } from './kioskScan';
import styles from './KioskScanner.module.css';

/** Camera scanner properties shared by booking and catalog barcode capture. */
export interface KioskScannerProps {
  onClose: () => void;
  onScan: (value: string, format?: ProductBarcodeFormat | 'QR_CODE') => void;
  feedback?: string;
  feedbackTone?: 'default' | 'error';
  /** Product confirmation; a new id restarts the animation for repeated names. */
  success?: { id: number; message: string } | null;
  mode?: 'booking' | 'barcodeCapture';
  embedded?: boolean;
  cart?: ReactNode;
  cartExpanded?: boolean;
  onCollapseCart?: () => void;
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
export function KioskScanner({ onClose, onScan, feedback, feedbackTone = 'default', success, mode = 'booking', embedded = false, cart, cartExpanded = false, onCollapseCart }: KioskScannerProps) {
  const { t } = useTranslation();
  const isBarcodeCapture = mode === 'barcodeCapture';
  const title = t(isBarcodeCapture ? 'kiosk.barcodeCaptureTitle' : 'kiosk.scannerTitle');
  const videoRef = useRef<HTMLVideoElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const callbackRef = useRef(onScan);
  const closeCallbackRef = useRef(onClose);
  const cartExpandedRef = useRef(cartExpanded);
  const [error, setError] = useState('');
  const [dismissedSuccessId, setDismissedSuccessId] = useState<number | null>(null);
  const visibleSuccess = success && success.id !== dismissedSuccessId ? success : null;

  useEffect(() => { callbackRef.current = onScan; }, [onScan]);
  useEffect(() => { closeCallbackRef.current = onClose; }, [onClose]);
  useEffect(() => { cartExpandedRef.current = cartExpanded; }, [cartExpanded]);
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
    closeButtonRef.current?.focus();
    const cancel = (event: Event) => { event.preventDefault(); closeCallbackRef.current(); };
    dialog.addEventListener('cancel', cancel);
    return () => {
      dialog.removeEventListener('cancel', cancel);
      dialog.close();
      previouslyFocused?.focus();
    };
  }, [embedded]);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    const rearm = new ScanRearm();
    const video = videoRef.current;
    async function start() {
      if (!navigator.mediaDevices?.getUserMedia || !video) {
        setError(t(isBarcodeCapture ? 'kiosk.barcodeCameraUnavailable' : 'kiosk.cameraUnavailable'));
        return;
      }
      try {
        const [{ BrowserMultiFormatReader }, { BarcodeFormat }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
        if (disposed) return;
        const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 180 });
        reader.possibleFormats = isBarcodeCapture
          ? [BarcodeFormat.EAN_8, BarcodeFormat.EAN_13, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128]
          : [BarcodeFormat.QR_CODE, BarcodeFormat.EAN_8, BarcodeFormat.EAN_13, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128];
        const controls = await reader.decodeFromConstraints({ audio: false, video: { facingMode: { ideal: 'environment' } } }, video, (result) => {
          if (disposed || cartExpandedRef.current) return;
          const now = Date.now();
          if (!result) { rearm.missing(now); return; }
          const value = result.getText();
          const format = BarcodeFormat[result.getBarcodeFormat()] as ProductBarcodeFormat | 'QR_CODE' | undefined;
          if (isBarcodeCapture && !isLinearFormat(format)) return;
          if (rearm.accept(`${format ?? 'UNKNOWN'}:${value}`, now)) {
            callbackRef.current(value, format);
          }
        });
        if (disposed) controls.stop();
        else stop = () => controls.stop();
      } catch {
        if (!disposed) setError(t(isBarcodeCapture ? 'kiosk.barcodeCameraUnavailable' : 'kiosk.cameraUnavailable'));
      }
    }
    void start();
    return () => {
      disposed = true;
      stop?.();
      const stream = video?.srcObject;
      if (typeof MediaStream !== 'undefined' && stream instanceof MediaStream) stream.getTracks().forEach((track) => track.stop());
    };
  }, [embedded, isBarcodeCapture, t]);

  return <dialog aria-label={title} className={`${styles.overlay} ${embedded ? styles.embedded : ''} ${isBarcodeCapture ? styles.barcodeCapture : ''}`} data-kiosk-embedded={embedded || undefined} ref={dialogRef}>
    <div className={styles.header}><div><ScanLine aria-hidden="true" size={24} /><strong>{title}</strong></div><button aria-label={t('common.close')} className={styles.close} onClick={onClose} ref={closeButtonRef} type="button"><X size={24} /></button></div>
    <div className={styles.viewport} onClick={cartExpanded ? onCollapseCart : undefined}>
      <video autoPlay muted playsInline ref={videoRef} />
      {isBarcodeCapture ? <div aria-hidden="true" className={styles.reticle} /> : <div className={styles.scanGuide}>
        <div aria-hidden="true" className={`${styles.reticle} ${visibleSuccess ? styles.reticleSuccess : ''}`}>
          <span className={styles.qrFinder} />
          <span className={styles.qrFinder} />
          <span className={styles.qrFinder} />
        </div>
        <div className={styles.scanMessage}>
          <p aria-hidden={Boolean(visibleSuccess)} className={`${styles.scanHint} ${visibleSuccess ? styles.scanHintHidden : ''}`}>{t('kiosk.scannerHint')}</p>
          {visibleSuccess ? <div className={styles.successNotice} key={visibleSuccess.id} role="status">
            <span aria-hidden="true" className={styles.successMark}><Check size={30} strokeWidth={3} /></span>
            <strong>{visibleSuccess.message}</strong>
          </div> : null}
        </div>
        {feedback ? <p className={`${styles.feedback} ${feedbackTone === 'error' ? styles.feedbackError : ''}`} role={feedbackTone === 'error' ? 'alert' : 'status'}>{feedback}</p> : null}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </div>}
    </div>
    {isBarcodeCapture ? <div className={styles.footer}>
      <p>{t('kiosk.barcodeCaptureHint')}</p>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </div> : null}
    {cart ? <div className={styles.scannerCart}>{cart}</div> : null}
  </dialog>;
}
