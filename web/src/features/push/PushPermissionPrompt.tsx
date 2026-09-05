import Check from 'lucide-react/dist/esm/icons/check';
import X from 'lucide-react/dist/esm/icons/x';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { InstanceCapabilities } from '@/api/types';
import { FloatingNotice } from '@/components/layout/FloatingNoticeRegion';
import { Button } from '@/components/ui/Button';
import {
  currentWebPushDeviceId,
  enableWebPush,
  isIOSBrowser,
  isStandaloneWebApp,
  supportsWebPush,
} from './webPush';
import styles from './PushPermissionPrompt.module.css';

const PUSH_ONBOARDING_STORAGE_KEY = 'teamtaler:web-push-onboarding:v1';
const MAXIMUM_STORED_USER_DECISIONS = 20;

interface StoredPushOnboardingState {
  version: 1;
  handledUserIds: string[];
}

interface PushPermissionPromptProps {
  capabilities: InstanceCapabilities;
  userId: string;
}

/** Returns the validated, bounded account decisions stored by this browser. */
function readHandledUserIds(): string[] {
  try {
    const value = window.localStorage.getItem(PUSH_ONBOARDING_STORAGE_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value) as Partial<StoredPushOnboardingState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.handledUserIds)) return [];
    return parsed.handledUserIds.filter((userId): userId is string => typeof userId === 'string' && Boolean(userId));
  } catch {
    return [];
  }
}

/** Returns whether this account has already answered the soft permission prompt. */
function hasHandledPushOnboarding(userId: string): boolean {
  return readHandledUserIds().includes(userId);
}

/** Persists one account decision without allowing the local record to grow without bound. */
function rememberPushOnboardingDecision(userId: string): void {
  try {
    const handledUserIds = [...new Set([...readHandledUserIds(), userId])].slice(-MAXIMUM_STORED_USER_DECISIONS);
    const state: StoredPushOnboardingState = { version: 1, handledUserIds };
    window.localStorage.setItem(PUSH_ONBOARDING_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The in-memory decision still prevents repeated prompts during this session.
  }
}

/**
 * Offers account-scoped Web Push onboarding before requesting native browser permission.
 *
 * @param props - Authenticated user identity and effective public Web Push capabilities.
 * @returns A compact bottom-center banner when this browser can subscribe for the account.
 */
export function PushPermissionPrompt({ capabilities, userId }: PushPermissionPromptProps) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(() => hasHandledPushOnboarding(userId));
  const [neverAskAgain, setNeverAskAgain] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const supported = supportsWebPush();
  const permission = supported ? Notification.permission : 'denied';
  const iosInstallRequired = supported && isIOSBrowser() && !isStandaloneWebApp();
  const alreadyRegistered = supported && currentWebPushDeviceId(userId) !== null;
  const available = capabilities.webPushAvailable
    && Boolean(capabilities.webPushPublicKey)
    && Boolean(capabilities.webPushKeyId);
  const open = !dismissed && available && supported && !iosInstallRequired && !alreadyRegistered
    && (permission !== 'denied' || failed);

  const close = (remember: boolean) => {
    if (remember) rememberPushOnboardingDecision(userId);
    setDismissed(true);
  };

  const decline = () => close(neverAskAgain);

  const allow = () => {
    setPending(true);
    setFailed(false);
    void enableWebPush(capabilities, userId)
      .then(() => close(true))
      .catch(() => {
        setFailed(true);
        setPending(false);
        if (neverAskAgain && Notification.permission !== 'granted') rememberPushOnboardingDecision(userId);
      });
  };

  const permissionDenied = failed && Notification.permission === 'denied';
  const permissionDismissed = failed && Notification.permission === 'default';
  const permissionNotGranted = permissionDenied || permissionDismissed;

  if (!open) return null;

  return (
    <FloatingNotice>
      <aside aria-labelledby="push-permission-title" aria-live="polite" className={styles.notice} role="region">
        <div className={styles.content}>
          <strong id="push-permission-title">{t('pushOnboarding.title')}</strong>
          <label className={styles.preference}>
            <input checked={neverAskAgain} disabled={pending} onChange={(event) => setNeverAskAgain(event.target.checked)} type="checkbox" />
            <span>{t('pushOnboarding.neverAskAgain')}</span>
          </label>
        </div>
        <div className={styles.actions}>
        {permissionNotGranted ? (
          <Button leadingIcon={<X size={17} />} onClick={decline} variant="secondary">{t('pushOnboarding.close')}</Button>
        ) : (
          <>
            <Button disabled={pending} leadingIcon={<X size={17} />} onClick={decline} variant="secondary">{t('pushOnboarding.decline')}</Button>
            <Button disabled={pending} leadingIcon={<Check size={17} />} onClick={allow}>{t('pushOnboarding.allow')}</Button>
          </>
        )}
        </div>
        {failed ? <p className={styles.error} role="alert">{t(permissionDenied
          ? 'pushOnboarding.permissionDenied'
          : permissionDismissed ? 'pushOnboarding.permissionDismissed' : 'pushOnboarding.enableError')}</p> : null}
      </aside>
    </FloatingNotice>
  );
}
