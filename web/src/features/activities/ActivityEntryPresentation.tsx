import BookOpenCheck from 'lucide-react/dist/esm/icons/book-open-check';
import CircleCheck from 'lucide-react/dist/esm/icons/circle-check';
import CircleDollarSign from 'lucide-react/dist/esm/icons/circle-dollar-sign';
import Link2 from 'lucide-react/dist/esm/icons/link-2';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import Scale from 'lucide-react/dist/esm/icons/scale';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '@/api/money';
import type { ActivityEntry, MembershipStatus } from '@/api/types';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PaymentAttachmentAction } from '@/features/finance/PaymentAttachmentAction';
import { formatGermanDateTime } from '@/features/shared/dateFormat';
import { MembershipStateIcon } from '@/features/shared/MembershipStateIcon';
import tableStyles from '@/features/shared/Table.module.css';
import styles from './ActivitiesPage.module.css';

interface MembershipIdentityProps {
  avatarUrl?: string;
  name?: string;
  status?: MembershipStatus;
}

interface ActivityDetailsProps {
  activity: ActivityEntry;
  productImageUrl?: string;
}

interface ActivityActionsProps {
  activity: ActivityEntry;
  groupId: string;
  onNavigateRelated: (activityId: string) => void;
  onReverse: (activity: ActivityEntry) => void;
}

interface ActivityCardProps extends ActivityActionsProps {
  actorAvatarUrl?: string;
  productImageUrl?: string;
  targetAvatarUrl?: string;
}

/**
 * Resolves the localized feed label shared by table badges, cards, and reversal origins.
 *
 * @param kind - Canonical unified-feed activity kind.
 * @param t - Active i18next translation function.
 * @returns Localized activity-kind label.
 */
function activityTypeLabel(kind: ActivityEntry['kind'], t: ReturnType<typeof useTranslation>['t']): string {
  if (kind === 'BOOKING') return t('activities.bookingType');
  if (kind === 'PAYMENT') return t('activities.paymentType');
  if (kind === 'REVERSAL') return t('activities.reversalType');
  return t('activities.adjustmentType');
}

/**
 * Renders a compact historical member identity with lifecycle state.
 *
 * @param props - Current name, avatar projection, and optional membership state.
 * @returns A table-safe identity or a neutral placeholder for system corrections.
 */
export function MembershipIdentity({ avatarUrl, name, status }: MembershipIdentityProps) {
  const { t } = useTranslation();
  if (!name) return <span aria-label={t('activities.actorUnavailable')} className={styles.missingActor}>–</span>;
  return (
    <span className={styles.member}>
      <Avatar name={name} size="small" src={avatarUrl} />
      <span className={styles.memberName} title={name}>{name}</span>
      <MembershipStateIcon showLabelAtWide status={status} />
    </span>
  );
}

/**
 * Renders one transaction kind with an icon-only narrow-screen state.
 *
 * @param props - Unified activity kind.
 * @returns An accessible booking, payment, reversal, or adjustment badge.
 */
export function ActivityType({ kind }: Pick<ActivityEntry, 'kind'>) {
  const { t } = useTranslation();
  const label = activityTypeLabel(kind, t);
  const TypeIcon = kind === 'BOOKING' ? BookOpenCheck : kind === 'PAYMENT' ? CircleDollarSign : kind === 'REVERSAL' ? RotateCcw : Scale;
  const tone = kind === 'BOOKING'
    ? styles.activityTypeBooking
    : kind === 'PAYMENT' ? styles.activityTypePayment : kind === 'REVERSAL' ? styles.activityTypeReversal : styles.activityTypeAdjustment;

  return (
    <span aria-label={label} className={`${styles.activityType} ${tone}`} role="img" title={label}>
      <TypeIcon aria-hidden="true" size={16} />
      <span aria-hidden="true" className={styles.activityTypeText}>{label}</span>
    </span>
  );
}

/**
 * Renders the source-aware current lifecycle status of one transaction.
 *
 * @param props - Transaction kind and current status.
 * @returns A localized status badge.
 */
export function ActivityState({ kind, status }: Pick<ActivityEntry, 'kind' | 'status'>) {
  const { t } = useTranslation();
  const reversed = status === 'REVERSED';
  const label = reversed
    ? t('common.reversed')
    : kind === 'BOOKING'
      ? t('common.booked')
      : kind === 'PAYMENT' ? t('activities.paymentReceived') : kind === 'REVERSAL' ? t('activities.reversalPosted') : t('activities.adjustmentPosted');
  const StatusIcon = reversed ? RotateCcw : CircleCheck;
  const tone = reversed ? tableStyles.statusMuted : kind === 'BOOKING' ? tableStyles.statusWarning : '';
  return (
    <span aria-label={label} className={`${tableStyles.status} ${styles.activityState} ${tone}`} role="img" title={label}>
      <StatusIcon aria-hidden="true" size={15} />
      <span>{label}</span>
    </span>
  );
}

/**
 * Renders one activity's product or payment description with its optional product image.
 *
 * @param props - Activity snapshot and authorized product-image projection.
 * @returns A compact detail identity shared by tables and cards.
 */
