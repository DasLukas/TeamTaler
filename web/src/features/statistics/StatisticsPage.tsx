import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/api/client';
import { isStatisticsRange, type StatisticsMeta } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { StatePanel } from '@/components/ui/StatePanel';
import tabStyles from '@/components/ui/WorkspaceTabs.module.css';
import { FinanceStatisticsView } from './FinanceStatisticsView';
import { MemberStatisticsView } from './MemberStatisticsView';
import { statisticsQueryKeys, statisticsRangeOptions } from './statisticsQueries';
import { useStatisticsUrlState } from './statisticsUrlState';
import styles from './StatisticsPage.module.css';

type StatisticsTab = 'bookings' | 'finance';

const statisticsTabs: readonly StatisticsTab[] = ['bookings', 'finance'];

/** Returns whether a failed refresh invalidates access to every cached statistic. */
function isStatisticsAccessError(error: unknown): boolean {
  return error instanceof ApiError && (error.problem.status === 401 || error.problem.status === 403);
}

/**
 * Renders the complete group statistics workspace as one authorized snapshot.
 *
 * React owns URL, query, and responsive layout state. Recharts remains inside
 * the lazy route and renders a bounded number of accessible SVG charts.
 *
 * @param props - Active group identity used for query and cache isolation.
 * @returns The single-request statistics dashboard with shareable range filters.
 */
function StatisticsPageContent({ activeGroupId }: { activeGroupId: string }) {
  const { t } = useTranslation();
  const urlState = useStatisticsUrlState(activeGroupId);
  const tabGroupId = useId();
  const tabRefs = useRef<Partial<Record<StatisticsTab, HTMLButtonElement | null>>>({});
  const [activeTab, setActiveTab] = useState<StatisticsTab>('bookings');
  const queryInput = urlState.query;
  const statisticsQuery = useQuery({
    queryKey: statisticsQueryKeys.dashboard(activeGroupId, queryInput ?? { range: 'CUSTOM', from: urlState.from, to: urlState.to }),
    queryFn: () => api.getStatistics(activeGroupId, queryInput ?? {}),
    enabled: queryInput !== null,
    placeholderData: (previousData, previousQuery) => previousQuery?.queryKey[1] === activeGroupId ? previousData : undefined,
    staleTime: 0,
    refetchInterval: false,
  });

  const resolvedPreset = statisticsQuery.data?.meta.preset;
  const normalizeResolvedRange = urlState.normalizeResolvedRange;
  useEffect(() => {
    if (resolvedPreset) normalizeResolvedRange(resolvedPreset);
  }, [normalizeResolvedRange, resolvedPreset]);

  const changeRange = (value: string) => {
    if (isStatisticsRange(value)) urlState.setRange(value);
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    let nextIndex: number | undefined;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % statisticsTabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + statisticsTabs.length) % statisticsTabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = statisticsTabs.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTab = statisticsTabs[nextIndex];
    setActiveTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  const meta: StatisticsMeta | undefined = statisticsQuery.data?.meta;
  const accessInvalidated = statisticsQuery.isError && isStatisticsAccessError(statisticsQuery.error);
  const currentPeriodAvailable = meta?.currentPeriodAvailable ?? null;
  const rangeResolving = urlState.range === null;

  return (
    <Page className={styles.page} intro={t('statistics.intro')} title={t('statistics.title')} wide>
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

      <div className={styles.panel}>
        {queryInput === null ? (
          <StatePanel kind="empty" message={t('statistics.filters.invalidCustomMessage')} title={t('statistics.filters.invalidCustomTitle')} />
        ) : accessInvalidated ? (
          <StatePanel actionLabel={t('common.retry')} kind="error" message={t('statistics.accessChangedMessage')} onAction={() => void statisticsQuery.refetch()} title={t('statistics.accessChangedTitle')} />
        ) : statisticsQuery.isPending || !statisticsQuery.data ? (
          statisticsQuery.isError ? <StatePanel actionLabel={t('common.retry')} kind="error" message={t('statistics.loadError')} onAction={() => void statisticsQuery.refetch()} /> : <StatePanel kind="loading" />
        ) : (
          <div className={styles.results}>
            {statisticsQuery.isError ? <p className={styles.staleWarning} role="alert">{t('statistics.refreshError')}</p> : null}
            <div aria-label={t('statistics.tabs.label')} aria-orientation="horizontal" className={tabStyles.tabs} role="tablist">
              {statisticsTabs.map((tab, index) => {
                const selected = activeTab === tab;
                return (
                  <button
                    aria-controls={`${tabGroupId}-panel-${tab}`}
                    aria-selected={selected}
                    className={selected ? tabStyles.activeTab : ''}
                    id={`${tabGroupId}-tab-${tab}`}
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    onKeyDown={(event) => handleTabKeyDown(event, index)}
                    ref={(element) => { tabRefs.current[tab] = element; }}
                    role="tab"
                    tabIndex={selected ? 0 : -1}
                    type="button"
                  >
                    {t(`statistics.tabs.${tab}`)}
                  </button>
                );
              })}
            </div>
            <div className={styles.sections}>
              <section
                aria-labelledby={`${tabGroupId}-tab-bookings`}
                className={`${styles.dashboardSection} ${styles.tabPanel}`}
                hidden={activeTab !== 'bookings'}
                id={`${tabGroupId}-panel-bookings`}
                role="tabpanel"
                tabIndex={activeTab === 'bookings' ? 0 : -1}
              >
                {activeTab === 'bookings' ? (
                  <>
                    <header className={styles.sectionHeading}>
                      <h2>{t('statistics.sections.members')}</h2>
                      <p>{t('statistics.sections.membersDescription')}</p>
                    </header>
                    <MemberStatisticsView data={statisticsQuery.data.members} meta={statisticsQuery.data.meta} />
                  </>
                ) : null}
              </section>
              <section
                aria-labelledby={`${tabGroupId}-tab-finance`}
                className={`${styles.dashboardSection} ${styles.tabPanel}`}
                hidden={activeTab !== 'finance'}
                id={`${tabGroupId}-panel-finance`}
                role="tabpanel"
                tabIndex={activeTab === 'finance' ? 0 : -1}
              >
                {activeTab === 'finance' ? (
                  <>
                    <header className={styles.sectionHeading}>
                      <h2>{t('statistics.sections.finance')}</h2>
                      <p>{t('statistics.sections.financeDescription')}</p>
                    </header>
                    <FinanceStatisticsView data={statisticsQuery.data.finance} meta={statisticsQuery.data.meta} />
                  </>
                ) : null}
              </section>
            </div>
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
  const { activeGroupId } = useActiveGroup();
  return <StatisticsPageContent activeGroupId={activeGroupId} key={activeGroupId} />;
}
