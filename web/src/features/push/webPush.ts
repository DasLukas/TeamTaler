import { api } from '@/api/client';
import type { BrowserPushSubscriptionInput, InstanceCapabilities, PushSubscriptionDevice } from '@/api/types';

const REGISTRATION_PATH = '/service-worker.js';
const DEVICE_STATE_KEY = 'teamtaler:web-push-device:v2';
const LEGACY_DEVICE_STATE_KEY = 'teamtaler:web-push-device:v1';

interface StoredPushDeviceState {
  version: 2;
  deviceId: string;
  keyId: string;
  userId: string;
}

/** Result of an explicit browser permission and subscription request. */
export interface WebPushEnableResult {
  device: PushSubscriptionDevice;
  permission: NotificationPermission;
}

let reconciliationPromise: Promise<PushSubscriptionDevice | null> | undefined;
let registrationPromise: Promise<ServiceWorkerRegistration> | undefined;
let registrationOwner: ServiceWorkerContainer | undefined;

/** Returns whether this browser exposes every API required for standards-based Web Push. */
export function supportsWebPush(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Returns whether the current browser appears to run on iOS or iPadOS. */
export function isIOSBrowser(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

/** Returns whether the web app is running in an installed standalone window. */
export function isStandaloneWebApp(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function readStoredDevice(): StoredPushDeviceState | null {
  try {
    window.localStorage.removeItem(LEGACY_DEVICE_STATE_KEY);
    const value = window.localStorage.getItem(DEVICE_STATE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<StoredPushDeviceState>;
    if (parsed.version === 2 && typeof parsed.deviceId === 'string' && parsed.deviceId
      && typeof parsed.keyId === 'string' && parsed.keyId
      && typeof parsed.userId === 'string' && parsed.userId) {
      return { version: 2, deviceId: parsed.deviceId, keyId: parsed.keyId, userId: parsed.userId };
    }
    window.localStorage.removeItem(DEVICE_STATE_KEY);
    return null;
  } catch {
    return null;
  }
}

function storeDevice(device: PushSubscriptionDevice, keyId: string, userId: string): void {
  const value: StoredPushDeviceState = { version: 2, deviceId: device.id, keyId, userId };
  window.localStorage.setItem(DEVICE_STATE_KEY, JSON.stringify(value));
}

function forgetDevice(): void {
  window.localStorage.removeItem(DEVICE_STATE_KEY);
  window.localStorage.removeItem(LEGACY_DEVICE_STATE_KEY);
}

/**
 * Returns the locally associated server device ID for the current account.
 *
 * @param userId - Stable authenticated account identifier.
 * @returns The matching redacted device ID, or `null` for another account.
 */
export function currentWebPushDeviceId(userId: string): string | null {
  const stored = readStoredDevice();
  return stored?.userId === userId ? stored.deviceId : null;
}

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - normalized.length % 4) % 4);
  const bytes = Uint8Array.from(window.atob(normalized + padding), (character) => character.charCodeAt(0));
  return new Uint8Array(bytes.buffer);
}

function serializeSubscription(subscription: PushSubscription): BrowserPushSubscriptionInput {
  const json = subscription.toJSON();
  const auth = json.keys?.auth;
  const p256dh = json.keys?.p256dh;
  if (!json.endpoint || !auth || !p256dh) throw new Error('The browser returned an incomplete push subscription.');
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { auth, p256dh },
  };
}

function defaultDeviceLabel(): string {
  const browser = /Edg\//.test(navigator.userAgent) ? 'Edge'
    : /Firefox\//.test(navigator.userAgent) ? 'Firefox'
      : /CriOS\//.test(navigator.userAgent) || /Chrome\//.test(navigator.userAgent) ? 'Chrome'
        : /Safari\//.test(navigator.userAgent) ? 'Safari' : 'Browser';
  const device = isIOSBrowser() ? 'iPhone/iPad' : /Android/.test(navigator.userAgent) ? 'Android' : 'Computer';
  return `${browser} on ${device}`;
}

/**
 * Registers the root-scoped, push-only service worker.
 *
 * @returns The ready service-worker registration.
 * @throws When the browser cannot install the service worker.
 *
 * @example
 * ```ts
 * const registration = await registerWebPushServiceWorker();
 * const subscription = await registration.pushManager.getSubscription();
 * ```
 */
export async function registerWebPushServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!supportsWebPush()) throw new Error('Web Push is not supported by this browser.');
  if (registrationOwner !== navigator.serviceWorker) {
    registrationOwner = navigator.serviceWorker;
    registrationPromise = undefined;
  }
  registrationPromise ??= navigator.serviceWorker.register(REGISTRATION_PATH, { scope: '/' })
    .then(() => navigator.serviceWorker.ready)
    .catch((error: unknown) => {
      registrationPromise = undefined;
      throw error;
    });
  return registrationPromise;
}

