import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Save from 'lucide-react/dist/esm/icons/save';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { GroupNotificationEventSetting, GroupNotificationSettings } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput, TextInput } from '@/components/ui/FormField';
import { StatePanel } from '@/components/ui/StatePanel';
import { Toggle } from '@/components/ui/Toggle';
import { notificationEventCopy } from '@/features/notifications/notificationEventCopy';
import { notificationKeys } from '@/features/notifications/notificationQueryKeys';
import styles from './GroupNotificationSettingsSection.module.css';

interface NotificationPolicyFormProps {
  groupId: string;
  settings: GroupNotificationSettings;
}

const NOTIFICATION_CATEGORIES = ['BOOKINGS', 'PAYMENTS', 'PLANNING', 'SETTLEMENTS'] as const;
const KNOWN_NOTIFICATION_CATEGORIES = new Set<string>(NOTIFICATION_CATEGORIES);

interface NotificationEventGroup {
  category: string;
  events: GroupNotificationEventSetting[];
}

function notificationCategory(event: GroupNotificationEventSetting): string {
  const category = event.category.toUpperCase();
  if (KNOWN_NOTIFICATION_CATEGORIES.has(category)) return category;
  if (event.eventType.startsWith('BOOKING_')) return 'BOOKINGS';
  if (event.eventType.startsWith('PAYMENT_')) return 'PAYMENTS';
  if (event.eventType.startsWith('PLANNING_')) return 'PLANNING';
  if (event.eventType.startsWith('SETTLEMENT_')) return 'SETTLEMENTS';
  return 'OTHER';
}

function groupNotificationEvents(events: GroupNotificationEventSetting[]): NotificationEventGroup[] {
  const grouped = new Map<string, GroupNotificationEventSetting[]>();
  for (const event of events) {
    const category = notificationCategory(event);
    const categoryEvents = grouped.get(category);
    if (categoryEvents) categoryEvents.push(event);
    else grouped.set(category, [event]);
  }
  return [...NOTIFICATION_CATEGORIES, 'OTHER'].flatMap((category) => {
    const categoryEvents = grouped.get(category);
    return categoryEvents ? [{ category, events: categoryEvents }] : [];
  });
}

function supportedTimezones(current: string): string[] {
  const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }).supportedValuesOf;
  const values = supportedValuesOf?.('timeZone') ?? ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'UTC'];
  return values.includes(current) ? values : [current, ...values];
}

