import { Bar, BarChart, CartesianGrid, XAxis } from 'recharts';
import { useTranslation } from 'react-i18next';
import type { MemberStatisticsActivityPoint, StatisticsMeta } from '@/api/types';
import { ChartFrame } from './ChartFrame';
import { responsiveStatisticsChartProps } from './chartTheme';
import { formatStatisticsInteger, formatStatisticsPeriod } from '../statisticsFormat';
import styles from './StatisticsCharts.module.css';

/** Properties accepted by the member activity trend. */
export interface MemberActivityChartProps {
  activity: readonly MemberStatisticsActivityPoint[];
  meta: StatisticsMeta;
  summary: string;
}

/**
 * Renders booked and reversed product quantities as compact grouped bucket bars.
 *
 * @param props - Server buckets, range metadata, and visible interpretation.
 * @returns A compact responsive chart with totals visible without hover.
 */
export function MemberActivityChart({ activity, meta, summary }: MemberActivityChartProps) {
  const { t } = useTranslation();
  const data = activity.map((point) => ({ ...point, label: formatStatisticsPeriod(point.periodStart, meta.bucket, meta.timezone) }));
  const postedTotal = data.reduce((total, point) => total + point.postedUnits, 0);
  const reversedTotal = data.reduce((total, point) => total + point.reversedUnits, 0);
  const onlyPoint = data[0];
  return (
    <ChartFrame
      className={styles.activityFrame}
      summary={summary}
      title={t('statistics.members.activityTitle')}
    >
      <div className={styles.activityPanel}>
        <dl className={styles.activityMetrics}>
          <div data-series="posted">
            <dt>{t('statistics.members.postedUnits')}</dt>
            <dd>{formatStatisticsInteger(postedTotal)}</dd>
            <small>{t('statistics.members.activityTotal')}</small>
          </div>
          <div data-series="reversed">
            <dt>{t('statistics.members.reversedUnits')}</dt>
            <dd>{formatStatisticsInteger(reversedTotal)}</dd>
            <small>{t('statistics.members.activityTotal')}</small>
          </div>
        </dl>
        {data.length > 1 ? (
          <>
            <p className="sr-only">{data.map((point) => t('statistics.members.activityPointSummary', {
              period: point.label,
              posted: formatStatisticsInteger(point.postedUnits),
              reversed: formatStatisticsInteger(point.reversedUnits),
            })).join(' ')}</p>
            <div aria-hidden="true" className={styles.activityPlot}>
              <BarChart {...responsiveStatisticsChartProps} barCategoryGap="35%" barGap={2} data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
              <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
              <XAxis axisLine={false} dataKey="label" minTickGap={28} tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} tickLine={false} />
              <Bar dataKey="postedUnits" fill="var(--chart-primary)" isAnimationActive={false} maxBarSize={14} radius={[3, 3, 0, 0]} />
              <Bar dataKey="reversedUnits" fill="var(--chart-negative)" isAnimationActive={false} maxBarSize={14} radius={[3, 3, 0, 0]} />
              </BarChart>
            </div>
          </>
        ) : (
          <div className={styles.activitySingleBucket} role="note">
            <strong>{onlyPoint?.label}</strong>
            <span>{t('statistics.members.activitySingleBucket')}</span>
          </div>
        )}
      </div>
    </ChartFrame>
  );
}
