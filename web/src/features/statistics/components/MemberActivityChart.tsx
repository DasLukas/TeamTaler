import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from 'recharts';
import { useTranslation } from 'react-i18next';
import type { MemberStatisticsActivityPoint, StatisticsMeta } from '@/api/types';
import { ChartFrame } from './ChartFrame';
import { responsiveStatisticsChartProps, statisticsChartTheme } from './chartTheme';
import { formatStatisticsInteger, formatStatisticsPeriod } from '../statisticsFormat';

/** Properties accepted by the member activity trend. */
export interface MemberActivityChartProps {
  activity: readonly MemberStatisticsActivityPoint[];
  meta: StatisticsMeta;
  summary: string;
}

/**
 * Renders posted and reversed units as grouped discrete bucket bars.
 *
 * @param props - Server buckets, range metadata, and visible interpretation.
 * @returns A responsive grouped bar chart and exact data table.
 */
export function MemberActivityChart({ activity, meta, summary }: MemberActivityChartProps) {
  const { t } = useTranslation();
  const data = activity.map((point) => ({ ...point, label: formatStatisticsPeriod(point.periodStart, meta.bucket, meta.timezone) }));
  return (
    <ChartFrame
      columns={[t('statistics.chart.period'), t('statistics.members.postedUnits'), t('statistics.members.reversedUnits')]}
      rows={data.map((point) => ({ key: point.periodStart, cells: [point.label, formatStatisticsInteger(point.postedUnits), formatStatisticsInteger(point.reversedUnits)] }))}
      summary={summary}
      title={t('statistics.members.activityTitle')}
    >
      <BarChart {...responsiveStatisticsChartProps} accessibilityLayer data={data} margin={{ top: 12, right: 18, bottom: 8, left: 0 }}>
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis axisLine={false} dataKey="label" minTickGap={28} tick={{ fill: 'var(--chart-axis)', fontSize: 12 }} tickLine={false} />
        <YAxis axisLine={false} tick={{ fill: 'var(--chart-axis)', fontSize: 12 }} tickFormatter={(value) => formatStatisticsInteger(Number(value))} tickLine={false} width={42} />
        <Tooltip contentStyle={statisticsChartTheme.tooltipContent} cursor={statisticsChartTheme.cursor} formatter={(value, name) => [formatStatisticsInteger(Number(value)), name === 'postedUnits' ? t('statistics.members.postedUnits') : t('statistics.members.reversedUnits')]} itemStyle={statisticsChartTheme.tooltipItem} labelStyle={statisticsChartTheme.tooltipLabel} />
        <Legend formatter={(value) => <span style={statisticsChartTheme.legendText}>{value === 'postedUnits' ? t('statistics.members.postedUnits') : t('statistics.members.reversedUnits')}</span>} />
        <Bar dataKey="postedUnits" fill="var(--chart-primary)" isAnimationActive={false} maxBarSize={24} radius={[4, 4, 0, 0]} />
        <Bar dataKey="reversedUnits" fill="var(--chart-negative)" isAnimationActive={false} maxBarSize={24} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartFrame>
  );
}
