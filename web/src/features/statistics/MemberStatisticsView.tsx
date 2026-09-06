import ShieldCheck from 'lucide-react/dist/esm/icons/shield-check';
import { useTranslation } from 'react-i18next';
import type { MemberStatistics, StatisticsMeta } from '@/api/types';
import { StatePanel } from '@/components/ui/StatePanel';
import { KpiCard } from './components/KpiCard';
import { MemberActivityChart } from './components/MemberActivityChart';
import { TrendRanking } from './components/TrendRanking';
import { formatStatisticsInteger } from './statisticsFormat';
import styles from './StatisticsViews.module.css';

/** Properties accepted by the member statistics presentation. */
export interface MemberStatisticsViewProps {
  data: MemberStatistics;
  meta: StatisticsMeta;
}

/**
 * Renders anonymous member participation and booking statistics.
 *
 * @param props - Server-authorized member statistics projection.
 * @returns KPI, compact activity trend, and privacy-aware ranking regions.
 */
export function MemberStatisticsView({ data, meta }: MemberStatisticsViewProps) {
  const { t } = useTranslation();
  const hasActivity = data.activity.some((point) => point.postedUnits !== 0 || point.reversedUnits !== 0);
  const categoryData = data.topCategories.items.map((item, index) => ({
    id: item.isOther ? `other-category-${index}` : item.categoryId,
    label: item.isOther ? t('statistics.other') : item.categoryName,
    value: item.validBookedUnits,
    series: item.series,
    isOther: item.isOther,
  }));
  const productData = data.topProducts.items.map((item, index) => ({
    id: item.isOther ? `other-product-${index}` : item.productId,
    label: item.isOther ? t('statistics.other') : item.productName,
    context: item.isOther ? t('statistics.other') : item.categoryName,
    value: item.validBookedUnits,
    series: item.series,
    isOther: item.isOther,
  }));

  return (
    <div className={styles.view}>
      {meta.privacyThresholdApplied ? (
        <aside className={styles.privacyNotice} role="note">
          <ShieldCheck aria-hidden="true" size={20} />
          <p><strong>{t('statistics.privacy.title')}</strong><span>{t('statistics.privacy.description')}</span></p>
        </aside>
      ) : null}
      <dl aria-label={t('statistics.members.kpiLabel')} className={styles.kpiGrid}>
        <KpiCard hint={t('statistics.members.activeParticipantsHint')} label={t('statistics.members.activeParticipants')} value={formatStatisticsInteger(data.summary.activeParticipants)} />
        <KpiCard hint={t('statistics.members.bookedProductsHint')} label={t('statistics.members.bookedProducts')} value={formatStatisticsInteger(data.summary.validBookedUnits)} />
      </dl>
      <div className={`${styles.chartGrid} ${styles.demandChartGrid}`}>
        {data.topProducts.suppressed ? (
          <div className={styles.chartState}><StatePanel kind="empty" message={t('statistics.privacy.rankingSuppressed')} title={t('statistics.members.productsTitle')} /></div>
        ) : productData.some((item) => item.value !== 0) ? (
          <TrendRanking data={productData} summary={t('statistics.members.productsSummary')} title={t('statistics.members.productsTitle')} valueLabel={t('statistics.members.productCount')} />
        ) : <div className={styles.chartState}><StatePanel kind="empty" message={t('statistics.members.noProducts')} title={t('statistics.members.productsTitle')} /></div>}
        {data.topCategories.suppressed ? (
          <div className={styles.chartState}><StatePanel kind="empty" message={t('statistics.privacy.rankingSuppressed')} title={t('statistics.members.categoriesTitle')} /></div>
        ) : categoryData.some((item) => item.value !== 0) ? (
          <TrendRanking data={categoryData} summary={t('statistics.members.categoriesSummary')} title={t('statistics.members.categoriesTitle')} valueLabel={t('statistics.members.productCount')} />
        ) : <div className={styles.chartState}><StatePanel kind="empty" message={t('statistics.members.noCategories')} title={t('statistics.members.categoriesTitle')} /></div>}
        {hasActivity ? (
          <MemberActivityChart activity={data.activity} meta={meta} summary={t('statistics.members.activitySummary')} />
        ) : <div className={styles.chartState}><StatePanel kind="empty" message={t('statistics.members.noActivity')} /></div>}
      </div>
    </div>
  );
}
