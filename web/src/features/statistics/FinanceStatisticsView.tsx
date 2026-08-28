import { useTranslation } from 'react-i18next';
import type { FinanceStatistics } from '@/api/types';
import { formatSignedMoney } from '@/api/money';
import { StatePanel } from '@/components/ui/StatePanel';
import { AccountStateChart } from './components/AccountStateChart';
import { FinanceFlowsChart } from './components/FinanceFlowsChart';
import { FinanceTrendChart } from './components/FinanceTrendChart';
import { KpiCard } from './components/KpiCard';
import { SignedCategoryChart } from './components/SignedCategoryChart';
import { createMoneyChartScale, formatStatisticsInteger, formatStatisticsMoney } from './statisticsFormat';
import styles from './StatisticsViews.module.css';

/** Properties accepted by the finance statistics presentation. */
export interface FinanceStatisticsViewProps {
  data: FinanceStatistics;
}

/**
 * Renders aggregate receivable and finance-flow statistics without member rows.
 *
 * @param props - Server-authorized finance statistics projection.
 * @returns Reconciled KPIs, time series, category, and account-state charts.
 */
export function FinanceStatisticsView({ data }: FinanceStatisticsViewProps) {
  const { t } = useTranslation();
  const reconciliationMovement = (value: FinanceStatistics['flows']['netBookingCharges']) => formatSignedMoney(value).replace(/^-/, '−');
  const netReceivableMinor = BigInt(data.receivableSnapshot.netReceivable.minorUnits);
  const totalAccounts = data.receivableSnapshot.openAccountCount + data.receivableSnapshot.balancedAccountCount + data.receivableSnapshot.creditAccountCount;
  const categoryScale = createMoneyChartScale(data.categories.map((item) => item.netBookingCharges));
  const categoryData = data.categories.map((item, index) => ({
    id: item.isOther ? `other-category-${index}` : item.categoryId,
    label: item.isOther ? t('statistics.other') : item.categoryName,
    value: categoryScale.coordinate(item.netBookingCharges),
    formattedValue: formatStatisticsMoney(item.netBookingCharges),
  }));
  const hasFlows = data.series.some((point) => BigInt(point.netBookingCharges.minorUnits) !== 0n || BigInt(point.netPayments.minorUnits) !== 0n || BigInt(point.netAdjustments.minorUnits) !== 0n);
  const hasClosingTrend = data.series.length > 0 && (
    hasFlows
    || BigInt(data.flows.openingNetReceivable.minorUnits) !== 0n
    || data.series.some((point) => BigInt(point.closingNetReceivable.minorUnits) !== 0n)
  );
  const overdueAsOf = data.overdue ? new Intl.DateTimeFormat('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: data.meta.timezone,
  }).format(new Date(data.overdue.asOf)) : '';
  return (
    <div className={styles.view}>
      <dl aria-label={t('statistics.finance.kpiLabel')} className={styles.kpiGrid}>
        <KpiCard label={t('statistics.finance.netReceivable')} tone={netReceivableMinor > 0n ? 'warning' : netReceivableMinor < 0n ? 'positive' : 'default'} value={formatSignedMoney(data.receivableSnapshot.netReceivable)} />
        <KpiCard label={t('statistics.finance.grossReceivable')} tone="warning" value={formatStatisticsMoney(data.receivableSnapshot.grossReceivable)} />
        <KpiCard label={t('statistics.finance.memberCredit')} tone="positive" value={formatStatisticsMoney(data.receivableSnapshot.memberCredit)} />
        <KpiCard label={t('statistics.finance.bookingCharges')} value={formatSignedMoney(data.flows.netBookingCharges)} />
        <KpiCard label={t('statistics.finance.payments')} value={formatStatisticsMoney(data.flows.netPayments)} />
        <KpiCard label={t('statistics.finance.adjustments')} value={formatSignedMoney(data.flows.netAdjustments)} />
        {data.overdue ? <KpiCard hint={t('statistics.finance.overdueHint', {
          accounts: t('statistics.finance.overdueAccounts', { count: data.overdue.accountCount }),
          periods: t('statistics.finance.overduePeriods', { count: data.overdue.periodCount }),
          asOf: overdueAsOf,
        })} label={t('statistics.finance.overdue')} tone="warning" value={formatStatisticsMoney(data.overdue.amount)} /> : null}
      </dl>
      <p className={styles.reconciliation}>
        <strong>{t('statistics.finance.reconciliationTitle')}</strong>
        <span>{t('statistics.finance.reconciliationFormula', {
          opening: formatStatisticsMoney(data.flows.openingNetReceivable),
          charges: reconciliationMovement(data.flows.netBookingCharges),
          payments: reconciliationMovement(data.flows.netPayments),
          adjustments: reconciliationMovement(data.flows.netAdjustments),
          closing: formatStatisticsMoney(data.flows.closingNetReceivable),
        })}</span>
      </p>
      <div className={styles.chartGrid}>
        {hasClosingTrend ? <FinanceTrendChart currency={data.currency} meta={data.meta} series={data.series} summary={t('statistics.finance.trendSummary')} /> : <div className={styles.chartState}><StatePanel kind="empty" message={t('statistics.finance.noSeries')} title={t('statistics.finance.trendTitle')} /></div>}
        {hasFlows ? <FinanceFlowsChart currency={data.currency} meta={data.meta} series={data.series} summary={t('statistics.finance.flowsSummary')} /> : <div className={styles.chartState}><StatePanel kind="empty" message={t('statistics.finance.noSeries')} title={t('statistics.finance.flowsTitle')} /></div>}
        {categoryData.some((item) => item.value !== 0) ? <SignedCategoryChart currency={data.currency} data={categoryData} scale={categoryScale} summary={t('statistics.finance.categoriesSummary')} /> : <div className={styles.chartState}><StatePanel kind="empty" message={t('statistics.finance.noCategories')} title={t('statistics.finance.categoriesTitle')} /></div>}
        {totalAccounts > 0 ? (
          <AccountStateChart
            balancedAccounts={data.receivableSnapshot.balancedAccountCount}
            creditAccounts={data.receivableSnapshot.creditAccountCount}
            openAccounts={data.receivableSnapshot.openAccountCount}
            summary={t('statistics.finance.accountStatesSummary', { total: formatStatisticsInteger(totalAccounts) })}
          />
        ) : <div className={styles.chartState}><StatePanel kind="empty" message={t('statistics.finance.noAccounts')} title={t('statistics.finance.accountStatesTitle')} /></div>}
      </div>
    </div>
  );
}
