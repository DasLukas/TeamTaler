import type { StatisticsQuery, StatisticsRange } from '@/api/types';
import type { StatisticsView } from '@/app/groupCapabilities';

/** Stable React Query keys for all statistics projections. */
export const statisticsQueryKeys = {
  all: (groupId: string) => ['statistics', groupId] as const,
  view: (groupId: string, view: StatisticsView, query: StatisticsQuery) => [
    'statistics',
    groupId,
    view,
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
