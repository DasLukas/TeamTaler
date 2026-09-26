import { useEffect, type RefObject } from 'react';

/**
 * Keeps the fullscreen scanner inside the visible viewport when a mobile keyboard opens.
 * @param dialogRef - Mounted scanner dialog receiving local CSS geometry variables.
 * @param embedded - Whether the surrounding desktop layout owns the dialog size.
 * @returns Nothing; listeners and inline geometry are removed on teardown.
 */
export function useScannerViewport(dialogRef: RefObject<HTMLDialogElement | null>, embedded: boolean): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    const dialog = dialogRef.current;
    if (!viewport || !dialog || embedded) return;
    const update = () => {
      dialog.toggleAttribute('data-scanner-keyboard', viewport.scale === 1 && window.innerHeight - viewport.height > 150);
      dialog.style.setProperty('--scanner-visible-height', `${viewport.height}px`);
      dialog.style.setProperty('--scanner-visible-top', `${Math.max(0, viewport.offsetTop)}px`);
      const input = document.activeElement;
      if (input instanceof HTMLInputElement && dialog.contains(input)) input.scrollIntoView({ block: 'nearest' });
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      dialog.removeAttribute('data-scanner-keyboard');
      dialog.style.removeProperty('--scanner-visible-height');
      dialog.style.removeProperty('--scanner-visible-top');
    };
  }, [dialogRef, embedded]);
}
