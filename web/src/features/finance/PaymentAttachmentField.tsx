import FileImage from 'lucide-react/dist/esm/icons/file-image';
import FileUp from 'lucide-react/dist/esm/icons/file-up';
import ScanLine from 'lucide-react/dist/esm/icons/scan-line';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import { lazy, Suspense, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { AttachmentMode } from '@/api/types';
import { Button } from '@/components/ui/Button';
import styles from './PaymentAttachmentField.module.css';

const ACCEPTED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const DocumentScannerWorkspace = lazy(() => import('@/components/media/document-scanner/DocumentScannerWorkspace').then((module) => ({ default: module.DocumentScannerWorkspace })));

/** Properties accepted by the shared payment-receipt selector. */
export interface PaymentAttachmentFieldProps {
  attachmentMode: AttachmentMode;
  file: File | null;
  maxBytes: number;
  onChange: (file: File | null) => void;
}

/** Renders one selected receipt and owns the lifecycle of its image preview URL. */
function PaymentAttachmentSelection({ file, onRemove }: { file: File; onRemove: () => void }) {
  const { t } = useTranslation();
  const [previewUrl] = useState(() => file.type.startsWith('image/') ? URL.createObjectURL(file) : '');
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  return <div className={styles.selection}>
    {previewUrl ? <img alt="" src={previewUrl} /> : <FileUp aria-hidden="true" size={32} />}
    <span><strong>{file.name}</strong><small>{new Intl.NumberFormat(undefined, { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 0 }).format(file.size / 1024)}</small></span>
    <Button leadingIcon={<Trash2 size={16} />} onClick={onRemove} size="small" variant="ghost">{t('common.remove', { defaultValue: 'Remove' })}</Button>
  </div>;
}

/** Selects, validates, previews, replaces, or scans one immutable payment receipt. */
export function PaymentAttachmentField({ attachmentMode, file, maxBytes, onChange }: PaymentAttachmentFieldProps) {
  const { t } = useTranslation();
  const galleryInputId = useId();
  const fileInputId = useId();
  const [scannerOpen, setScannerOpen] = useState(false);
  const [error, setError] = useState('');

  if (attachmentMode === 'OFF') return null;

  const accept = (candidate: File | null) => {
    if (!candidate) return;
    if (!ACCEPTED_MEDIA_TYPES.has(candidate.type)) {
      setError(t('paymentAttachment.invalidType', { defaultValue: 'Choose a JPEG, PNG, WebP, or PDF file.' }));
      return;
    }
    if (candidate.size <= 0 || candidate.size > maxBytes) {
      setError(t('paymentAttachment.invalidSize', { defaultValue: `The receipt must be smaller than ${Math.floor(maxBytes / 1024 / 1024)} MiB.` }));
      return;
    }
    setError('');
    onChange(candidate);
  };
  const select = (event: React.ChangeEvent<HTMLInputElement>) => {
    accept(event.currentTarget.files?.[0] ?? null);
    event.currentTarget.value = '';
  };

  return <fieldset className={styles.fieldset}>
    <legend>{t('paymentAttachment.label', { defaultValue: 'Receipt' })}{attachmentMode === 'REQUIRED' ? ' *' : ''}</legend>
    <p className={styles.hint}>{t('paymentAttachment.hint', { defaultValue: 'Add one image or PDF, or scan a multi-page document.' })}</p>
    <input accept="image/jpeg,image/png,image/webp" className={styles.hiddenInput} id={galleryInputId} onChange={select} type="file" />
    <input accept="image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf" className={styles.hiddenInput} id={fileInputId} onChange={select} type="file" />
    <div className={styles.sourceActions}>
      <Button leadingIcon={<FileImage size={17} />} onClick={() => document.getElementById(galleryInputId)?.click()} size="small" variant="secondary">{t('paymentAttachment.photoLibrary', { defaultValue: 'Photo library' })}</Button>
      <Button leadingIcon={<FileUp size={17} />} onClick={() => document.getElementById(fileInputId)?.click()} size="small" variant="secondary">{t('paymentAttachment.chooseFile', { defaultValue: 'Choose file' })}</Button>
      <Button leadingIcon={<ScanLine size={17} />} onClick={() => setScannerOpen(true)} size="small" variant="secondary">{t('paymentAttachment.scan', { defaultValue: 'Scan receipt' })}</Button>
    </div>
    {file ? <PaymentAttachmentSelection file={file} key={`${file.name}:${file.size}:${file.lastModified}:${file.type}`} onRemove={() => { setError(''); onChange(null); }} /> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {scannerOpen ? createPortal(
      <Suspense fallback={<p className={styles.hint} role="status">{t('common.loading', { defaultValue: 'Loading…' })}</p>}>
        <DocumentScannerWorkspace maxBytes={maxBytes} maxPages={20} onCancel={() => setScannerOpen(false)} onComplete={(scannedFile: File) => { setScannerOpen(false); accept(scannedFile); }} open />
      </Suspense>,
      document.body,
    ) : null}
  </fieldset>;
}
