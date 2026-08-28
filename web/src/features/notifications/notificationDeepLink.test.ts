import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumePendingNotificationPath,
  dataExportPath,
  notificationIdFromHref,
  notificationPath,
  preservePendingNotificationFromHref,
} from './notificationDeepLink';

describe('notification deep-link retention', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/notifications');
  });

  it('accepts only bounded opaque identifiers on the same-origin inbox route', () => {
    expect(notificationIdFromHref('/notifications?notification=ntf_target-1')).toBe('ntf_target-1');
    expect(notificationIdFromHref('https://external.example/notifications?notification=ntf_target')).toBeNull();
    expect(notificationIdFromHref('/account?notification=ntf_target')).toBeNull();
    expect(notificationIdFromHref('/notifications?notification=invalid%2Fid')).toBeNull();
    expect(notificationPath('invalid/id')).toBeNull();
  });

  it('routes export notifications only to their authorized status panel', () => {
    expect(dataExportPath('export_123', 'GROUP')).toBe('/admin?export=export_123&tab=exports');
    expect(dataExportPath('export_123', 'PERSONAL')).toBe('/account?export=export_123');
    expect(dataExportPath('../foreign', 'GROUP')).toBeNull();
  });

  it('preserves a valid identifier as a one-shot relative path', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    preservePendingNotificationFromHref('/notifications?notification=ntf_target');

    expect(consumePendingNotificationPath()).toBe('/notifications?notification=ntf_target');
    expect(consumePendingNotificationPath()).toBeNull();
  });

  it('discards expired or future-dated pending state', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    preservePendingNotificationFromHref('/notifications?notification=ntf_expired');
    vi.spyOn(Date, 'now').mockReturnValue(1_000 + 30 * 60 * 1_000 + 1);
    expect(consumePendingNotificationPath()).toBeNull();

    window.sessionStorage.setItem('teamtaler:pending-notification:v1', JSON.stringify({ id: 'ntf_future', createdAt: Date.now() + 1 }));
    expect(consumePendingNotificationPath()).toBeNull();
  });
});
