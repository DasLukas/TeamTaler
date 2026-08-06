import { createContext, useContext } from 'react';

/** Shared unread count populated once by the authenticated application shell. */
export const NotificationSummaryContext = createContext(0);

/** Returns the shared exact unread notification count for navigation badges. */
export function useUnreadNotificationCount(): number {
  return useContext(NotificationSummaryContext);
}
