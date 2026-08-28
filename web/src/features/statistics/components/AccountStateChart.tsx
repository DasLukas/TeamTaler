import { Bar, BarChart, LabelList, Legend, Tooltip, XAxis, YAxis } from 'recharts';
import { useTranslation } from 'react-i18next';
import { ChartFrame } from './ChartFrame';
import { responsiveStatisticsChartProps, statisticsChartTheme } from './chartTheme';
import { formatStatisticsInteger } from '../statisticsFormat';

/** Properties accepted by the aggregate account-state chart. */
export interface AccountStateChartProps {
  openAccounts: number;
  balancedAccounts: number;
  creditAccounts: number;
  summary: string;
}

/**
 * Renders account-state composition without exposing member-level balances.
 *
 * @param props - Aggregate state counts and explanatory summary.
 * @returns A labelled stacked bar and semantic count table.
 */
export function AccountStateChart({ openAccounts, balancedAccounts, creditAccounts, summary }: AccountStateChartProps) {
  const { t } = useTranslation();
  const data = [{ name: t('statistics.finance.accounts'), openAccounts, balancedAccounts, creditAccounts }];
  const labels: Record<string, string> = {
    openAccounts: t('statistics.finance.openAccounts'),
    balancedAccounts: t('statistics.finance.balancedAccounts'),
    creditAccounts: t('statistics.finance.creditAccounts'),
  };
  return (
    <ChartFrame
      columns={[t('statistics.chart.state'), t('statistics.chart.count')]}
      rows={Object.entries({ openAccounts, balancedAccounts, creditAccounts }).map(([key, value]) => ({ key, cells: [labels[key], formatStatisticsInteger(value)] }))}
      summary={summary}
      title={t('statistics.finance.accountStatesTitle')}
    >
      <BarChart {...responsiveStatisticsChartProps} accessibilityLayer data={data} layout="vertical" margin={{ top: 12, right: 20, bottom: 8, left: 8 }}>
        <XAxis hide type="number" />
        <YAxis dataKey="name" hide type="category" />
        <Tooltip contentStyle={statisticsChartTheme.tooltipContent} cursor={statisticsChartTheme.cursor} formatter={(value, name) => [formatStatisticsInteger(Number(value)), labels[String(name)]]} itemStyle={statisticsChartTheme.tooltipItem} labelStyle={statisticsChartTheme.tooltipLabel} />
        <Legend formatter={(value) => <span style={statisticsChartTheme.legendText}>{labels[value] ?? value}</span>} />
        <Bar dataKey="openAccounts" fill="var(--chart-due)" isAnimationActive={false} radius={[6, 0, 0, 6]} stackId="accounts"><LabelList dataKey="openAccounts" fill="var(--chart-label-on-due)" fontSize={12} position="center" /></Bar>
        <Bar dataKey="balancedAccounts" fill="var(--chart-neutral)" isAnimationActive={false} stackId="accounts"><LabelList dataKey="balancedAccounts" fill="var(--chart-label-on-neutral)" fontSize={12} position="center" /></Bar>
        <Bar dataKey="creditAccounts" fill="var(--chart-credit)" isAnimationActive={false} radius={[0, 6, 6, 0]} stackId="accounts"><LabelList dataKey="creditAccounts" fill="var(--chart-label-on-credit)" fontSize={12} position="center" /></Bar>
      </BarChart>
    </ChartFrame>
  );
}
