import X from 'lucide-react/dist/esm/icons/x';
import { useEffect, useId, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, type TouchEvent as ReactTouchEvent } from 'react';
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
  const dragRef = useRef<{ pointerId: number; startY: number; startTime: number; moved: boolean } | null>(null);
  const mouseDragCleanupRef = useRef<(() => void) | null>(null);
  const closingTimerRef = useRef<number | undefined>(undefined);
  const suppressHandleClickRef = useRef(false);
  const titleId = useId();
  const { t } = useTranslation();

  const clearDragTransform = () => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    delete dialog.dataset.dragging;
    dialog.style.removeProperty('transform');
  };

  const closeSheet = () => {
    const dialog = dialogRef.current;
    if (!dialog || closingTimerRef.current !== undefined) return;
    delete dialog.dataset.dragging;
    dialog.dataset.closing = 'true';
    dialog.style.transform = `translateY(${dialog.getBoundingClientRect().height + 24}px)`;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    closingTimerRef.current = window.setTimeout(() => {
      closingTimerRef.current = undefined;
      onClose();
    }, reducedMotion ? 0 : 220);
  };

  const startSheetDragAt = (pointerId: number, clientY: number) => {
    dragRef.current = { pointerId, startY: clientY, startTime: performance.now(), moved: false };
  };

  const moveSheetDragAt = (pointerId: number, clientY: number, preventDefault: () => void) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    const distance = Math.max(0, clientY - drag.startY);
    if (distance > 3) {
      drag.moved = true;
      preventDefault();
    }
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.dataset.dragging = 'true';
    dialog.style.transform = `translateY(${distance}px)`;
  };

  const finishSheetDragAt = (pointerId: number, clientY: number, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    const distance = Math.max(0, clientY - drag.startY);
    const duration = Math.max(1, performance.now() - drag.startTime);
    const shouldClose = !cancelled && (distance >= 64 || (distance >= 28 && distance / duration >= 0.45));
    suppressHandleClickRef.current = drag.moved;
    if (drag.moved) window.setTimeout(() => { suppressHandleClickRef.current = false; }, 0);
    dragRef.current = null;
    if (shouldClose) closeSheet();
    else clearDragTransform();
  };

  const startSheetDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    startSheetDragAt(event.pointerId, event.clientY);
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic pointer events may not have an active platform pointer to capture.
    }
  };

  const moveSheetDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    moveSheetDragAt(event.pointerId, event.clientY, () => event.preventDefault());
  };

  const finishSheetDrag = (event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    finishSheetDragAt(event.pointerId, event.clientY, cancelled);
  };

  const startMouseSheetDrag = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || dragRef.current) return;
    mouseDragCleanupRef.current?.();
    startSheetDragAt(-1, event.clientY);
    const move = (moveEvent: MouseEvent) => moveSheetDragAt(-1, moveEvent.clientY, () => moveEvent.preventDefault());
    const finish = (upEvent: MouseEvent) => {
      finishSheetDragAt(-1, upEvent.clientY);
      mouseDragCleanupRef.current?.();
    };
    const cleanup = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', finish);
      mouseDragCleanupRef.current = null;
    };
    mouseDragCleanupRef.current = cleanup;
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', finish);
  };

  const startTouchSheetDrag = (event: ReactTouchEvent<HTMLButtonElement>) => {
    if (dragRef.current || event.touches.length !== 1) return;
    const touch = event.touches[0];
    startSheetDragAt(touch.identifier + 1, touch.clientY);
  };

  const moveTouchSheetDrag = (event: ReactTouchEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const touch = Array.from(event.touches).find((candidate) => candidate.identifier + 1 === drag.pointerId);
    if (!touch) return;
    moveSheetDragAt(drag.pointerId, touch.clientY, () => event.preventDefault());
  };

  const finishTouchSheetDrag = (event: ReactTouchEvent<HTMLButtonElement>, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag) return;
    const touch = Array.from(event.changedTouches).find((candidate) => candidate.identifier + 1 === drag.pointerId);
    finishSheetDragAt(drag.pointerId, touch?.clientY ?? drag.startY, cancelled);
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      openingElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      return;
    }
    if (!open && dialog.open) {
      if (closingTimerRef.current !== undefined) {
        window.clearTimeout(closingTimerRef.current);
        closingTimerRef.current = undefined;
      }
      dialog.close();
      delete dialog.dataset.closing;
      clearDragTransform();
      restoreOpeningFocus(openingElementRef, dialog);
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    return () => {
      if (closingTimerRef.current !== undefined) window.clearTimeout(closingTimerRef.current);
      mouseDragCleanupRef.current?.();
      if (dialog?.open) dialog.close();
      restoreOpeningFocus(openingElementRef, dialog);
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    const visualViewport = window.visualViewport;
    if (!open || variant !== 'sheet' || !dialog || !visualViewport) return undefined;

    const synchronizeVisualViewport = () => {
      const obscuredBottom = Math.max(0, window.innerHeight - visualViewport.offsetTop - visualViewport.height);
      dialog.style.setProperty('--modal-visual-viewport-height', `${visualViewport.height}px`);
      dialog.style.setProperty('--modal-visual-viewport-bottom', `${obscuredBottom}px`);
    };

    synchronizeVisualViewport();
    visualViewport.addEventListener('resize', synchronizeVisualViewport);
    visualViewport.addEventListener('scroll', synchronizeVisualViewport);
    return () => {
      visualViewport.removeEventListener('resize', synchronizeVisualViewport);
      visualViewport.removeEventListener('scroll', synchronizeVisualViewport);
      dialog.style.removeProperty('--modal-visual-viewport-height');
      dialog.style.removeProperty('--modal-visual-viewport-bottom');
    };
  }, [open, variant]);

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
          {variant === 'sheet' ? (
            <button
              aria-label={t('dialog.sheetHandle')}
              className={styles.sheetHandle}
              onClick={() => {
                if (suppressHandleClickRef.current) {
                  suppressHandleClickRef.current = false;
                  return;
                }
                closeSheet();
              }}
              onMouseDown={startMouseSheetDrag}
              onPointerCancel={(event) => finishSheetDrag(event, true)}
              onPointerDown={startSheetDrag}
              onPointerMove={moveSheetDrag}
              onPointerUp={finishSheetDrag}
              onTouchCancel={(event) => finishTouchSheetDrag(event, true)}
              onTouchEnd={finishTouchSheetDrag}
              onTouchMove={moveTouchSheetDrag}
              onTouchStart={startTouchSheetDrag}
              type="button"
            ><span aria-hidden="true" className={styles.handle} /></button>
          ) : null}
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
