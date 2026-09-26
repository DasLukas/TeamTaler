import { fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useScanInteractionGuard } from './useScanInteractionGuard';

afterEach(() => vi.restoreAllMocks());

it('protects held pointers, input focus and the quiet period after scrolling or keyboard input', () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  let blocked = () => false;
  function Cart() {
    const guard = useScanInteractionGuard();
    blocked = guard.isBlocked;
    return <form ref={guard.ref}><input aria-label="Price" /><button type="button">Action</button></form>;
  }
  const { container, getByLabelText, unmount } = render(<Cart />);
  const form = container.querySelector('form')!;
  expect(blocked()).toBe(false);
  fireEvent.pointerDown(form, { pointerId: 1 });
  now = 2000;
  expect(blocked()).toBe(true);
  fireEvent.pointerUp(window, { pointerId: 1 });
  now = 3199;
  expect(blocked()).toBe(true);
  now = 3200;
  expect(blocked()).toBe(false);
  getByLabelText('Price').focus();
  now = 5000;
  expect(blocked()).toBe(true);
  getByLabelText('Price').blur();
  now = 6200;
  expect(blocked()).toBe(false);
  fireEvent.scroll(form);
  expect(blocked()).toBe(true);
  now = 7400;
  expect(blocked()).toBe(false);
  fireEvent.keyDown(form, { key: 'ArrowDown' });
  expect(blocked()).toBe(true);
  unmount();
  now = 10000;
  fireEvent.pointerDown(form, { pointerId: 2 });
  expect(blocked()).toBe(false);
});
