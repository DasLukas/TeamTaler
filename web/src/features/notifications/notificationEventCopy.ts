import type { TFunction } from 'i18next';
import type { ConfigurableNotificationEventType } from '@/api/types';

const EVENT_COPY_KEYS: Record<ConfigurableNotificationEventType, { description: string; label: string }> = {
  BOOKING_ASSIGNED: { label: 'notifications.preferences.events.bookingAssigned.label', description: 'notifications.preferences.events.bookingAssigned.description' },
  BOOKING_REVERSED: { label: 'notifications.preferences.events.bookingReversed.label', description: 'notifications.preferences.events.bookingReversed.description' },
  PAYMENT_RECORDED: { label: 'notifications.preferences.events.paymentRecorded.label', description: 'notifications.preferences.events.paymentRecorded.description' },
  PAYMENT_REVERSED: { label: 'notifications.preferences.events.paymentReversed.label', description: 'notifications.preferences.events.paymentReversed.description' },
  SETTLEMENT_CREATED: { label: 'notifications.preferences.events.settlementCreated.label', description: 'notifications.preferences.events.settlementCreated.description' },
  SETTLEMENT_DUE_SOON: { label: 'notifications.preferences.events.settlementDueSoon.label', description: 'notifications.preferences.events.settlementDueSoon.description' },
  SETTLEMENT_OVERDUE: { label: 'notifications.preferences.events.settlementOverdue.label', description: 'notifications.preferences.events.settlementOverdue.description' },
  PLANNING_EVENT_PUBLISHED: { label: 'notifications.preferences.events.planningPublished.label', description: 'notifications.preferences.events.planningPublished.description' },
  PLANNING_EVENT_UPDATED: { label: 'notifications.preferences.events.planningChanged.label', description: 'notifications.preferences.events.planningChanged.description' },
  PLANNING_EVENT_CANCELLED: { label: 'notifications.preferences.events.planningCancelled.label', description: 'notifications.preferences.events.planningCancelled.description' },
  PLANNING_WAITLIST_PROMOTED: { label: 'notifications.preferences.events.planningPromoted.label', description: 'notifications.preferences.events.planningPromoted.description' },
  PLANNING_SERIES_PUBLISHED: { label: 'notifications.preferences.events.planningSeriesPublished.label', description: 'notifications.preferences.events.planningSeriesPublished.description' },
  PLANNING_SERIES_UPDATED: { label: 'notifications.preferences.events.planningSeriesChanged.label', description: 'notifications.preferences.events.planningSeriesChanged.description' },
  PLANNING_SERIES_CANCELLED: { label: 'notifications.preferences.events.planningSeriesCancelled.label', description: 'notifications.preferences.events.planningSeriesCancelled.description' },
};

/**
 * Returns localized, stable UI copy for one server-catalog event type.
 *
 * @param eventType - Stable event key from the notification catalog.
 * @param t - Active i18next translation function.
 * @returns Localized label and description used consistently across policy screens.
 */
export function notificationEventCopy(eventType: ConfigurableNotificationEventType, t: TFunction) {
  const keys = EVENT_COPY_KEYS[eventType];
  return { label: t(keys.label), description: t(keys.description) };
}
