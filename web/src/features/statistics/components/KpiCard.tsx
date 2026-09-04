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
 * @param props - Metric label, exact value, optional context, visual, and tone.
 * @returns A theme-aware monitoring panel suitable for a surrounding `dl`.
 */
export function KpiCard({ label, value, hint, tone = 'default' }: KpiCardProps) {
  return (
    <div className={styles.kpi} data-tone={tone}>
      <div className={styles.kpiHeader}>
        <dt>{label}</dt>
        <span aria-hidden="true" className={styles.kpiStatus} />
      </div>
      <dd>{value}</dd>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}
