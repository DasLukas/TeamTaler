import type { CSSProperties } from 'react';

/** Geometry required by Recharts 3 responsive wrappers to inherit the plot size. */
export const responsiveStatisticsChartProps = {
  responsive: true,
  style: { width: '100%', height: '100%' } satisfies CSSProperties,
} as const;
