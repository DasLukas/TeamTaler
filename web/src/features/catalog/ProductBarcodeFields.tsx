import Camera from 'lucide-react/dist/esm/icons/camera';
import Plus from 'lucide-react/dist/esm/icons/plus';
import X from 'lucide-react/dist/esm/icons/x';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProductBarcode, ProductBarcodeFormat } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { SelectMenu } from '@/components/ui/SelectMenu';
import { validateProductBarcodes } from './productBarcodeValidation';
import styles from './ProductBarcodeFields.module.css';

const BARCODE_FORMATS: readonly ProductBarcodeFormat[] = ['EAN_8', 'EAN_13', 'UPC_A', 'UPC_E', 'CODE_128'];
const BARCODE_ENCODERS: Record<ProductBarcodeFormat, string> = {
  EAN_8: 'ean8', EAN_13: 'ean13', UPC_A: 'upca', UPC_E: 'upce', CODE_128: 'code128',
};

/** Controlled catalog barcode editor properties. */
export interface ProductBarcodeFieldsProps {
  barcodes: ProductBarcode[];
  onChange: (barcodes: ProductBarcode[]) => void;
  disabled: boolean;
  onCapture: () => void;
  serverError?: { index: number; message: string };
}

interface BarcodePreviewProps {
  barcode: ProductBarcode;
  number: number;
}

/** Lazily draws a validated, scannable barcode without injecting SVG markup. */
function BarcodePreview({ barcode, number }: BarcodePreviewProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const value = barcode.value.trim();
  const renderKey = `${barcode.format}:${value}`;
  const [outcome, setOutcome] = useState({ key: '', error: false });
  const current = outcome.key === renderKey;

  useEffect(() => {
    let cancelled = false;
    void import('@bwip-js/browser').then(({ toCanvas }) => {
      if (cancelled || !canvasRef.current) return;
      toCanvas(canvasRef.current, {
        bcid: BARCODE_ENCODERS[barcode.format],
        text: value,
        scale: 2,
        height: 11,
        includetext: true,
        textxalign: 'center',
        backgroundcolor: 'FFFFFF',
        paddingwidth: 12,
      });
      setOutcome({ key: renderKey, error: false });
    }).catch(() => {
      if (!cancelled) setOutcome({ key: renderKey, error: true });
    });
    return () => { cancelled = true; };
  }, [barcode.format, renderKey, value]);

  return <div className={styles.preview}>
    <span className={styles.previewCaption}>{t('kiosk.barcodePreviewTitle')}</span>
    <div className={styles.previewScroll}>
      <canvas aria-label={t('kiosk.barcodePreview', { number })} className={current && !outcome.error ? styles.previewCanvas : styles.previewPending} ref={canvasRef} role="img" />
      {current && outcome.error ? <span className={styles.previewError}>{t('kiosk.barcodePreviewUnavailable')}</span> : null}
      {!current ? <span aria-hidden="true" className={styles.previewSkeleton} /> : null}
    </div>
  </div>;
}

/**
 * Edits up to fifty catalog barcodes with immediate server-equivalent validation.
 *
 * Live previews load the browser barcode encoder only for valid rows. The
 * component is controlled so a parent product form owns persistence and the
 * camera dialog.
 *
 * @param props - Current barcodes, change callback, disabled state, camera action, and optional server error.
 * @returns Barcode inputs with inline errors and scannable previews.
 */
export function ProductBarcodeFields({ barcodes, onChange, disabled, onCapture, serverError }: ProductBarcodeFieldsProps) {
  const { t } = useTranslation();
  const id = useId();
  const issues = validateProductBarcodes(barcodes);
  const formatOptions = BARCODE_FORMATS.map((format) => ({ label: format.replace('_', '-'), value: format }));
  const update = (index: number, barcode: ProductBarcode) => onChange(barcodes.map((item, itemIndex) => itemIndex === index ? barcode : item));
  const remove = (index: number) => {
    onChange(barcodes.filter((_, itemIndex) => itemIndex !== index));
  };

  return <section aria-label={t('kiosk.productBarcodes')} className={styles.root}>
    <header className={styles.heading}><div><strong>{t('kiosk.productBarcodes')}</strong><p>{t('kiosk.barcodeHint')}</p></div><span>{barcodes.length}/50</span></header>
    <div className={styles.list}>
      {barcodes.map((barcode, index) => {
        const number = index + 1;
        const issue = issues[index];
        const message = issue && barcode.value.trim() ? t(`kiosk.barcodeErrors.${issue}`) : serverError?.index === index ? serverError.message : null;
        const showIssue = Boolean(message);
        const errorId = `${id}-barcode-error-${index}`;
        return <div className={`${styles.item} ${showIssue ? styles.invalid : ''}`} key={index}>
          <div className={styles.row}>
            <span className={styles.number}>{String(number).padStart(2, '0')}</span>
            <SelectMenu<ProductBarcodeFormat> ariaLabel={t('kiosk.barcodeFormat', { number })} className={styles.format} disabled={disabled} id={`${id}-barcode-format-${index}`} onChange={(format) => update(index, { ...barcode, format })} options={formatOptions} value={barcode.format} />
            <div className={styles.valueField}>
              <input aria-describedby={showIssue ? errorId : undefined} aria-invalid={showIssue} aria-label={t('kiosk.barcodeValue', { number })} className={styles.value} disabled={disabled} inputMode={barcode.format === 'CODE_128' ? 'text' : 'numeric'} maxLength={80} onChange={(event) => update(index, { ...barcode, value: event.target.value })} spellCheck={false} type="text" value={barcode.value} />
              {showIssue ? <p className={styles.error} id={errorId} role="alert">{message}</p> : null}
            </div>
            <Button aria-label={t('kiosk.removeBarcode', { number })} className={styles.remove} disabled={disabled} iconOnly leadingIcon={<X size={17} />} onClick={() => remove(index)} size="small" variant="ghost">{t('common.delete')}</Button>
          </div>
          {!showIssue && barcode.value.trim() ? <BarcodePreview barcode={barcode} number={number} /> : null}
        </div>;
      })}
    </div>
    <div className={styles.actions}>
      <Button disabled={disabled || barcodes.length >= 50} leadingIcon={<Plus size={16} />} onClick={() => onChange([...barcodes, { format: 'EAN_13', value: '' }])} size="small" variant="secondary">{t('kiosk.addBarcode')}</Button>
      <Button disabled={disabled || barcodes.length >= 50} leadingIcon={<Camera size={17} />} onClick={onCapture} size="small" variant="secondary">{t('kiosk.captureBarcode')}</Button>
    </div>
  </section>;
}
