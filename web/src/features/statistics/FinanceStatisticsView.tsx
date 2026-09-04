import { useTranslation } from 'react-i18next';
import type { FinanceStatistics, StatisticsMeta } from '@/api/types';
import { formatSignedMoney } from '@/api/money';
import { StatePanel } from '@/components/ui/StatePanel';
import { FinanceTrendChart } from './components/FinanceTrendChart';
import { KpiCard } from './components/KpiCard';
import { formatStatisticsMoney } from './statisticsFormat';
import styles from './StatisticsViews.module.css';

/** Properties accepted by the finance statistics presentation. */
export interface FinanceStatisticsViewProps {
  data: FinanceStatistics;
  meta: StatisticsMeta;
}

/**
 * Renders the three financial values most useful to a small group.
 *
 * @param props - Server-authorized finance statistics projection.
 * @returns Exact core KPIs and the single group-level receivable trend.
 */
export function FinanceStatisticsView({ data, meta }: FinanceStatisticsViewProps) {
  const { t } = useTranslation();
  const overdueMinor = data.overdue ? BigInt(data.overdue.amount.minorUnits) : 0n;
  const hasFlows = data.series.some((point) => BigInt(point.netBookingCharges.minorUnits) !== 0n || BigInt(point.netPayments.minorUnits) !== 0n || BigInt(point.netAdjustments.minorUnits) !== 0n);
  const hasClosingTrend = data.series.length > 0 && (
    hasFlows
    || BigInt(data.flows.openingNetReceivable.minorUnits) !== 0n
    || data.series.some((point) => BigInt(point.closingNetReceivable.minorUnits) !== 0n)
  );
  const overdueAsOf = data.overdue ? new Intl.DateTimeFormat('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: meta.timezone,
  }).format(new Date(data.overdue.asOf)) : '';
  return (
    <div className={styles.view}>
      <dl aria-label={t('statistics.finance.kpiLabel')} className={`${styles.kpiGrid} ${styles.financeKpiGrid}`}>
        <KpiCard hint={t('statistics.finance.netReceivableHint')} label={t('statistics.finance.netReceivable')} value={formatSignedMoney(data.receivableSnapshot.netReceivable)} />
        {data.overdue ? <KpiCard hint={t('statistics.finance.overdueHint', {
          accounts: t('statistics.finance.overdueAccounts', { count: data.overdue.accountCount }),
          periods: t('statistics.finance.overduePeriods', { count: data.overdue.periodCount }),
          asOf: overdueAsOf,
        })} label={t('statistics.finance.overdue')} tone={overdueMinor > 0n ? 'warning' : 'default'} value={formatStatisticsMoney(data.overdue.amount)} /> : <KpiCard hint={t('statistics.finance.overdueUnavailable')} label={t('statistics.finance.overdue')} value="–" />}
      </dl>
      <dl aria-label={t('statistics.finance.breakdownLabel')} className={styles.financeBreakdown}>
        <div><dt>{t('statistics.finance.payments')}</dt><dd>{formatStatisticsMoney(data.flows.netPayments)}</dd></div>
      </dl>
      <div className={`${styles.chartGrid} ${styles.financeChartGrid}`}>
        {hasClosingTrend ? <FinanceTrendChart currency={data.currency} meta={meta} series={data.series} summary={t('statistics.finance.trendSummary')} /> : <div className={styles.chartState}><StatePanel kind="empty" message={t('statistics.finance.noSeries')} title={t('statistics.finance.trendTitle')} /></div>}
      </div>
    </div>
  );
}
