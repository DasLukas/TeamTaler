import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { isStatisticsRange, type FinanceStatistics, type Group, type MemberStatistics, type StatisticsMeta } from '@/api/types';
import { availableStatisticsViews, type StatisticsView } from '@/app/groupCapabilities';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { StatePanel } from '@/components/ui/StatePanel';
import { FinanceStatisticsView } from './FinanceStatisticsView';
import { MemberStatisticsView } from './MemberStatisticsView';
import { StatisticsStatus } from './components/StatisticsStatus';
import { statisticsQueryKeys, statisticsRangeOptions } from './statisticsQueries';
import { useStatisticsUrlState } from './statisticsUrlState';
import styles from './StatisticsPage.module.css';

type StatisticsProjection = MemberStatistics | FinanceStatistics;

/** Returns the endpoint projection independently authorized for one view. */
function loadStatistics(groupId: string, view: StatisticsView, query: Parameters<typeof api.getMemberStatistics>[1]): Promise<StatisticsProjection> {
  return view === 'members' ? api.getMemberStatistics(groupId, query) : api.getFinanceStatistics(groupId, query);
}

/** Resolves the next tab index for horizontal keyboard navigation. */
function nextTabIndex(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number, tabCount: number): number | null {
  if (event.key === 'Home') return 0;
  if (event.key === 'End') return tabCount - 1;
  if (event.key === 'ArrowRight') return (currentIndex + 1) % tabCount;
  if (event.key === 'ArrowLeft') return (currentIndex - 1 + tabCount) % tabCount;
  return null;
}

/**
 * Renders the independently authorized member and finance statistics workspace.
 *
 * React owns URL, query, and responsive layout state. Recharts remains inside
 * the lazy route and only receives presentation-ready SVG coordinates.
 *
 * @returns The active statistics view with shareable filters and freshness data.
 */
