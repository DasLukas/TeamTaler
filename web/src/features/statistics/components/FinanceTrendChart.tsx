import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import { useTranslation } from 'react-i18next';
import type { FinanceStatisticsSeriesPoint, StatisticsMeta } from '@/api/types';
import { ChartFrame } from './ChartFrame';
import { responsiveStatisticsChartProps, statisticsChartTheme } from './chartTheme';
import { createMoneyChartScale, formatStatisticsMoney, formatStatisticsPeriod } from '../statisticsFormat';
import styles from './StatisticsCharts.module.css';

/** Properties accepted by the closing receivable trend. */
export interface FinanceTrendChartProps {
  series: readonly FinanceStatisticsSeriesPoint[];
  meta: StatisticsMeta;
  currency: string;
  summary: string;
}

/**
 * Renders the closing net receivable trend, or an honest single-bucket snapshot.
 *
 * @param props - Exact series values, metadata, currency, and interpretation.
 * @returns A line only when a temporal trend can actually be inferred.
 */
export function FinanceTrendChart({ series, meta, currency, summary }: FinanceTrendChartProps) {
  const { t } = useTranslation();
  const scale = createMoneyChartScale(series.map((point) => point.closingNetReceivable));
  const data = series.map((point) => ({
    ...point,
    label: formatStatisticsPeriod(point.periodStart, meta.bucket, meta.timezone),
    closingCoordinate: scale.coordinate(point.closingNetReceivable),
    closingFormatted: formatStatisticsMoney(point.closingNetReceivable),
  }));
  const tableRows = data.map((point) => ({ key: point.periodStart, cells: [point.label, point.closingFormatted] }));
  const chart = data.length === 1 ? (
    <div className={styles.singleBucket}>
      <strong>{data[0].closingFormatted}</strong>
      <span>{data[0].label}</span>
      <small>{t('statistics.finance.singleBucket')}</small>
    </div>
  ) : (
    <LineChart {...responsiveStatisticsChartProps} accessibilityLayer data={data} margin={{ top: 14, right: 20, bottom: 8, left: 8 }}>
      <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
      <XAxis axisLine={false} dataKey="label" minTickGap={28} tick={{ fill: 'var(--chart-axis)', fontSize: 12 }} tickLine={false} />
      <YAxis axisLine={false} tick={{ fill: 'var(--chart-axis)', fontSize: 12 }} tickFormatter={(value) => scale.formatTick(Number(value), currency)} tickLine={false} width={76} />
      <Tooltip contentStyle={statisticsChartTheme.tooltipContent} cursor={statisticsChartTheme.cursor} formatter={(_value, _name, item) => [String(item.payload.closingFormatted), t('statistics.finance.closingReceivable')]} itemStyle={statisticsChartTheme.tooltipItem} labelStyle={statisticsChartTheme.tooltipLabel} />
      <Line dataKey="closingCoordinate" dot={{ fill: 'var(--chart-primary)', r: 3 }} isAnimationActive={false} name={t('statistics.finance.closingReceivable')} stroke="var(--chart-primary)" strokeWidth={3} type="linear" />
    </LineChart>
  );
  return (
    <ChartFrame columns={[t('statistics.chart.period'), t('statistics.finance.closingReceivable')]} rows={tableRows} summary={summary} title={t('statistics.finance.trendTitle')}>
      {chart}
    </ChartFrame>
  );
}
