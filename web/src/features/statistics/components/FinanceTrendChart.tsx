import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { useTranslation } from 'react-i18next';
import type { FinanceStatisticsSeriesPoint, StatisticsMeta } from '@/api/types';
import { ChartFrame } from './ChartFrame';
import { responsiveStatisticsChartProps } from './chartTheme';
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
  const first = data[0];
  const latest = data.at(-1);
  const chart = data.length === 1 ? (
    <div className={styles.singleBucket}>
      <strong>{data[0].closingFormatted}</strong>
      <span>{data[0].label}</span>
      <small>{t('statistics.finance.singleBucket')}</small>
    </div>
  ) : (
    <div className={styles.financeTrendPanel}>
      <p className="sr-only">{data.map((point) => t('statistics.finance.trendPointSummary', { period: point.label, value: point.closingFormatted })).join(' ')}</p>
      <div aria-hidden="true" className={styles.financeTrendPlot}>
        <LineChart {...responsiveStatisticsChartProps} data={data} margin={{ top: 10, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis axisLine={false} dataKey="label" minTickGap={32} tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} tickLine={false} />
          <YAxis axisLine={false} tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} tickFormatter={(value) => scale.formatTick(Number(value), currency)} tickLine={false} width={72} />
          <Line dataKey="closingCoordinate" dot={false} isAnimationActive={false} name={t('statistics.finance.closingReceivable')} stroke="var(--chart-primary)" strokeWidth={2.5} type="linear" />
        </LineChart>
      </div>
      <dl className={styles.financeTrendValues}>
        <div><dt>{t('statistics.finance.start')}</dt><dd>{first.closingFormatted}</dd></div>
        <div><dt>{t('statistics.finance.current')}</dt><dd>{latest?.closingFormatted}</dd></div>
      </dl>
    </div>
  );
  return (
    <ChartFrame className={styles.financeTrendFrame} summary={summary} title={t('statistics.finance.trendTitle')}>
      {chart}
    </ChartFrame>
  );
}
