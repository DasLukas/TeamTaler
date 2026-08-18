import X from 'lucide-react/dist/esm/icons/x';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';
import { Modal } from './Modal';
import styles from './ConfirmationDialog.module.css';

/** Properties accepted by the shared confirmation dialog. */
export interface ConfirmationDialogProps {
  cancelLabel?: string;
  confirmIcon: ReactNode;
  confirmLabel: string;
  errorMessage?: string;
  message: ReactNode;
  onClose: () => void;
  onConfirm: () => void;
  open: boolean;
  pending?: boolean;
  title: string;
  tone?: 'default' | 'danger';
}

/**
 * Renders a consistent, accessible confirmation step for an application action.
 *
 * The dialog blocks duplicate submissions while an action is pending, restores
 * focus through the shared modal primitive, and keeps destructive styling on
 * the final commit action instead of on the item-level trigger.
 *
 * @param props - Dialog copy, action callbacks, pending state, icon, and tone.
 * @returns A TeamTaler modal confirmation dialog.
 *
 * @example
 * <ConfirmationDialog
 *   confirmIcon={<Archive size={17} />}
 *   confirmLabel="Archive"
 *   message="Regular access will be disabled."
 *   onClose={closeDialog}
 *   onConfirm={archiveGroup}
 *   open={dialogOpen}
 *   title="Archive group?"
 *   tone="danger"
 * />
 */
export function ConfirmationDialog({
  cancelLabel,
  confirmIcon,
  confirmLabel,
  errorMessage,
  message,
  onClose,
  onConfirm,
  open,
  pending = false,
  title,
  tone = 'default',
}: ConfirmationDialogProps) {
  const { t } = useTranslation();
  const close = () => { if (!pending) onClose(); };

  return (
    <Modal onClose={close} open={open} title={title}>
      <div className={styles.content}>
        <div className={styles.message}>{message}</div>
        {errorMessage ? <p className={styles.error} role="alert">{errorMessage}</p> : null}
        <div className={styles.actions}>
          <Button disabled={pending} leadingIcon={<X size={17} />} onClick={close} variant="secondary">{cancelLabel ?? t('common.cancel')}</Button>
          <Button disabled={pending} leadingIcon={confirmIcon} onClick={onConfirm} variant={tone === 'danger' ? 'danger' : 'primary'}>{confirmLabel}</Button>
        </div>
      </div>
    </Modal>
  );
}
