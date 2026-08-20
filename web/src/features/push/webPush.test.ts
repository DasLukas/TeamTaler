import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceCapabilities, PushSubscriptionDevice } from '@/api/types';
import { currentWebPushDeviceId, disableWebPushForCurrentBrowser, enableWebPush, reconcileWebPush } from './webPush';

const apiMock = vi.hoisted(() => ({
  deletePushSubscription: vi.fn(),
  getPushSubscriptions: vi.fn(),
  registerPushSubscription: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: apiMock }));

const capabilities: InstanceCapabilities = {
  instanceName: 'TeamTaler', maintenanceMode: false, maintenanceMessage: '', publicJoinEnabled: true,
  mediaUploadMaxBytes: 1024, attachmentUploadMaxBytes: 15 * 1024 * 1024, emailNotificationsAvailable: true,
  webPushAvailable: true, webPushPublicKey: 'BEl6pM0N4l2Z33e6pOPDT7T2YfB3_f-GY1whQ5lIFCdEEhOXyIjN7lJYYG7NFE7KqAJ2sNQxQh6YjJ3lJv9wPlM', webPushKeyId: 'key-revision-a',
};

const device: PushSubscriptionDevice = {
  id: 'device-a', label: 'Chrome on Computer', keyId: 'key-revision-a', createdAt: '2026-08-20T10:00:00Z', lastUsedAt: '2026-08-20T10:00:00Z', current: true,
};

function installBrowserPushMocks() {
  const unsubscribe = vi.fn().mockResolvedValue(true);
  const subscription = {
    toJSON: () => ({ endpoint: 'https://push.example.test/subscription', expirationTime: null, keys: { auth: 'auth-key', p256dh: 'p256dh-key' } }),
    unsubscribe,
  } as unknown as PushSubscription;
  const subscribe = vi.fn().mockResolvedValue(subscription);
  const registration = { pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe } } as unknown as ServiceWorkerRegistration;
  const serviceWorker = {
    getRegistration: vi.fn().mockResolvedValue(registration),
    ready: Promise.resolve(registration),
    register: vi.fn().mockResolvedValue(registration),
  };
  const notification = {
    permission: 'default' as NotificationPermission,
    requestPermission: vi.fn(async () => {
      notification.permission = 'granted';
      return 'granted' as NotificationPermission;
    }),
  };
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Chrome/140.0', platform: 'MacIntel', maxTouchPoints: 0, serviceWorker });
  vi.stubGlobal('PushManager', class PushManagerMock {});
  vi.stubGlobal('Notification', notification);
  return { notification, registration, serviceWorker, subscribe, subscription, unsubscribe };
}

