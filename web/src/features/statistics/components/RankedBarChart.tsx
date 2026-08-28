import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from 'recharts';
import { useTranslation } from 'react-i18next';
import { ChartFrame } from './ChartFrame';
import { responsiveStatisticsChartProps } from './chartTheme';

/** One row accepted by the reusable ranked bar chart. */
export interface RankedBarDatum {
  id: string;
  label: string;
  value: number;
  formattedValue: string;
}

/** Properties accepted by a ranked statistics chart. */
export interface RankedBarChartProps {
  title: string;
  summary: string;
  valueLabel: string;
  data: readonly RankedBarDatum[];
}

/**
 * Renders a directly labelled horizontal ranking and exact data table.
 *
 * @param props - Ranking labels, values, summary, and chart title.
 * @returns A responsive SVG ranking with no hover-only values.
 */
export function RankedBarChart({ title, summary, valueLabel, data }: RankedBarChartProps) {
  const { t } = useTranslation();
  return (
    <ChartFrame
      columns={[t('statistics.chart.rank'), t('statistics.chart.name'), valueLabel]}
      rows={data.map((item, index) => ({ key: item.id, cells: [index + 1, item.label, item.formattedValue] }))}
      summary={summary}
      title={title}
    >
      <BarChart {...responsiveStatisticsChartProps} accessibilityLayer data={data} layout="vertical" margin={{ top: 8, right: 82, bottom: 8, left: 8 }}>
        <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
        <XAxis axisLine={false} domain={[0, 'dataMax']} hide type="number" />
        <YAxis axisLine={false} dataKey="label" tick={{ fill: 'var(--chart-axis)', fontSize: 12 }} tickLine={false} type="category" width={108} />
        <Bar dataKey="value" fill="var(--chart-primary)" isAnimationActive={false} maxBarSize={28} radius={[0, 6, 6, 0]}>
          <LabelList dataKey="formattedValue" fill="var(--chart-axis)" fontSize={12} position="right" />
        </Bar>
      </BarChart>
    </ChartFrame>
  );
}
