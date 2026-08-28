import type { CSSProperties, SVGProps } from 'react';

/** Geometry required by Recharts 3 responsive wrappers to inherit the plot size. */
export const responsiveStatisticsChartProps = {
  responsive: true,
  style: { width: '100%', height: '100%' } satisfies CSSProperties,
} as const;

/** Theme-aware Recharts styles shared by every statistics visualization. */
export const statisticsChartTheme: {
  tooltipContent: CSSProperties;
  tooltipLabel: CSSProperties;
  tooltipItem: CSSProperties;
  legendText: CSSProperties;
  cursor: SVGProps<SVGElement>;
} = {
  tooltipContent: {
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-md)',
    color: 'var(--color-text)',
    background: 'var(--color-surface-raised)',
    boxShadow: 'var(--shadow-md)',
  },
  tooltipLabel: { color: 'var(--color-text-strong)', fontWeight: 700 },
  tooltipItem: { color: 'var(--color-text)' },
  legendText: { color: 'var(--chart-axis)' },
  cursor: { fill: 'var(--chart-hover)', stroke: 'var(--chart-axis)', strokeWidth: 1 },
};
