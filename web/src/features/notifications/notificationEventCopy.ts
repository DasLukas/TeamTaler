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
