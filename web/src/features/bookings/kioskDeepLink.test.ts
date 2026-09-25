import { beforeEach, describe, expect, it } from 'vitest';
import { clearKioskProductFromUrl, consumePendingBookingPath, parseKioskBookingLink, preservePendingBookingFromHref } from './kioskDeepLink';

describe('kiosk booking QR links', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/book');
    window.sessionStorage.clear();
  });

  it('preserves a same-origin product link through login once', () => {
    const href = `${window.location.origin}/book?group=group-b&product=product-2&scan=1`;
    preservePendingBookingFromHref(href);
    expect(consumePendingBookingPath()).toBe('/book?group=group-b&product=product-2&scan=1');
    expect(consumePendingBookingPath()).toBeNull();
  });

  it('rejects foreign origins and malformed identifiers', () => {
    expect(parseKioskBookingLink('https://example.invalid/book?group=group-a&product=product-1')).toBeNull();
    expect(parseKioskBookingLink('/book?group=../admin&product=product-1')).toBeNull();
    preservePendingBookingFromHref('https://example.invalid/book?group=group-a');
    expect(consumePendingBookingPath()).toBeNull();
  });

  it('removes product and scanner flags without losing the group link', () => {
    window.history.replaceState({}, '', '/book?group=group-a&product=product-1&scan=1');
    clearKioskProductFromUrl();
    expect(window.location.pathname + window.location.search).toBe('/book?group=group-a');
  });
});
