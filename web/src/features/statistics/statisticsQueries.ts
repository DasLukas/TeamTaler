import type { StatisticsQuery, StatisticsRange } from '@/api/types';

/** Stable React Query keys for complete statistics snapshots. */
export const statisticsQueryKeys = {
  all: (groupId: string) => ['statistics', groupId] as const,
  dashboard: (groupId: string, query: StatisticsQuery) => [
    'statistics',
    groupId,
    query.range ?? 'SERVER_DEFAULT',
    query.from ?? null,
    query.to ?? null,
  ] as const,
};

/** Ordered preset ranges rendered by the dashboard filter. */
export const statisticsRangeOptions: readonly StatisticsRange[] = [
  'CURRENT_PERIOD',
  'LAST_30_DAYS',
  'LAST_90_DAYS',
  'LAST_12_MONTHS',
  'ALL_TIME',
  'CUSTOM',
];
