import X from 'lucide-react/dist/esm/icons/x';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from './IconButton';
import styles from './Modal.module.css';

/** Properties accepted by the responsive modal dialog. */
export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  variant?: 'dialog' | 'sheet';
  className?: string;
}

/**
 * Renders an accessible modal that can use a compact-screen sheet style.
 *
 * @param props - Visibility, heading, close callback, content, and style mode.
 * @returns A native dialog synchronized with React state.
 */
export function Modal({ open, title, onClose, children, variant = 'dialog', className = '' }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { t } = useTranslation();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog aria-labelledby={titleId} className={`${styles.dialog} ${styles[variant]} ${className}`} onCancel={onClose} onClose={onClose} ref={dialogRef}>
      {variant === 'sheet' ? <span aria-hidden="true" className={styles.handle} /> : null}
      <header className={styles.header}>
        <h2 id={titleId}>{title}</h2>
        <IconButton label={t('dialog.close')} onClick={onClose}><X size={28} strokeWidth={1.8} /></IconButton>
      </header>
      {children}
    </dialog>
  );
}
