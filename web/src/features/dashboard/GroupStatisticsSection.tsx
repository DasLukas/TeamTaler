import TrendingUp from 'lucide-react/dist/esm/icons/trending-up';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '@/api/money';
import type { CategoryTotal } from '@/api/types';
import { CategoryIcon } from '@/features/shared/CategoryIcon';
import styles from './GroupStatisticsSection.module.css';

/** Properties accepted by the anonymous group-statistics section. */
export interface GroupStatisticsSectionProps {
  groupTotals: CategoryTotal[];
  periodLabel: string;
  currency: string;
}

/**
 * Renders current-period group totals without exposing member-level balances.
 *
 * @param props - Anonymous category totals, period label, and fallback currency.
 * @returns A clearly labelled aggregate group summary for the member overview.
 */
export function GroupStatisticsSection({ groupTotals, periodLabel, currency }: GroupStatisticsSectionProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const max = groupTotals.reduce((current, entry) => BigInt(entry.total.minorUnits) > current ? BigInt(entry.total.minorUnits) : current, 1n);
  const aggregate = groupTotals.reduce((sum, entry) => sum + BigInt(entry.total.minorUnits), 0n);
  const aggregateCurrency = groupTotals[0]?.total.currency ?? currency;

  return (
    <section aria-labelledby={titleId} className={styles.section}>
      <header className={styles.heading}>
        <h2 id={titleId}>{t('dashboard.groupStatistics.title')}</h2>
      </header>
      <div className={styles.summary}>
        <TrendingUp aria-hidden="true" size={28} />
        <div><span>{t('dashboard.groupStatistics.groupSum', { period: periodLabel })}</span><strong>{formatMoney({ minorUnits: aggregate.toString(), currency: aggregateCurrency })}</strong></div>
      </div>
      {groupTotals.length === 0 ? <p className={styles.empty}>{t('dashboard.groupStatistics.empty')}</p> : (
        <div className={styles.categories}>
          {groupTotals.map((entry) => {
            const percentage = Number(BigInt(entry.total.minorUnits) * 10_000n / max) / 100;
            return (
              <article className={styles.category} key={entry.categoryId}>
                <header><span className={styles.icon}><CategoryIcon icon={entry.icon} size={25} /></span><div><h3>{entry.categoryName}</h3><p>{t('dashboard.groupStatistics.bookingCount', { count: entry.quantity ?? 0 })}</p></div><strong>{formatMoney(entry.total)}</strong></header>
                <div aria-label={t('dashboard.groupStatistics.percentageLabel', { category: entry.categoryName, percentage: Math.round(percentage) })} className={styles.track} role="img"><span style={{ width: `${Math.max(4, percentage)}%` }} /></div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
