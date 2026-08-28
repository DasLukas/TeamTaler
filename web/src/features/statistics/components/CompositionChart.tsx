import { Bar, BarChart, LabelList, Legend, Tooltip, XAxis, YAxis } from 'recharts';
import { useTranslation } from 'react-i18next';
import { ChartFrame } from './ChartFrame';
import { responsiveStatisticsChartProps, statisticsChartTheme } from './chartTheme';
import { formatStatisticsInteger } from '../statisticsFormat';

/** Properties accepted by the member composition chart. */
export interface CompositionChartProps {
  regularMembers: number;
  temporaryGuests: number;
  summary: string;
}

/**
 * Renders regular-member and guest composition as a labelled stacked bar.
 *
 * @param props - Population counts and explanatory summary.
 * @returns A compact composition chart with an exact table fallback.
 */
export function CompositionChart({ regularMembers, temporaryGuests, summary }: CompositionChartProps) {
  const { t } = useTranslation();
  const data = [{ name: t('statistics.members.population'), regularMembers, temporaryGuests }];
  return (
    <ChartFrame
      columns={[t('statistics.chart.type'), t('statistics.chart.count')]}
      rows={[
        { key: 'members', cells: [t('statistics.members.regularMembers'), formatStatisticsInteger(regularMembers)] },
        { key: 'guests', cells: [t('statistics.members.temporaryGuests'), formatStatisticsInteger(temporaryGuests)] },
      ]}
      summary={summary}
      title={t('statistics.members.compositionTitle')}
    >
      <BarChart {...responsiveStatisticsChartProps} accessibilityLayer data={data} layout="vertical" margin={{ top: 12, right: 20, bottom: 8, left: 8 }}>
        <XAxis hide type="number" />
        <YAxis dataKey="name" hide type="category" />
        <Tooltip contentStyle={statisticsChartTheme.tooltipContent} cursor={statisticsChartTheme.cursor} formatter={(value, name) => [formatStatisticsInteger(Number(value)), name === 'regularMembers' ? t('statistics.members.regularMembers') : t('statistics.members.temporaryGuests')]} itemStyle={statisticsChartTheme.tooltipItem} labelStyle={statisticsChartTheme.tooltipLabel} />
        <Legend formatter={(value) => <span style={statisticsChartTheme.legendText}>{value === 'regularMembers' ? t('statistics.members.regularMembers') : t('statistics.members.temporaryGuests')}</span>} />
        <Bar dataKey="regularMembers" fill="var(--chart-primary)" isAnimationActive={false} radius={[6, 0, 0, 6]} stackId="members">
          <LabelList dataKey="regularMembers" fill="var(--chart-label-on-primary)" fontSize={12} position="center" />
        </Bar>
        <Bar dataKey="temporaryGuests" fill="var(--chart-secondary)" isAnimationActive={false} radius={[0, 6, 6, 0]} stackId="members">
          <LabelList dataKey="temporaryGuests" fill="var(--chart-label-on-secondary)" fontSize={12} position="center" />
        </Bar>
      </BarChart>
    </ChartFrame>
  );
}
