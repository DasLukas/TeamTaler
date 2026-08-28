import ShieldCheck from 'lucide-react/dist/esm/icons/shield-check';
import { useTranslation } from 'react-i18next';
import type { MemberStatistics } from '@/api/types';
import { StatePanel } from '@/components/ui/StatePanel';
import { CompositionChart } from './components/CompositionChart';
import { KpiCard } from './components/KpiCard';
import { MemberActivityChart } from './components/MemberActivityChart';
import { RankedBarChart } from './components/RankedBarChart';
import { formatStatisticsInteger, formatStatisticsRate } from './statisticsFormat';
import styles from './StatisticsViews.module.css';

/** Properties accepted by the member statistics presentation. */
export interface MemberStatisticsViewProps {
  data: MemberStatistics;
}

/**
 * Renders anonymous member participation and booking statistics.
 *
 * @param props - Server-authorized member statistics projection.
 * @returns KPI, composition, trend, and privacy-aware ranking regions.
 */
export function MemberStatisticsView({ data }: MemberStatisticsViewProps) {
  const { t } = useTranslation();
  const totalPopulation = data.memberSnapshot.regularMembers + data.memberSnapshot.temporaryGuests;
  const hasActivity = data.activity.some((point) => point.postedUnits !== 0 || point.reversedUnits !== 0);
  const categoryData = data.topCategories.items.map((item, index) => ({
    id: item.isOther ? `other-category-${index}` : item.categoryId,
    label: item.isOther ? t('statistics.other') : item.categoryName,
    value: item.validBookedUnits,
    formattedValue: formatStatisticsInteger(item.validBookedUnits),
  }));
  const productData = data.topProducts.items.map((item, index) => ({
    id: item.isOther ? `other-product-${index}` : item.productId,
    label: item.isOther ? t('statistics.other') : item.productName,
    value: item.validBookedUnits,
    formattedValue: formatStatisticsInteger(item.validBookedUnits),
  }));

  return (
    <div className={styles.view}>
      {data.meta.privacyThresholdApplied ? (
        <aside className={styles.privacyNotice} role="note">
          <ShieldCheck aria-hidden="true" size={20} />
          <p><strong>{t('statistics.privacy.title')}</strong><span>{t('statistics.privacy.description')}</span></p>
        </aside>
      ) : null}
      <dl aria-label={t('statistics.members.kpiLabel')} className={styles.kpiGrid}>
        <KpiCard hint={t('statistics.members.activeParticipantsHint')} label={t('statistics.members.activeParticipants')} value={formatStatisticsInteger(data.summary.activeParticipants)} />
        <KpiCard label={t('statistics.members.bookings')} value={formatStatisticsInteger(data.summary.bookingCount)} />
        <KpiCard hint={t('statistics.members.validUnitsHint')} label={t('statistics.members.validUnits')} value={formatStatisticsInteger(data.summary.validBookedUnits)} />
        <KpiCard hint={data.summary.cancellationRate === null ? t('statistics.members.noCancellationRate') : t('statistics.members.cancellationRateHint')} label={t('statistics.members.cancellationRate')} value={formatStatisticsRate(data.summary.cancellationRate)} />
      </dl>
      <div className={styles.chartGrid}>
        {totalPopulation > 0 ? <CompositionChart
          regularMembers={data.memberSnapshot.regularMembers}
          summary={t('statistics.members.compositionSummary', { regular: formatStatisticsInteger(data.memberSnapshot.regularMembers), guests: formatStatisticsInteger(data.memberSnapshot.temporaryGuests) })}
          temporaryGuests={data.memberSnapshot.temporaryGuests}
        /> : <div className={styles.chartState}><StatePanel kind="empty" message={t('statistics.members.noPopulation')} title={t('statistics.members.compositionTitle')} /></div>}
        {hasActivity ? (
          <MemberActivityChart activity={data.activity} meta={data.meta} summary={t('statistics.members.activitySummary')} />
        ) : <div className={styles.chartState}><StatePanel kind="empty" message={t('statistics.members.noActivity')} /></div>}
        {data.topCategories.suppressed ? (
          <div className={styles.chartState}><StatePanel kind="empty" message={t('statistics.privacy.rankingSuppressed')} title={t('statistics.members.categoriesTitle')} /></div>
        ) : categoryData.some((item) => item.value !== 0) ? (
          <RankedBarChart data={categoryData} summary={t('statistics.members.categoriesSummary')} title={t('statistics.members.categoriesTitle')} valueLabel={t('statistics.members.validUnits')} />
        ) : <div className={styles.chartState}><StatePanel kind="empty" message={t('statistics.members.noCategories')} title={t('statistics.members.categoriesTitle')} /></div>}
        {data.topProducts.suppressed ? (
          <div className={styles.chartState}><StatePanel kind="empty" message={t('statistics.privacy.rankingSuppressed')} title={t('statistics.members.productsTitle')} /></div>
        ) : productData.some((item) => item.value !== 0) ? (
          <RankedBarChart data={productData} summary={t('statistics.members.productsSummary')} title={t('statistics.members.productsTitle')} valueLabel={t('statistics.members.validUnits')} />
        ) : <div className={styles.chartState}><StatePanel kind="empty" message={t('statistics.members.noProducts')} title={t('statistics.members.productsTitle')} /></div>}
      </div>
    </div>
  );
}
