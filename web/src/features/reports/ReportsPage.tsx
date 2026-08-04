import { useQuery } from '@tanstack/react-query';
import Gavel from 'lucide-react/dist/esm/icons/gavel';
import GlassWater from 'lucide-react/dist/esm/icons/glass-water';
import TrendingUp from 'lucide-react/dist/esm/icons/trending-up';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney } from '@/api/money';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { StatePanel } from '@/components/ui/StatePanel';
import styles from './ReportsPage.module.css';

/**
 * Renders category-scoped statistics without exposing member balances.
 *
 * @returns A localized aggregate report for the current period.
 */
export function ReportsPage() {
  const { t } = useTranslation();
  const { activeGroupId } = useActiveGroup();
  const dashboardQuery = useQuery({ queryKey: ['dashboard', activeGroupId], queryFn: () => api.getDashboard(activeGroupId) });
  if (dashboardQuery.isLoading) return <Page title={t('reports.title')}><StatePanel kind="loading" /></Page>;
  if (!dashboardQuery.data) return <Page title={t('reports.title')}><StatePanel kind="error" message={t('reports.error')} /></Page>;

  const groupTotals = dashboardQuery.data.groupCategoryTotals;
  const max = groupTotals.reduce((current, entry) => BigInt(entry.total.minorUnits) > current ? BigInt(entry.total.minorUnits) : current, 1n);
  const aggregate = groupTotals.reduce((sum, entry) => sum + BigInt(entry.total.minorUnits), 0n);
  const currency = groupTotals[0]?.total.currency ?? dashboardQuery.data.openBalance.currency;
  return (
    <Page intro={t('reports.intro')} title={t('reports.title')}>
      <div className={styles.summary}>
        <TrendingUp aria-hidden="true" size={28} />
        <div><span>{t('reports.groupSum', { period: dashboardQuery.data.currentPeriod.label })}</span><strong>{formatMoney({ minorUnits: aggregate.toString(), currency })}</strong></div>
      </div>
      <section className={styles.categories}>
        {groupTotals.map((entry) => {
          const Icon = entry.icon === 'drink' ? GlassWater : Gavel;
          const percentage = Number(BigInt(entry.total.minorUnits) * 10_000n / max) / 100;
          return (
            <article className={styles.category} key={entry.categoryId}>
              <header><span className={styles.icon}><Icon size={25} /></span><div><h2>{entry.categoryName}</h2><p>{t('reports.bookingCount', { count: entry.quantity ?? 0 })}</p></div><strong>{formatMoney(entry.total)}</strong></header>
              <div aria-label={t('reports.percentageLabel', { category: entry.categoryName, percentage: Math.round(percentage) })} className={styles.track} role="img"><span style={{ width: `${Math.max(4, percentage)}%` }} /></div>
            </article>
          );
        })}
      </section>
    </Page>
  );
}
