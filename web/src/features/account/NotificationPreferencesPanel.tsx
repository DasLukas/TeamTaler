import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import BellRing from 'lucide-react/dist/esm/icons/bell-ring';
import Pencil from 'lucide-react/dist/esm/icons/pencil';
import Save from 'lucide-react/dist/esm/icons/save';
import Smartphone from 'lucide-react/dist/esm/icons/smartphone';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import X from 'lucide-react/dist/esm/icons/x';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { InstanceCapabilities, NotificationPreferences, PushSubscriptionDevice } from '@/api/types';
import { useOptionalActiveGroup } from '@/app/useActiveGroup';
import { useInstanceCapabilities, useSession } from '@/app/useSession';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/FormField';
import { StatePanel } from '@/components/ui/StatePanel';
import { Toggle } from '@/components/ui/Toggle';
import { notificationEventCopy } from '@/features/notifications/notificationEventCopy';
import {
  disableWebPushForCurrentBrowser,
  enableWebPush,
  currentWebPushDeviceId,
  isIOSBrowser,
  isStandaloneWebApp,
  supportsWebPush,
} from '@/features/push/webPush';
import styles from './NotificationPreferencesPanel.module.css';

const PUSH_DEVICES_QUERY_KEY = ['push-subscriptions'] as const;

interface PreferenceMatrixProps {
  groupId: string;
  preferences: NotificationPreferences;
}

