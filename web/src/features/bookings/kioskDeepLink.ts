const PENDING_BOOKING_KEY = 'teamtaler:pending-booking:v1';
const PENDING_BOOKING_TTL_MS = 30 * 60 * 1000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Parsed, same-origin booking destination carried by a printed QR code. */
export interface KioskBookingLink {
  groupId: string;
  productId?: string;
  scan: boolean;
}

/**
 * Validates a booking QR destination without trusting arbitrary URLs.
 *
 * @param href - Absolute or relative candidate URL.
 * @returns A bounded booking destination or null for an unrelated URL.
 */
export function parseKioskBookingLink(href: string): KioskBookingLink | null {
  try {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname !== '/book') return null;
    const groupId = url.searchParams.get('group') ?? '';
    const productId = url.searchParams.get('product') ?? undefined;
    if (!ID_PATTERN.test(groupId) || productId !== undefined && !ID_PATTERN.test(productId)) return null;
    return { groupId, productId, scan: productId !== undefined && url.searchParams.get('scan') === '1' };
  } catch {
    return null;
  }
}

/**
 * Preserves a validated QR destination through authentication once.
 *
 * @param href - Current browser address.
 * @returns Nothing; unavailable session storage does not block login.
 */
export function preservePendingBookingFromHref(href: string): void {
  const link = parseKioskBookingLink(href);
  if (!link) return;
  try {
    window.sessionStorage.setItem(PENDING_BOOKING_KEY, JSON.stringify({ ...link, createdAt: Date.now() }));
  } catch {
    // Private browsing may disable session storage.
  }
}

/**
 * Consumes one recent, validated booking destination after login.
 *
 * @returns A relative route or null when nothing valid is pending.
 */
export function consumePendingBookingPath(): string | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_BOOKING_KEY);
    window.sessionStorage.removeItem(PENDING_BOOKING_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as { groupId?: unknown; productId?: unknown; scan?: unknown; createdAt?: unknown };
    if (typeof stored.createdAt !== 'number' || stored.createdAt > Date.now() || Date.now() - stored.createdAt > PENDING_BOOKING_TTL_MS) return null;
    if (typeof stored.groupId !== 'string' || !ID_PATTERN.test(stored.groupId)) return null;
    if (stored.productId !== undefined && (typeof stored.productId !== 'string' || !ID_PATTERN.test(stored.productId))) return null;
    const query = new URLSearchParams({ group: stored.groupId });
    if (stored.productId) query.set('product', stored.productId);
    if (stored.productId && stored.scan === true) query.set('scan', '1');
    return `/book?${query.toString()}`;
  } catch {
    try { window.sessionStorage.removeItem(PENDING_BOOKING_KEY); } catch { /* Ignore unavailable storage. */ }
    return null;
  }
}

/** Removes one-shot product parameters after they have been considered. */
export function clearKioskProductFromUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('product');
  url.searchParams.delete('scan');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}
