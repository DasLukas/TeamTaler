import { useEffect, useRef, useState } from 'react';

const MINIMUM_KEYBOARD_HEIGHT = 120;
const TEXT_INPUT_TYPES = new Set([
  'email',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'url',
]);

/** Returns whether an element can summon a software keyboard for text entry. */
function isTextEntryElement(element: Element | null): boolean {
  if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
  if (element instanceof HTMLInputElement) {
    return !element.disabled && !element.readOnly && TEXT_INPUT_TYPES.has(element.type);
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

/** Returns the current visual viewport height, falling back to the layout viewport. */
function readVisibleViewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight;
}

/** Returns the largest currently observable layout viewport height. */
function readLayoutViewportHeight(): number {
  return Math.max(
    window.innerHeight,
    document.documentElement.clientHeight,
    readVisibleViewportHeight(),
  );
}

/**
 * Tracks whether a text-entry control currently owns a substantially reduced
 * visual viewport, which indicates that a mobile software keyboard is open.
 *
 * The comparison deliberately ignores `VisualViewport.offsetTop`: iOS changes
 * that value while scrolling a focused control, even though the keyboard
 * remains visible.
 *
 * @returns Whether mobile navigation chrome should yield to the software keyboard.
 */
export function useSoftwareKeyboardVisibility(): boolean {
  const baselineHeightRef = useRef(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const visualViewport = window.visualViewport;
    let active = true;
    let focusChangeSequence = 0;
    baselineHeightRef.current = readLayoutViewportHeight();

    const synchronize = () => {
      const textEntryFocused = isTextEntryElement(document.activeElement);
      const visibleHeight = readVisibleViewportHeight();

      if (!textEntryFocused) {
        baselineHeightRef.current = readLayoutViewportHeight();
        setVisible(false);
        return;
      }

      baselineHeightRef.current = Math.max(baselineHeightRef.current, readLayoutViewportHeight());
      const heightReduction = baselineHeightRef.current - visibleHeight;
      setVisible(visualViewport ? heightReduction >= MINIMUM_KEYBOARD_HEIGHT : true);
    };

    const synchronizeAfterFocusChange = () => {
      const sequence = ++focusChangeSequence;
      queueMicrotask(() => {
        if (active && sequence === focusChangeSequence) synchronize();
      });
    };

    document.addEventListener('focusin', synchronizeAfterFocusChange);
    document.addEventListener('focusout', synchronizeAfterFocusChange);
    window.addEventListener('resize', synchronize);
    visualViewport?.addEventListener('resize', synchronize);
    visualViewport?.addEventListener('scroll', synchronize);
    synchronize();

    return () => {
      active = false;
      document.removeEventListener('focusin', synchronizeAfterFocusChange);
      document.removeEventListener('focusout', synchronizeAfterFocusChange);
      window.removeEventListener('resize', synchronize);
      visualViewport?.removeEventListener('resize', synchronize);
      visualViewport?.removeEventListener('scroll', synchronize);
    };
  }, []);

  return visible;
}