function StatisticsPageContent({ activeGroup, activeGroupId }: { activeGroup: Group; activeGroupId: string }) {
  const { t } = useTranslation();
  const availableViews = useMemo(() => availableStatisticsViews(activeGroup), [activeGroup]);
  const urlState = useStatisticsUrlState(availableViews, activeGroupId);
  const tabGroupId = useId();
  const tabRefs = useRef<Partial<Record<StatisticsView, HTMLButtonElement | null>>>({});
  const queryInput = urlState.query;
  const statisticsQuery = useQuery({
    queryKey: statisticsQueryKeys.view(activeGroupId, urlState.view, queryInput ?? { range: 'CUSTOM', from: urlState.from, to: urlState.to }),
    queryFn: () => loadStatistics(activeGroupId, urlState.view, queryInput ?? {}),
    enabled: queryInput !== null,
    placeholderData: (previousData, previousQuery) => previousQuery?.queryKey[1] === activeGroupId && previousQuery.queryKey[2] === urlState.view ? previousData : undefined,
    staleTime: 0,
    refetchInterval: false,
  });

  const resolvedPreset = statisticsQuery.data?.meta.preset;
  const normalizeResolvedRange = urlState.normalizeResolvedRange;
  useEffect(() => {
    if (resolvedPreset) normalizeResolvedRange(resolvedPreset);
  }, [normalizeResolvedRange, resolvedPreset]);

  const selectView = (view: StatisticsView) => {
    urlState.setView(view);
    window.requestAnimationFrame(() => tabRefs.current[view]?.focus());
  };
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const nextIndex = nextTabIndex(event, index, availableViews.length);
    if (nextIndex === null) return;
    event.preventDefault();
    selectView(availableViews[nextIndex]);
  };
  const changeRange = (value: string) => {
    if (isStatisticsRange(value)) urlState.setRange(value);
  };

  const renderProjection = (data: StatisticsProjection) => urlState.view === 'members'
    ? <MemberStatisticsView data={data as MemberStatistics} />
    : <FinanceStatisticsView data={data as FinanceStatistics} />;
  const meta: StatisticsMeta | undefined = statisticsQuery.data?.meta;
  const currentPeriodAvailable = meta?.currentPeriodAvailable ?? null;
  const rangeResolving = urlState.range === null;

  return (
    <Page className={styles.page} intro={t('statistics.intro')} title={t('statistics.title')} wide>
      {availableViews.length > 1 ? (
        <div aria-label={t('statistics.views.label')} className={styles.tabs} role="tablist">
          {availableViews.map((view, index) => {
            const selected = view === urlState.view;
            return (
              <button
                aria-controls={`${tabGroupId}-panel`}
                aria-selected={selected}
                className={selected ? styles.activeTab : undefined}
                id={`${tabGroupId}-${view}-tab`}
                key={view}
                onClick={() => selectView(view)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                ref={(element) => { tabRefs.current[view] = element; }}
                role="tab"
                tabIndex={selected ? 0 : -1}
                type="button"
              >
                {t(`statistics.views.${view}`)}
              </button>
            );
          })}
        </div>
      ) : null}

      <section aria-label={t('statistics.filters.label')} className={styles.filters}>
        <label className={styles.rangeField}>
          <span>{t('statistics.filters.range')}</span>
          <select
            aria-busy={rangeResolving}
            disabled={rangeResolving}
            onChange={(event) => changeRange(event.target.value)}
            value={urlState.range ?? ''}
          >
            {rangeResolving ? <option value="">{t('statistics.filters.resolvingRange')}</option> : null}
            {statisticsRangeOptions.map((range) => (
              <option disabled={range === 'CURRENT_PERIOD' && currentPeriodAvailable === false} key={range} value={range}>
                {t(`statistics.filters.ranges.${range}`)}
              </option>
            ))}
          </select>
        </label>
        {urlState.range === 'CUSTOM' ? (
          <div className={styles.customDates}>
            <label><span>{t('statistics.filters.from')}</span><input onChange={(event) => urlState.setCustomDates(event.target.value, urlState.to)} type="date" value={urlState.from} /></label>
            <label><span>{t('statistics.filters.toInclusive')}</span><input min={urlState.from || undefined} onChange={(event) => urlState.setCustomDates(urlState.from, event.target.value)} type="date" value={urlState.to} /></label>
          </div>
        ) : null}
      </section>

      <div
        aria-labelledby={availableViews.length > 1 ? `${tabGroupId}-${urlState.view}-tab` : undefined}
        className={styles.panel}
        id={`${tabGroupId}-panel`}
        role={availableViews.length > 1 ? 'tabpanel' : undefined}
        tabIndex={availableViews.length > 1 ? 0 : undefined}
      >
        {queryInput === null ? (
          <StatePanel kind="empty" message={t('statistics.filters.invalidCustomMessage')} title={t('statistics.filters.invalidCustomTitle')} />
        ) : statisticsQuery.isPending || !statisticsQuery.data ? (
          statisticsQuery.isError ? <StatePanel actionLabel={t('common.retry')} kind="error" message={t('statistics.loadError')} onAction={() => void statisticsQuery.refetch()} /> : <StatePanel kind="loading" />
        ) : (
          <div className={styles.results}>
            {meta ? <StatisticsStatus meta={meta} onRefresh={() => void statisticsQuery.refetch()} refreshing={statisticsQuery.isFetching} /> : null}
            {statisticsQuery.isError ? <p className={styles.staleWarning} role="alert">{t('statistics.refreshError')}</p> : null}
            {renderProjection(statisticsQuery.data)}
          </div>
        )}
      </div>
    </Page>
  );
}

/**
 * Remounts group-owned URL-default state when the active tenant changes.
 *
 * @returns The statistics workspace scoped to the current active group.
 */
export function StatisticsPage() {
  const { activeGroup, activeGroupId } = useActiveGroup();
  return <StatisticsPageContent activeGroup={activeGroup} activeGroupId={activeGroupId} key={activeGroupId} />;
}