describe('Web Push browser lifecycle', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    apiMock.registerPushSubscription.mockResolvedValue(device);
    apiMock.getPushSubscriptions.mockResolvedValue([device]);
    apiMock.deletePushSubscription.mockResolvedValue(undefined);
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('requests permission only during explicit enablement and persists only safe device metadata', async () => {
    const browser = installBrowserPushMocks();

    await expect(reconcileWebPush(capabilities, 'user-a')).resolves.toBeNull();
    expect(browser.notification.requestPermission).not.toHaveBeenCalled();
    await expect(enableWebPush(capabilities, 'user-a')).resolves.toEqual({ device, permission: 'granted' });

    expect(browser.notification.requestPermission).toHaveBeenCalledOnce();
    expect(browser.serviceWorker.register).toHaveBeenCalledWith('/service-worker.js', { scope: '/' });
    expect(apiMock.registerPushSubscription).toHaveBeenCalledWith(expect.objectContaining({
      label: 'Chrome on Computer', keyId: 'key-revision-a',
      subscription: { endpoint: 'https://push.example.test/subscription', expirationTime: null, keys: { auth: 'auth-key', p256dh: 'p256dh-key' } },
    }));
    expect(currentWebPushDeviceId('user-a')).toBe('device-a');
    expect(currentWebPushDeviceId('user-b')).toBeNull();
    const stored = window.localStorage.getItem('teamtaler:web-push-device:v2');
    expect(stored).toContain('"userId":"user-a"');
    expect(stored).not.toContain('push.example.test');
  });

  it('unsubscribes locally even when authenticated server cleanup fails', async () => {
    const browser = installBrowserPushMocks();
    await enableWebPush(capabilities, 'user-a');
    (browser.registration.pushManager.getSubscription as ReturnType<typeof vi.fn>).mockResolvedValue(browser.subscription);
    apiMock.deletePushSubscription.mockRejectedValue(new Error('network unavailable'));

    await expect(disableWebPushForCurrentBrowser()).rejects.toThrow('network unavailable');

    expect(browser.unsubscribe).toHaveBeenCalledOnce();
    expect(currentWebPushDeviceId('user-a')).toBeNull();
  });

  it('does not silently transfer consent between accounts and replaces the subscription on explicit opt-in', async () => {
    const browser = installBrowserPushMocks();
    await enableWebPush(capabilities, 'user-a');
    (browser.registration.pushManager.getSubscription as ReturnType<typeof vi.fn>).mockResolvedValue(browser.subscription);

    await expect(reconcileWebPush(capabilities, 'user-b')).resolves.toBeNull();
    expect(apiMock.registerPushSubscription).toHaveBeenCalledTimes(1);
    expect(currentWebPushDeviceId('user-b')).toBeNull();

    await enableWebPush(capabilities, 'user-b');

    expect(browser.unsubscribe).toHaveBeenCalledOnce();
    expect(browser.subscribe).toHaveBeenCalledTimes(2);
    expect(apiMock.registerPushSubscription).toHaveBeenCalledTimes(2);
    expect(currentWebPushDeviceId('user-a')).toBeNull();
    expect(currentWebPushDeviceId('user-b')).toBe('device-a');
  });

  it('removes legacy unowned device state instead of reconciling it', async () => {
    const browser = installBrowserPushMocks();
    browser.notification.permission = 'granted';
    window.localStorage.setItem('teamtaler:web-push-device:v1', JSON.stringify({ version: 1, deviceId: 'legacy-device', keyId: 'key-revision-a' }));

    await expect(reconcileWebPush(capabilities, 'user-a')).resolves.toBeNull();

    expect(window.localStorage.getItem('teamtaler:web-push-device:v1')).toBeNull();
    expect(apiMock.registerPushSubscription).not.toHaveBeenCalled();
  });

  it('honors remote device revocation instead of silently registering it again', async () => {
    const browser = installBrowserPushMocks();
    await enableWebPush(capabilities, 'user-a');
    (browser.registration.pushManager.getSubscription as ReturnType<typeof vi.fn>).mockResolvedValue(browser.subscription);
    apiMock.getPushSubscriptions.mockResolvedValue([]);

    await expect(reconcileWebPush(capabilities, 'user-a')).resolves.toBeNull();

    expect(apiMock.registerPushSubscription).toHaveBeenCalledTimes(1);
    expect(browser.unsubscribe).toHaveBeenCalledOnce();
    expect(currentWebPushDeviceId('user-a')).toBeNull();
  });

  it('replaces a current owned subscription only after a VAPID rotation', async () => {
    const browser = installBrowserPushMocks();
    await enableWebPush(capabilities, 'user-a');
    (browser.registration.pushManager.getSubscription as ReturnType<typeof vi.fn>).mockResolvedValue(browser.subscription);
    apiMock.getPushSubscriptions.mockResolvedValue([{ ...device, current: false }]);
    const rotatedDevice = { ...device, id: 'device-b', keyId: 'key-revision-b' };
    apiMock.registerPushSubscription.mockResolvedValue(rotatedDevice);

    await expect(reconcileWebPush({ ...capabilities, webPushKeyId: 'key-revision-b' }, 'user-a')).resolves.toEqual(rotatedDevice);

    expect(apiMock.deletePushSubscription).toHaveBeenCalledWith('device-a');
    expect(browser.unsubscribe).toHaveBeenCalledOnce();
    expect(browser.subscribe).toHaveBeenCalledTimes(2);
    expect(currentWebPushDeviceId('user-a')).toBe('device-b');
  });
});
