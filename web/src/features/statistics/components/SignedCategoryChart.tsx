import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, XAxis, YAxis, type LabelProps } from 'recharts';
import { useTranslation } from 'react-i18next';
import { ChartFrame } from './ChartFrame';
import { responsiveStatisticsChartProps } from './chartTheme';
import type { RankedBarDatum } from './RankedBarChart';
import type { MoneyChartScale } from '../statisticsFormat';

/** Properties accepted by the signed finance category chart. */
export interface SignedCategoryChartProps {
  data: readonly RankedBarDatum[];
  scale: MoneyChartScale;
  currency: string;
  summary: string;
}

/**
 * Renders signed category values around an explicit zero baseline.
 *
 * @param props - Exact-labelled category rows, shared money scale, and summary.
 * @returns A diverging horizontal bar chart and semantic data table.
 */
export function SignedCategoryChart({ data, scale, currency, summary }: SignedCategoryChartProps) {
  const { t } = useTranslation();
  const renderLabel = (props: LabelProps) => {
    const index = Number(props.index ?? 0);
    const item = data[index];
    const x = Number(props.x ?? 0);
    const y = Number(props.y ?? 0);
    const width = Number(props.width ?? 0);
    const height = Number(props.height ?? 0);
    const positive = item.value >= 0;
    return <text dominantBaseline="middle" fill="var(--chart-axis)" fontSize={12} textAnchor={positive ? 'start' : 'end'} x={positive ? x + width + 6 : x - 6} y={y + (height / 2)}>{item.formattedValue}</text>;
  };
  return (
    <ChartFrame
      columns={[t('statistics.chart.name'), t('statistics.finance.bookingCharges')]}
      rows={data.map((item) => ({ key: item.id, cells: [item.label, item.formattedValue] }))}
      summary={summary}
      title={t('statistics.finance.categoriesTitle')}
    >
      <BarChart {...responsiveStatisticsChartProps} accessibilityLayer data={data} layout="vertical" margin={{ top: 8, right: 90, bottom: 24, left: 8 }}>
        <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
        <XAxis axisLine={false} domain={[(minimum: number) => Math.min(0, minimum), (maximum: number) => Math.max(0, maximum)]} tick={{ fill: 'var(--chart-axis)', fontSize: 12 }} tickFormatter={(value) => scale.formatTick(Number(value), currency)} tickLine={false} type="number" />
        <YAxis axisLine={false} dataKey="label" tick={{ fill: 'var(--chart-axis)', fontSize: 12 }} tickLine={false} type="category" width={108} />
        <ReferenceLine stroke="var(--chart-axis)" x={0} />
        <Bar dataKey="value" isAnimationActive={false} maxBarSize={28} radius={4}>
          {data.map((item) => <Cell fill={item.value < 0 ? 'var(--chart-negative)' : 'var(--chart-primary)'} key={item.id} />)}
          <LabelList content={renderLabel} />
        </Bar>
      </BarChart>
    </ChartFrame>
  );
}
