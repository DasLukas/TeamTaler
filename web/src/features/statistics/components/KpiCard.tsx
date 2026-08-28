import type { ReactNode } from 'react';
import styles from './StatisticsCharts.module.css';

/** Properties accepted by a dashboard KPI card. */
export interface KpiCardProps {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'default' | 'positive' | 'warning';
}

/**
 * Renders one compact definition-list metric.
 *
 * @param props - Metric label, exact value, optional context, and semantic tone.
 * @returns A theme-aware KPI definition suitable for a surrounding `dl`.
 */
export function KpiCard({ label, value, hint, tone = 'default' }: KpiCardProps) {
  return (
    <div className={styles.kpi} data-tone={tone}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}
