import Download from 'lucide-react/dist/esm/icons/download';
import Eye from 'lucide-react/dist/esm/icons/eye';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { PaymentAttachmentSummary } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import styles from './PaymentAttachmentAction.module.css';

/** Properties for one protected receipt preview or download action. */
interface PaymentAttachmentActionProps {
  attachment: PaymentAttachmentSummary;
  groupId: string;
  paymentId: string;
}

/** Fetches a protected payment receipt only after an explicit user action. */
export function PaymentAttachmentAction({ attachment, groupId, paymentId }: PaymentAttachmentActionProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const isImage = attachment.mediaType.startsWith('image/');

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const open = async () => {
    setPending(true);
    setError('');
    try {
      const blob = await api.getPaymentAttachment(groupId, paymentId);
      const url = URL.createObjectURL(blob);
      if (isImage) {
        setPreviewUrl(url);
      } else {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = attachment.fileName;
        anchor.hidden = true;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('errors.requestFailed'));
    } finally {
      setPending(false);
    }
  };

  return <>
    <span className={styles.action}>
      <Button disabled={pending} leadingIcon={isImage ? <Eye size={16} /> : <Download size={16} />} onClick={() => void open()} size="small" variant="ghost">{t('paymentAttachment.action', { defaultValue: 'Receipt' })}</Button>
      {error ? <small role="alert">{error}</small> : null}
    </span>
    <Modal onClose={() => setPreviewUrl('')} open={Boolean(previewUrl)} size="workspace" title={attachment.fileName}>
      {previewUrl ? <div className={styles.preview}><img alt={attachment.fileName} src={previewUrl} /></div> : null}
    </Modal>
  </>;
}