async function createOrReplaceBrowserSubscription(
  registration: ServiceWorkerRegistration,
  publicKey: string,
  replace: boolean,
): Promise<PushSubscription> {
  const current = await registration.pushManager.getSubscription();
  if (current && !replace) return current;
  if (current) await current.unsubscribe();
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(publicKey) });
}

async function registerCurrentBrowser(
  capabilities: InstanceCapabilities,
  userId: string,
  requestPermission: boolean,
  label?: string,
): Promise<PushSubscriptionDevice | null> {
  userId = userId.trim();
  if (!userId || !supportsWebPush() || !capabilities.webPushAvailable || !capabilities.webPushPublicKey || !capabilities.webPushKeyId) return null;
  const permission = requestPermission ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') return null;
  const stored = readStoredDevice();
  const registration = await registerWebPushServiceWorker();
  const subscription = await createOrReplaceBrowserSubscription(
    registration,
    capabilities.webPushPublicKey,
    !stored || stored.keyId !== capabilities.webPushKeyId || stored.userId !== userId,
  );
  const device = await api.registerPushSubscription({
    label: label?.trim() || defaultDeviceLabel(),
    keyId: capabilities.webPushKeyId,
    subscription: serializeSubscription(subscription),
  });
  storeDevice(device, capabilities.webPushKeyId, userId);
  return device;
}

async function removeLocalBrowserSubscription(): Promise<void> {
  try {
    if (supportsWebPush()) {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      await subscription?.unsubscribe();
    }
  } finally {
    forgetDevice();
  }
}

async function reconcileOwnedBrowser(
  capabilities: InstanceCapabilities,
  userId: string,
  stored: StoredPushDeviceState,
): Promise<PushSubscriptionDevice | null> {
  const devices = await api.getPushSubscriptions();
  const device = devices.find((candidate) => candidate.id === stored.deviceId);
  if (!device) {
    await removeLocalBrowserSubscription().catch(() => undefined);
    return null;
  }
  if (stored.keyId === capabilities.webPushKeyId && device.current) return device;
  if (readStoredDevice()?.userId !== userId) return null;
  await api.deletePushSubscription(stored.deviceId);
  return registerCurrentBrowser(capabilities, userId, false);
}

/**
 * Requests notification permission from a direct user gesture and registers this browser.
 *
 * @param capabilities - Public VAPID metadata for the active deployment.
 * @param userId - Stable account identifier owning the explicit opt-in.
 * @param label - Optional coarse user-controlled device label.
 * @returns The registered safe device projection and granted permission.
 * @throws When permission is denied, the browser is unsupported, or registration fails.
 */
export async function enableWebPush(capabilities: InstanceCapabilities, userId: string, label?: string): Promise<WebPushEnableResult> {
  if (!supportsWebPush()) throw new Error('Web Push is not supported by this browser.');
  if (!userId.trim()) throw new Error('An authenticated account is required for Web Push.');
  const device = await registerCurrentBrowser(capabilities, userId, true, label);
  if (!device) throw new Error(Notification.permission === 'denied' ? 'Notification permission was denied.' : 'Web Push is unavailable.');
  return { device, permission: Notification.permission };
}

/**
 * Reconciles an already-authorized browser without showing a permission prompt.
 *
 * @param capabilities - Current public VAPID metadata.
 * @param userId - Stable account identifier that originally granted permission.
 * @returns The reconciled device, or `null` when no prior opt-in exists.
 */
export function reconcileWebPush(capabilities: InstanceCapabilities, userId: string): Promise<PushSubscriptionDevice | null> {
  const stored = readStoredDevice();
  if (!supportsWebPush() || Notification.permission !== 'granted' || !stored || stored.userId !== userId) return Promise.resolve(null);
  reconciliationPromise ??= reconcileOwnedBrowser(capabilities, userId, stored).finally(() => { reconciliationPromise = undefined; });
  return reconciliationPromise;
}

/**
 * Removes this browser from the account and revokes its local push subscription.
 *
 * @returns Nothing. Server cleanup is attempted before the browser subscription is removed.
 */
export async function disableWebPushForCurrentBrowser(): Promise<void> {
  const stored = readStoredDevice();
  let cleanupError: unknown;
  try {
    if (stored) await api.deletePushSubscription(stored.deviceId);
  } catch (error) {
    cleanupError = error;
  }
  try {
    await removeLocalBrowserSubscription();
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError) throw cleanupError;
}

/**
 * Best-effort privacy cleanup used before an explicit logout.
 *
 * @returns Nothing; failures never prevent the authenticated session from ending.
 */
export async function detachWebPushBeforeLogout(): Promise<void> {
  try {
    await reconciliationPromise?.catch(() => undefined);
    await disableWebPushForCurrentBrowser();
  } catch {
    forgetDevice();
  }
}
