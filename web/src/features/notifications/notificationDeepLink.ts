const PENDING_NOTIFICATION_KEY = 'teamtaler:pending-notification:v1';
const PENDING_NOTIFICATION_TTL_MS = 30 * 60 * 1000;
const NOTIFICATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const EXPORT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Resolves a safe in-app destination for a structured-data export notification.
 *
 * @param exportId - Actor-owned opaque export identifier.
 * @param scope - Group-administrator or personal export scope.
 * @returns The matching status-panel route, or `null` for malformed input.
 */
export function dataExportPath(exportId: string, scope: 'GROUP' | 'PERSONAL'): string | null {
  if (!EXPORT_ID_PATTERN.test(exportId)) return null;
  const query = new URLSearchParams({ export: exportId });
  if (scope === 'GROUP') query.set('tab', 'exports');
  return `${scope === 'GROUP' ? '/admin' : '/account'}?${query.toString()}`;
}

/**
 * Extracts a bounded opaque notification identifier from a same-origin inbox URL.
 *
 * @param href - Absolute or relative URL to inspect.
 * @returns The validated identifier, or `null` for another route or malformed input.
 */
export function notificationIdFromHref(href: string): string | null {
  try {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname !== '/notifications') return null;
    const notificationId = url.searchParams.get('notification')?.trim() ?? '';
    return NOTIFICATION_ID_PATTERN.test(notificationId) ? notificationId : null;
  } catch {
    return null;
  }
}

/**
 * Creates the canonical authenticated inbox path for an opaque identifier.
 *
 * @param notificationId - Candidate identifier received from a push deep link.
 * @returns A safe relative path, or `null` when the identifier is invalid.
 */
export function notificationPath(notificationId: string): string | null {
  if (!NOTIFICATION_ID_PATTERN.test(notificationId)) return null;
  return `/notifications?${new URLSearchParams({ notification: notificationId }).toString()}`;
}

/**
 * Preserves only a validated opaque notification identifier across a login redirect.
 *
 * @param href - Current application URL before authentication is requested.
 * @returns Nothing; unavailable browser storage is ignored.
 */
export function preservePendingNotificationFromHref(href: string): void {
  const notificationId = notificationIdFromHref(href);
  if (!notificationId) return;
  try {
    window.sessionStorage.setItem(PENDING_NOTIFICATION_KEY, JSON.stringify({
      id: notificationId,
      createdAt: Date.now(),
    }));
  } catch {
    // Authentication remains available when private browsing blocks storage.
  }
}

/**
 * Consumes a recent one-shot notification destination after successful login.
 *
 * @returns The safe inbox path, or `null` for missing, expired, or malformed state.
 */
export function consumePendingNotificationPath(): string | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_NOTIFICATION_KEY);
    window.sessionStorage.removeItem(PENDING_NOTIFICATION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { id?: unknown; createdAt?: unknown };
    const now = Date.now();
    if (typeof value.createdAt !== 'number' || value.createdAt > now || now - value.createdAt > PENDING_NOTIFICATION_TTL_MS) return null;
    return typeof value.id === 'string' ? notificationPath(value.id) : null;
  } catch {
    try {
      window.sessionStorage.removeItem(PENDING_NOTIFICATION_KEY);
    } catch {
      // Nothing else can be cleared when storage is unavailable.
    }
    return null;
  }
}
