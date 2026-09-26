import { useCallback, useRef } from 'react';

/**
 * Protects cart interaction from background scan mutations without rerendering per event.
 * @returns A cart element ref and a synchronous predicate including the 1.2-second quiet period.
 */
export function useScanInteractionGuard() {
  const state = useRef({ element: null as HTMLFormElement | null, pointers: new Set<number>(), keys: new Set<string>(), quietUntil: 0 });
  const isBlocked = useCallback(() => {
    const current = state.current;
    const focused = document.activeElement;
    const editing = focused instanceof HTMLElement && current.element?.contains(focused)
      && focused.matches('input, textarea, select, [contenteditable="true"], [role="combobox"]');
    return Boolean(editing || current.pointers.size || current.keys.size || performance.now() < current.quietUntil);
  }, []);
  const ref = useCallback((element: HTMLFormElement | null) => {
    if (!element) return;
    const current = state.current;
    current.element = element;
    const touch = () => { current.quietUntil = performance.now() + 1_200; };
    const down = (event: PointerEvent) => { current.pointers.add(event.pointerId); touch(); };
    const up = (event: PointerEvent) => { if (current.pointers.delete(event.pointerId)) touch(); };
    const keyDown = (event: KeyboardEvent) => { current.keys.add(event.code || event.key); touch(); };
    const keyUp = (event: KeyboardEvent) => { if (current.keys.delete(event.code || event.key)) touch(); };
    const cancel = () => { current.pointers.clear(); current.keys.clear(); touch(); };
    const events = ['keydown', 'keyup', 'input', 'focusin', 'focusout', 'click', 'scroll', 'wheel'] as const;
    events.forEach((event) => element.addEventListener(event, touch, { capture: true, passive: true }));
    element.addEventListener('pointerdown', down, true);
    element.addEventListener('keydown', keyDown, true);
    window.addEventListener('keyup', keyUp, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', cancel);
    return () => {
      events.forEach((event) => element.removeEventListener(event, touch, true));
      element.removeEventListener('pointerdown', down, true);
      element.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('keyup', keyUp, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', cancel);
      current.element = null;
      current.pointers.clear();
      current.keys.clear();
    };
  }, []);
  return { ref, isBlocked };
}
