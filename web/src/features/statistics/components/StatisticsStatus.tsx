import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw';
import { useTranslation } from 'react-i18next';
import type { StatisticsMeta } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { formatStatisticsMetaRange } from '../statisticsFormat';
import styles from './StatisticsCharts.module.css';

/** Properties accepted by the statistics freshness bar. */
export interface StatisticsStatusProps {
  meta: StatisticsMeta;
  refreshing: boolean;
  onRefresh: () => void;
}

/**
 * Renders range provenance, generation time, and an explicit refresh action.
 *
 * @param props - Projection metadata and current refetch state.
 * @returns A non-polling freshness control with polite status feedback.
 */
export function StatisticsStatus({ meta, refreshing, onRefresh }: StatisticsStatusProps) {
  const { t } = useTranslation();
  const generatedAt = new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: meta.timezone,
  }).format(new Date(meta.generatedAt));
  return (
    <div className={styles.statusBar}>
      <p aria-live="polite">
        <strong>{formatStatisticsMetaRange(meta)}</strong>
        <span>{t('statistics.generatedAt', { date: generatedAt, timezone: meta.timezone })}</span>
        {refreshing ? <span>{t('statistics.refreshing')}</span> : null}
      </p>
      <Button aria-label={t('statistics.refresh')} collapseLabelAt="narrow" disabled={refreshing} leadingIcon={<RefreshCw size={17} />} onClick={onRefresh} size="small" variant="secondary">{t('statistics.refresh')}</Button>
    </div>
  );
}