/** Renders the optimistic-concurrency form for a loaded group notification policy. */
function NotificationPolicyForm({ groupId, settings }: NotificationPolicyFormProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [timezone, setTimezone] = useState(settings.timezone);
  const [dueSoonLeadDays, setDueSoonLeadDays] = useState(settings.dueSoonLeadDays);
  const [overdueRepeatDays, setOverdueRepeatDays] = useState(settings.overdueRepeatDays);
  const [events, setEvents] = useState(settings.events);
  const timezones = useMemo(() => supportedTimezones(settings.timezone), [settings.timezone]);
  const eventGroups = useMemo(() => groupNotificationEvents(events), [events]);
  const changed = timezone !== settings.timezone
    || dueSoonLeadDays !== settings.dueSoonLeadDays
    || overdueRepeatDays !== settings.overdueRepeatDays
    || events.some((event, index) => event.enabled !== settings.events[index]?.enabled);
  const mutation = useMutation({
    mutationFn: () => api.updateGroupNotificationSettings(groupId, {
      version: settings.version,
      timezone,
      dueSoonLeadDays,
      overdueRepeatDays,
      events: events.map((event) => ({ eventType: event.eventType, enabled: event.enabled })),
    }),
    onSuccess: async (persisted) => {
      queryClient.setQueryData(['group-notification-settings', groupId], persisted);
      await queryClient.invalidateQueries({ queryKey: notificationKeys.preferences(groupId) });
    },
    onError: async () => { await queryClient.invalidateQueries({ queryKey: ['group-notification-settings', groupId] }); },
  });
  return <section aria-labelledby="group-notification-settings-title" className={styles.card}>
    <header><h4 id="group-notification-settings-title">{t('behaviorSettings.notifications.title')}</h4><p>{t('behaviorSettings.notifications.intro')}</p></header>
    <div className={styles.eventGroups}>{eventGroups.map((group) => {
      const category = t(`behaviorSettings.notifications.categories.${group.category}`);
      return <section aria-label={t('behaviorSettings.notifications.categoryLabel', { category })} className={styles.eventGroup} key={group.category}>
        <h5>{category}</h5>
        <div className={styles.eventList}>{group.events.map((event) => {
          const copy = notificationEventCopy(event.eventType, t);
          return <div className={styles.eventRow} key={event.eventType}>
            <div><strong>{copy.label}</strong><span>{copy.description}</span></div>
            <Toggle checked={event.enabled} disabled={mutation.isPending} label={t('behaviorSettings.notifications.enableEvent', { event: copy.label })} onChange={(enabled) => { setEvents((current) => current.map((entry) => entry.eventType === event.eventType ? { ...entry, enabled } : entry)); mutation.reset(); }} />
          </div>;
        })}</div>
      </section>;
    })}</div>
    <div className={styles.reminders}>
      <Field htmlFor="notification-timezone" label={t('behaviorSettings.notifications.timezone')}><SelectInput id="notification-timezone" onChange={(event) => setTimezone(event.target.value)} value={timezone}>{timezones.map((value) => <option key={value} value={value}>{value}</option>)}</SelectInput></Field>
      <Field hint={t('behaviorSettings.notifications.leadDaysHint')} htmlFor="notification-lead-days" label={t('behaviorSettings.notifications.leadDays')}><TextInput id="notification-lead-days" max={30} min={1} onChange={(event) => setDueSoonLeadDays(event.target.valueAsNumber)} step={1} type="number" value={dueSoonLeadDays} /></Field>
      <Field hint={t('behaviorSettings.notifications.repeatDaysHint')} htmlFor="notification-repeat-days" label={t('behaviorSettings.notifications.repeatDays')}><TextInput id="notification-repeat-days" max={90} min={0} onChange={(event) => setOverdueRepeatDays(event.target.valueAsNumber)} step={1} type="number" value={overdueRepeatDays} /></Field>
    </div>
    {!settings.channels.email ? <p className={styles.notice}>{t('behaviorSettings.notifications.emailUnavailable')}</p> : null}
    {!settings.channels.push ? <p className={styles.notice}>{t('behaviorSettings.notifications.pushUnavailable')}</p> : null}
    <footer className={styles.footer}>
      <span>{mutation.isError ? <span className={styles.error} role="alert">{t('behaviorSettings.notifications.saveError')}</span> : mutation.isSuccess ? <span className={styles.success} role="status">{t('behaviorSettings.notifications.saved')}</span> : null}</span>
      <Button disabled={!changed || mutation.isPending || !timezone || !Number.isInteger(dueSoonLeadDays) || dueSoonLeadDays < 1 || dueSoonLeadDays > 30 || !Number.isInteger(overdueRepeatDays) || overdueRepeatDays < 0 || overdueRepeatDays > 90} leadingIcon={<Save size={17} />} onClick={() => mutation.mutate()}>{mutation.isPending ? t('common.saving') : t('common.save')}</Button>
    </footer>
  </section>;
}

/**
 * Loads the group event policy independently from unrelated behavior settings.
 *
 * @param props - Active group identifier.
 * @returns Policy form or a localized query state.
 */
export function GroupNotificationSettingsSection({ groupId }: { groupId: string }) {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: ['group-notification-settings', groupId], queryFn: () => api.getGroupNotificationSettings(groupId) });
  if (query.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (query.isError || !query.data) return <div className={styles.state}><StatePanel actionLabel={t('common.retry')} kind="error" message={t('behaviorSettings.notifications.loadError')} onAction={() => void query.refetch()} /></div>;
  return <NotificationPolicyForm groupId={groupId} key={`${groupId}:${query.data.version}`} settings={query.data} />;
}