/** Renders and persists the current membership's independent channel choices. */
function PreferenceMatrix({ groupId, preferences }: PreferenceMatrixProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [events, setEvents] = useState(preferences.events);
  const changed = events.some((event, index) => (
    event.email !== preferences.events[index]?.email || event.push !== preferences.events[index]?.push
  ));
  const mutation = useMutation({
    mutationFn: () => api.updateNotificationPreferences(groupId, {
      version: preferences.version,
      events: events.flatMap((event, index) => {
        if (!event.enabled) return [];
        const persisted = preferences.events[index];
        const update = {
          eventType: event.eventType,
          ...(event.emailAvailable && event.email !== persisted?.email ? { email: event.email } : {}),
          ...(event.pushAvailable && event.push !== persisted?.push ? { push: event.push } : {}),
        };
        return 'email' in update || 'push' in update ? [update] : [];
      }),
    }),
    onSuccess: (persisted) => queryClient.setQueryData(['notification-preferences', groupId], persisted),
    onError: async () => { await queryClient.invalidateQueries({ queryKey: ['notification-preferences', groupId] }); },
  });
  const setChannel = (index: number, channel: 'email' | 'push', checked: boolean) => {
    setEvents((current) => current.map((event, eventIndex) => eventIndex === index ? { ...event, [channel]: checked } : event));
    mutation.reset();
  };
  return (
    <section aria-labelledby="notification-preferences-title" className={styles.card}>
      <header>
        <h2 id="notification-preferences-title">{t('notifications.preferences.title')}</h2>
        <p>{t('notifications.preferences.intro')}</p>
      </header>
      <div className={styles.tableWrapper}>
        <table className={styles.matrix}>
          <thead><tr><th>{t('notifications.preferences.event')}</th><th>{t('notifications.preferences.inApp')}</th><th>{t('notifications.preferences.email')}</th><th>{t('notifications.preferences.push')}</th></tr></thead>
          <tbody>{events.map((event, index) => {
            const copy = notificationEventCopy(event.eventType, t);
            return <tr data-disabled={!event.enabled || undefined} key={event.eventType}>
              <th scope="row"><strong>{copy.label}</strong><span>{copy.description}</span>{!event.enabled ? <small>{t('notifications.preferences.groupDisabled')}</small> : null}</th>
              <td>{event.enabled
                ? <span aria-label={t('notifications.preferences.inAppAlways')} className={styles.alwaysOn}>✓</span>
                : <span aria-label={t('notifications.preferences.groupDisabled')} className={styles.inactive}>–</span>}</td>
              <td><Toggle checked={event.email} disabled={mutation.isPending || !event.emailAvailable} label={t('notifications.preferences.emailFor', { event: copy.label })} onChange={(checked) => setChannel(index, 'email', checked)} /></td>
              <td><Toggle checked={event.push} disabled={mutation.isPending || !event.pushAvailable} label={t('notifications.preferences.pushFor', { event: copy.label })} onChange={(checked) => setChannel(index, 'push', checked)} /></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      {!preferences.channels.email ? <p className={styles.notice}>{t('notifications.preferences.emailUnavailable')}</p> : null}
      {!preferences.channels.push ? <p className={styles.notice}>{t('notifications.preferences.pushUnavailable')}</p> : null}
      <footer className={styles.footer}>
        <span>{mutation.isError ? <span className={styles.error} role="alert">{t('notifications.preferences.saveError')}</span> : mutation.isSuccess ? <span className={styles.success} role="status">{t('notifications.preferences.saved')}</span> : null}</span>
        <Button disabled={!changed || mutation.isPending} leadingIcon={<Save size={17} />} onClick={() => mutation.mutate()}>{mutation.isPending ? t('common.saving') : t('common.save')}</Button>
      </footer>
    </section>
  );
}

interface PushDeviceRowProps {
  currentDeviceId: string | null;
  device: PushSubscriptionDevice;
  onChanged: () => Promise<void>;
}

/** Renders rename and removal controls for one redacted browser device. */
function PushDeviceRow({ currentDeviceId, device, onChanged }: PushDeviceRowProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(device.label);
  const rename = useMutation({ mutationFn: () => api.renamePushSubscription(device.id, label.trim()), onSuccess: onChanged });
  const remove = useMutation({
    mutationFn: () => device.id === currentDeviceId ? disableWebPushForCurrentBrowser() : api.deletePushSubscription(device.id),
    onSuccess: onChanged,
  });
  const localizedDate = device.lastUsedAt || device.createdAt
    ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(device.lastUsedAt || device.createdAt))
    : '–';
  return <li className={styles.deviceRow}>
    <Smartphone aria-hidden="true" size={22} />
    <div>{editing
      ? <TextInput aria-label={t('notifications.devices.label')} maxLength={80} onChange={(event) => setLabel(event.target.value)} value={label} />
      : <><strong>{device.label}</strong><span>{t('notifications.devices.lastUsed', { date: localizedDate })}</span></>}
    </div>
    <div className={styles.deviceActions}>{editing
      ? <><Button disabled={!label.trim() || label.trim() === device.label || rename.isPending} leadingIcon={<Save size={15} />} onClick={() => rename.mutate()} size="small" variant="secondary">{t('common.save')}</Button><Button leadingIcon={<X size={15} />} onClick={() => { setEditing(false); setLabel(device.label); }} size="small" variant="ghost">{t('common.cancel')}</Button></>
      : <><Button leadingIcon={<Pencil size={15} />} onClick={() => setEditing(true)} size="small" variant="secondary">{t('common.edit')}</Button><Button disabled={remove.isPending} leadingIcon={<Trash2 size={15} />} onClick={() => remove.mutate()} size="small" variant="danger">{t('common.delete')}</Button></>}
    </div>
    {rename.isError || remove.isError ? <p className={styles.deviceError} role="alert">{t('notifications.devices.changeError')}</p> : null}
  </li>;
}

/** Renders explicit browser opt-in, platform guidance, and account device management. */
function PushDevices({ capabilities, userId }: { capabilities: InstanceCapabilities; userId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const supported = supportsWebPush();
  const permission = supported ? Notification.permission : 'denied';
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(() => currentWebPushDeviceId(userId));
  const devices = useQuery({ queryKey: PUSH_DEVICES_QUERY_KEY, queryFn: api.getPushSubscriptions });
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: PUSH_DEVICES_QUERY_KEY }); };
  const enable = useMutation({
    mutationFn: () => enableWebPush(capabilities, userId),
    onSuccess: async ({ device }) => { setCurrentDeviceId(device.id); await refresh(); },
  });
  const iosInstallRequired = isIOSBrowser() && !isStandaloneWebApp();
  const unavailable = !capabilities.webPushAvailable || !supported || iosInstallRequired;
  return <section aria-labelledby="push-devices-title" className={styles.card}>
    <header><h2 id="push-devices-title">{t('notifications.devices.title')}</h2><p>{t('notifications.devices.intro')}</p></header>
    <div className={styles.pushOptIn}>
      <div><strong>{t('notifications.devices.thisBrowser')}</strong></div>
      <Button disabled={unavailable || permission === 'denied' || enable.isPending || (devices.data?.length ?? 0) >= 10} leadingIcon={<BellRing size={17} />} onClick={() => enable.mutate()}>{enable.isPending ? t('notifications.devices.enabling') : t('notifications.devices.enable')}</Button>
    </div>
    {!capabilities.webPushAvailable ? <p className={styles.notice}>{t('notifications.devices.systemUnavailable')}</p> : null}
    {!supported ? <p className={styles.notice}>{t('notifications.devices.browserUnsupported')}</p> : null}
    {permission === 'denied' && supported ? <p className={styles.notice}>{t('notifications.devices.permissionDenied')}</p> : null}
    {iosInstallRequired ? <p className={styles.notice}>{t('notifications.devices.iosInstall')}</p> : null}
    {enable.isError ? <p className={styles.error} role="alert">{t('notifications.devices.enableError')}</p> : null}
    {devices.isLoading ? <StatePanel kind="loading" /> : devices.isError ? <StatePanel kind="error" message={t('notifications.devices.loadError')} /> : devices.data?.length
      ? <ul className={styles.deviceList}>{devices.data.map((device) => <PushDeviceRow currentDeviceId={currentDeviceId} device={device} key={device.id} onChanged={refresh} />)}</ul>
      : <p className={styles.empty}>{t('notifications.devices.empty')}</p>}
    <p className={styles.deviceLimit}>{t('notifications.devices.limit', { count: devices.data?.length ?? 0 })}</p>
  </section>;
}

/**
 * Loads and renders group-scoped preferences and account-wide push devices in parallel.
 *
 * @returns Account-wide devices and, when a group is active, its preference matrix.
 */
export function NotificationPreferencesPanel() {
  const { t } = useTranslation();
  const activeGroup = useOptionalActiveGroup();
  const capabilities = useInstanceCapabilities();
  const session = useSession();
  const groupId = activeGroup?.activeGroupId;
  const preferences = useQuery({
    queryKey: ['notification-preferences', groupId],
    queryFn: () => api.getNotificationPreferences(groupId as string),
    enabled: Boolean(groupId),
  });
  return <>
    {!groupId ? null : preferences.isLoading ? <div className={styles.state}><StatePanel kind="loading" /></div>
      : preferences.isError || !preferences.data ? <div className={styles.state}><StatePanel kind="error" message={t('notifications.preferences.loadError')} /></div>
        : <PreferenceMatrix groupId={groupId} key={`${groupId}:${preferences.data.version}:${Number(preferences.data.channels.email)}:${Number(preferences.data.channels.push)}`} preferences={preferences.data} />}
    <PushDevices capabilities={capabilities} key={session.user.id} userId={session.user.id} />
  </>;
}
