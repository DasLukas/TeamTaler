/** Stable React Query keys for group-scoped notification resources. */
export const notificationKeys = {
  preferences: (groupId: string | undefined) => ['notification-preferences', groupId] as const,
};
