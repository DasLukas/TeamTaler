import { useId, type ReactNode } from 'react';
import styles from './StatisticsCharts.module.css';

/** Properties accepted by the statistics chart frame. */
export interface ChartFrameProps {
  title: string;
  summary: string;
  children: ReactNode;
  className?: string;
}

/**
 * Renders a chart with a persistent visible and assistive explanation.
 *
 * @param props - Visible title, accessible summary, and chart content.
 * @returns A responsive analytical figure with no disclosure-only content.
 */
export function ChartFrame({ title, summary, children, className = '' }: ChartFrameProps) {
  const headingId = useId();
  const summaryId = useId();
  return (
    <figure aria-describedby={summaryId} aria-labelledby={headingId} className={`${styles.frame} ${className}`}>
      <header className={styles.frameHeader}>
        <h3 id={headingId}>{title}</h3>
        <p id={summaryId}>{summary}</p>
      </header>
      <div className={styles.plot}>{children}</div>
    </figure>
  );
}
