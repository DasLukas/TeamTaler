import X from 'lucide-react/dist/esm/icons/x';
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from './IconButton';
import styles from './Modal.module.css';

/**
 * Restores focus to the element that opened a modal when it remains available.
 *
 * @param openingElementRef - Reference containing the element focused before opening.
 * @param dialog - Dialog whose focused descendants may be removed during closing.
 * @returns Nothing.
 */
function restoreOpeningFocus(openingElementRef: RefObject<HTMLElement | null>, dialog: HTMLDialogElement | null): void {
  const openingElement = openingElementRef.current;
  openingElementRef.current = null;
  if (!openingElement?.isConnected) return;

  const activeElement = document.activeElement;
  if (activeElement === openingElement) return;
  if (activeElement === document.body || activeElement === document.documentElement || (dialog?.contains(activeElement) ?? false)) {
    openingElement.focus({ preventScroll: true });
  }
}

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
  const openingElementRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const { t } = useTranslation();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      openingElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      return;
    }
    if (!open && dialog.open) {
      dialog.close();
      restoreOpeningFocus(openingElementRef, dialog);
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    return () => {
      if (dialog?.open) dialog.close();
      restoreOpeningFocus(openingElementRef, dialog);
    };
  }, []);

  return (
    <dialog
      aria-labelledby={titleId}
      className={`${styles.dialog} ${styles[variant]} ${className}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      ref={dialogRef}
    >
      {open ? (
        <>
          {variant === 'sheet' ? <span aria-hidden="true" className={styles.handle} /> : null}
          <header className={styles.header}>
            <h2 id={titleId}>{title}</h2>
            <IconButton label={t('dialog.close')} onClick={onClose}><X size={28} strokeWidth={1.8} /></IconButton>
          </header>
          {children}
        </>
      ) : null}
    </dialog>
  );
}
