/** Builds the shared React Query key for one group's unread counter. */
export const notificationSummaryKey = (groupId: string) => ['notification-summary', groupId] as const;
