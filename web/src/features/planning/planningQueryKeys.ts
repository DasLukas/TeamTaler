/** Stable React Query keys for group-scoped planning resources. */
export const planningKeys = {
  root: (groupId: string) => ['planning', groupId] as const,
  events: (groupId: string) => ['planning', groupId, 'events'] as const,
  eventRange: (groupId: string, from: string, to: string) => ['planning', groupId, 'events', 'range', from, to] as const,
  event: (groupId: string, eventId: string) => ['planning', groupId, 'event', eventId] as const,
  participants: (groupId: string, eventId: string) => ['planning', groupId, 'event', eventId, 'participants'] as const,
  series: (groupId: string, seriesId: string) => ['planning', groupId, 'series', seriesId] as const,
  settings: (groupId: string) => ['planning', groupId, 'settings'] as const,
};
