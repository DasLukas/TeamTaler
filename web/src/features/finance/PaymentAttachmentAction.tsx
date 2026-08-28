import Eye from 'lucide-react/dist/esm/icons/eye';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { PaymentAttachmentSummary } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { openPdfPreviewWindow, showPdfInPreviewWindow } from '@/features/shared/exportDownload';
import styles from './PaymentAttachmentAction.module.css';

/** Properties for one protected receipt preview action. */
interface PaymentAttachmentActionProps {
  attachment: PaymentAttachmentSummary;
  groupId: string;
  paymentId: string;
}

/** Fetches and previews a protected payment receipt only after an explicit user action. */
export function PaymentAttachmentAction({ attachment, groupId, paymentId }: PaymentAttachmentActionProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const isImage = attachment.mediaType.startsWith('image/');

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const loadPreview = async (previewWindow?: Window) => {
    setPending(true);
    try {
      const blob = await api.getPaymentAttachment(groupId, paymentId);
      if (isImage) {
        setPreviewUrl(URL.createObjectURL(blob));
      } else if (!previewWindow || !showPdfInPreviewWindow(previewWindow, blob, attachment.fileName)) {
        throw new Error(t('exports.table.previewClosed'));
      }
    } catch (requestError) {
      if (previewWindow && !previewWindow.closed) previewWindow.close();
      setError(requestError instanceof Error ? requestError.message : t('errors.requestFailed'));
    } finally {
      setPending(false);
    }
  };

  const open = () => {
    setError('');
    if (isImage) {
      void loadPreview();
      return;
    }
    const previewWindow = openPdfPreviewWindow(
      t('exports.table.previewTitle', { title: attachment.fileName }),
      t('exports.table.previewLoading'),
    );
    if (!previewWindow) {
      setError(t('exports.table.previewBlocked'));
      return;
    }
    void loadPreview(previewWindow);
  };

  return <>
    <span className={styles.action}>
      <Button disabled={pending} leadingIcon={<Eye size={16} />} onClick={open} size="small" variant="ghost">{t('paymentAttachment.action', { defaultValue: 'Receipt' })}</Button>
      {error ? <small role="alert">{error}</small> : null}
    </span>
    <Modal onClose={() => setPreviewUrl('')} open={Boolean(previewUrl)} size="workspace" title={attachment.fileName}>
      {previewUrl ? <div className={styles.preview}><img alt={attachment.fileName} src={previewUrl} /></div> : null}
    </Modal>
  </>;
}
