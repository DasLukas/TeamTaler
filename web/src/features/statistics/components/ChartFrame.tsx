import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './StatisticsCharts.module.css';

/** One semantic fallback-table row rendered below a chart. */
export interface ChartDataRow {
  key: string;
  cells: readonly ReactNode[];
}

/** Properties accepted by the statistics chart frame. */
export interface ChartFrameProps {
  title: string;
  summary: string;
  columns: readonly string[];
  rows: readonly ChartDataRow[];
  children: ReactNode;
  className?: string;
}

/**
 * Renders a chart with a persistent explanation and semantic table fallback.
 *
 * @param props - Visible title, accessible summary, chart, and exact tabular data.
 * @returns A responsive analytical figure that never depends on hover alone.
 */
export function ChartFrame({ title, summary, columns, rows, children, className = '' }: ChartFrameProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const summaryId = useId();
  return (
    <figure aria-describedby={summaryId} aria-labelledby={headingId} className={`${styles.frame} ${className}`}>
      <header className={styles.frameHeader}>
        <h3 id={headingId}>{title}</h3>
        <p id={summaryId}>{summary}</p>
      </header>
      <div className={styles.plot}>{children}</div>
      <details className={styles.dataDetails}>
        <summary>{t('statistics.chart.dataTable')}</summary>
        <div className={styles.tableViewport} tabIndex={0}>
          <table>
            <caption className="sr-only">{t('statistics.chart.dataTableCaption', { title })}</caption>
            <thead><tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
            <tbody>{rows.map((row) => <tr key={row.key}>{row.cells.map((cell, index) => index === 0 ? <th key={index} scope="row">{cell}</th> : <td key={index}>{cell}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