export function ActivityDetails({ activity, productImageUrl }: ActivityDetailsProps) {
  return (
    <span className={styles.activityDetails}>
      {productImageUrl ? <img alt="" decoding="async" loading="lazy" src={productImageUrl} /> : null}
      <span>
        <strong>{activity.detailName}</strong>
        {activity.quantity && activity.quantity > 1 ? ` × ${activity.quantity}` : ''}
        {activity.detailNote ? <small>{activity.detailNote}</small> : null}
      </span>
    </span>
  );
}

/**
 * Renders the signed activity amount with transaction and reversal semantics.
 *
 * @param props - Activity amount and current status.
 * @returns A localized, semantically colored monetary value.
 */
export function ActivityAmount({ amount, status }: Pick<ActivityEntry, 'amount' | 'status'>) {
  const minorUnits = BigInt(amount.minorUnits);
  const formatted = formatMoney(amount);
  const tone = status === 'REVERSED'
    ? styles.activityAmountReversed
    : minorUnits > 0n ? styles.activityAmountBooking : minorUnits < 0n ? styles.activityAmountPayment : '';
  return <strong className={`${styles.activityAmount} ${tone}`}>{minorUnits > 0n ? `+${formatted}` : formatted}</strong>;
}

/**
 * Renders related-entry navigation, receipt, and reversal actions for one authorized activity.
 *
 * @param props - Activity action metadata, group scope, related navigation, and reversal callback.
 * @returns Available actions or nothing for immutable, unrelated rows.
 */
export function ActivityActions({ activity, groupId, onNavigateRelated, onReverse }: ActivityActionsProps) {
  const { t } = useTranslation();
  const isReversal = activity.kind === 'REVERSAL';
  const relatedActivityId = activity.relatedActivityId;
  if (!relatedActivityId && (isReversal || (!activity.attachment && !activity.canReverse))) return null;
  return (
    <div className={styles.rowActions}>
      {relatedActivityId ? (
        <Button
          aria-label={t(isReversal ? 'activities.linkToOriginalAccessible' : 'activities.linkToReversalAccessible')}
          leadingIcon={<Link2 size={16} />}
          onClick={() => onNavigateRelated(relatedActivityId)}
          size="small"
          variant="ghost"
        >
          {t(isReversal ? 'activities.linkToOriginal' : 'activities.linkToReversal')}
        </Button>
      ) : null}
      {!isReversal && activity.attachment ? <PaymentAttachmentAction attachment={activity.attachment} groupId={groupId} paymentId={activity.sourceId} /> : null}
      {!isReversal && activity.canReverse ? <Button leadingIcon={<RotateCcw size={16} />} onClick={() => onReverse(activity)} size="small" variant="ghost">{t('activities.reverse')}</Button> : null}
    </div>
  );
}

/**
 * Renders one complete mobile activity card without duplicating server-query behavior.
 *
 * @param props - Activity, resolved media projections, group scope, and action callback.
 * @returns A semantic card containing every field exposed by the desktop table.
 */
export function ActivityCard({ activity, actorAvatarUrl, groupId, onNavigateRelated, onReverse, productImageUrl, targetAvatarUrl }: ActivityCardProps) {
  const { t } = useTranslation();
  const typeLabel = activityTypeLabel(activity.kind, t);
  return (
    <article aria-label={t('activities.cardLabel', { type: typeLabel, detail: activity.detailName })} className={styles.activityCard}>
      <header className={styles.cardHeader}>
        <ActivityType kind={activity.kind} />
        <ActivityAmount amount={activity.amount} status={activity.status} />
      </header>
      <div className={styles.cardDetails}><span className={styles.cardLabel}>{t('common.details')}</span><ActivityDetails activity={activity} productImageUrl={productImageUrl} /></div>
      <dl className={styles.cardMetadata}>
        <div className={styles.cardIdentity}>
          <dt>{t('common.member')}</dt>
          <dd><MembershipIdentity avatarUrl={targetAvatarUrl} name={activity.targetDisplayName} status={activity.targetMembershipStatus} /></dd>
        </div>
        <div className={styles.cardIdentity}>
          <dt>{t('activities.recordedBy')}</dt>
          <dd><MembershipIdentity avatarUrl={actorAvatarUrl} name={activity.actorDisplayName} status={activity.actorMembershipStatus} /></dd>
        </div>
        <div>
          <dt>{t('common.category')}</dt>
          <dd>{activity.categoryName ?? '–'}</dd>
        </div>
        <div>
          <dt>{t('activities.time')}</dt>
          <dd><time dateTime={activity.occurredAt}>{formatGermanDateTime(activity.occurredAt)}</time></dd>
        </div>
      </dl>
      <footer className={styles.cardFooter}>
        <ActivityState kind={activity.kind} status={activity.status} />
        <ActivityActions activity={activity} groupId={groupId} onNavigateRelated={onNavigateRelated} onReverse={onReverse} />
      </footer>
    </article>
  );
}
