import { Bar, BarChart, CartesianGrid, Legend, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts';
import { useTranslation } from 'react-i18next';
import type { FinanceStatisticsSeriesPoint, StatisticsMeta } from '@/api/types';
import { formatSignedMoney } from '@/api/money';
import { ChartFrame } from './ChartFrame';
import { responsiveStatisticsChartProps, statisticsChartTheme } from './chartTheme';
import { createMoneyChartScale, formatStatisticsMoney, formatStatisticsPeriod } from '../statisticsFormat';

/** Properties accepted by the grouped finance movement chart. */
export interface FinanceFlowsChartProps {
  series: readonly FinanceStatisticsSeriesPoint[];
  meta: StatisticsMeta;
  currency: string;
  summary: string;
}

/**
 * Renders charges, payments, and adjustments as signed grouped bucket bars.
 *
 * @param props - Exact movement buckets, metadata, currency, and interpretation.
 * @returns A zero-anchored grouped bar chart with an exact fallback table.
 */
export function FinanceFlowsChart({ series, meta, currency, summary }: FinanceFlowsChartProps) {
  const { t } = useTranslation();
  const paymentImpacts = series.map((point) => ({ ...point.netPayments, minorUnits: (-BigInt(point.netPayments.minorUnits)).toString() }));
  const values = series.flatMap((point, index) => [point.netBookingCharges, paymentImpacts[index], point.netAdjustments]);
  const scale = createMoneyChartScale(values);
  const data = series.map((point, index) => ({
    ...point,
    label: formatStatisticsPeriod(point.periodStart, meta.bucket, meta.timezone),
    chargesCoordinate: scale.coordinate(point.netBookingCharges),
    paymentsCoordinate: scale.coordinate(paymentImpacts[index]),
    adjustmentsCoordinate: scale.coordinate(point.netAdjustments),
    chargesFormatted: formatStatisticsMoney(point.netBookingCharges),
    paymentsFormatted: formatSignedMoney(paymentImpacts[index]),
    adjustmentsFormatted: formatStatisticsMoney(point.netAdjustments),
  }));
  const seriesLabels: Record<string, string> = {
    chargesCoordinate: t('statistics.finance.bookingCharges'),
    paymentsCoordinate: t('statistics.finance.paymentImpact'),
    adjustmentsCoordinate: t('statistics.finance.adjustments'),
  };
  return (
    <ChartFrame
      columns={[t('statistics.chart.period'), t('statistics.finance.bookingCharges'), t('statistics.finance.paymentImpact'), t('statistics.finance.adjustments')]}
      rows={data.map((point) => ({ key: point.periodStart, cells: [point.label, point.chargesFormatted, point.paymentsFormatted, point.adjustmentsFormatted] }))}
      summary={summary}
      title={t('statistics.finance.flowsTitle')}
    >
      <BarChart {...responsiveStatisticsChartProps} accessibilityLayer data={data} margin={{ top: 14, right: 20, bottom: 8, left: 8 }}>
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis axisLine={false} dataKey="label" minTickGap={24} tick={{ fill: 'var(--chart-axis)', fontSize: 12 }} tickLine={false} />
        <YAxis axisLine={false} tick={{ fill: 'var(--chart-axis)', fontSize: 12 }} tickFormatter={(value) => scale.formatTick(Number(value), currency)} tickLine={false} width={76} />
        <ReferenceLine stroke="var(--chart-axis)" y={0} />
        <Tooltip contentStyle={statisticsChartTheme.tooltipContent} cursor={statisticsChartTheme.cursor} formatter={(_value, name, item) => {
          const key = String(name);
          const formattedKey = key === 'chargesCoordinate' ? 'chargesFormatted' : key === 'paymentsCoordinate' ? 'paymentsFormatted' : 'adjustmentsFormatted';
          return [String(item.payload[formattedKey]), seriesLabels[key]];
        }} itemStyle={statisticsChartTheme.tooltipItem} labelStyle={statisticsChartTheme.tooltipLabel} />
        <Legend formatter={(value) => <span style={statisticsChartTheme.legendText}>{seriesLabels[value] ?? value}</span>} />
        <Bar dataKey="chargesCoordinate" fill="var(--chart-primary)" isAnimationActive={false} maxBarSize={22} radius={[4, 4, 0, 0]} />
        <Bar dataKey="paymentsCoordinate" fill="var(--chart-positive)" isAnimationActive={false} maxBarSize={22} radius={[4, 4, 0, 0]} />
        <Bar dataKey="adjustmentsCoordinate" fill="var(--chart-tertiary)" isAnimationActive={false} maxBarSize={22} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartFrame>
  );
}
