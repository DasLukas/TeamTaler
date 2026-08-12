import '@testing-library/jest-dom/vitest';
import '@/i18n';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(cleanup);

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

HTMLDialogElement.prototype.showModal ??= function showModal() {
  this.setAttribute('open', '');
};

HTMLDialogElement.prototype.close ??= function close() {
  this.removeAttribute('open');
};

Object.defineProperty(globalThis, 'createImageBitmap', {
  configurable: true,
  writable: true,
  value: vi.fn(async () => ({ close: vi.fn(), height: 100, width: 100 }) as unknown as ImageBitmap),
});

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: vi.fn(() => ({ clearRect: vi.fn(), drawImage: vi.fn() })),
});
