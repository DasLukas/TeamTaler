import { renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useScannerViewport } from './useScannerViewport';

afterEach(() => { vi.unstubAllGlobals(); });

it('follows the keyboard viewport and removes geometry when returning to embedded layout', () => {
  const viewport = Object.assign(new EventTarget(), { height: 500, offsetTop: 24, scale: 1 });
  vi.stubGlobal('visualViewport', viewport);
  const dialog = document.createElement('dialog');
  const ref = { current: dialog };
  const { rerender } = renderHook(({ embedded }) => useScannerViewport(ref, embedded), { initialProps: { embedded: false } });
  expect(dialog.style.getPropertyValue('--scanner-visible-height')).toBe('500px');
  expect(dialog.style.getPropertyValue('--scanner-visible-top')).toBe('24px');
  viewport.height = 420;
  viewport.dispatchEvent(new Event('resize'));
  expect(dialog.style.getPropertyValue('--scanner-visible-height')).toBe('420px');
  expect(dialog.hasAttribute('data-scanner-keyboard')).toBe(true);
  rerender({ embedded: true });
  viewport.dispatchEvent(new Event('resize'));
  expect(dialog.style.getPropertyValue('--scanner-visible-height')).toBe('');
  expect(dialog.hasAttribute('data-scanner-keyboard')).toBe(false);
});
