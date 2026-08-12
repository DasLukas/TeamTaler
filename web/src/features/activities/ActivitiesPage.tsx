import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Archive from 'lucide-react/dist/esm/icons/archive';
import CircleCheck from 'lucide-react/dist/esm/icons/circle-check';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import Search from 'lucide-react/dist/esm/icons/search';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import { useDeferredValue, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney } from '@/api/money';
import type { Booking, MembershipStatus } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { StatePanel } from '@/components/ui/StatePanel';
import tableStyles from '@/features/shared/Table.module.css';
import styles from './ActivitiesPage.module.css';

interface MembershipIdentityProps {
  avatarUrl?: string;
  name: string;
  status: MembershipStatus;
}

/**
 * Renders a compact historical member identity with an accessible lifecycle marker.
 *
 * @param props - The current display name, avatar projection, and membership status.
 * @returns A table-safe identity that exposes archived and deleted states through text and tooltip labels.
 */
function MembershipIdentity({ avatarUrl, name, status }: MembershipIdentityProps) {
  const { t } = useTranslation();
  const statusLabel = status === 'ARCHIVED' ? t('common.archived') : status === 'DELETED' ? t('common.deleted') : undefined;
  const StatusIcon = status === 'ARCHIVED' ? Archive : Trash2;

  return (
    <span className={styles.member}>
      <Avatar name={name} size="small" src={avatarUrl} />
      <span className={styles.memberName} title={name}>{name}</span>
      {statusLabel ? (
        <span
          aria-label={statusLabel}
          className={`${styles.membershipState} ${status === 'DELETED' ? styles.membershipStateDeleted : styles.membershipStateArchived}`}
          role="img"
          title={statusLabel}
        >
          <StatusIcon aria-hidden="true" size={14} />
          <span className={styles.membershipStateText}>{statusLabel}</span>
        </span>
      ) : null}
    </span>
  );
}

/**
 * Renders a compact booking status that expands to a labeled badge on wide screens.
 *
 * @param props - The immutable booking status rendered in the activity table.
 * @returns An icon badge with an accessible label and native hover tooltip.
 */
function BookingState({ status }: Pick<Booking, 'status'>) {
  const { t } = useTranslation();
  const label = status === 'POSTED' ? t('common.booked') : t('common.reversed');
  const StatusIcon = status === 'POSTED' ? CircleCheck : RotateCcw;

  return (
    <span
      aria-label={label}
      className={`${tableStyles.status} ${styles.bookingState} ${status === 'REVERSED' ? tableStyles.statusMuted : ''}`}
      role="img"
      title={label}
    >
      <StatusIcon aria-hidden="true" size={15} />
      <span className={styles.bookingStateText}>{label}</span>
    </span>
  );
}

/**
 * Renders a searchable and auditable booking activity page.
 *
 * @returns A localized booking table and reversal workflow.
 */
export function ActivitiesPage() {
  const { t } = useTranslation();
  const { activeGroup, activeGroupId, session } = useActiveGroup();
  const queryClient = useQueryClient();
  const bookingsQuery = useQuery({ queryKey: ['bookings', activeGroupId], queryFn: () => api.getBookings(activeGroupId) });
  const categoriesQuery = useQuery({ queryKey: ['categories', activeGroupId], queryFn: () => api.getCategories(activeGroupId) });
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.toLowerCase());
  const [reversal, setReversal] = useState<Booking | null>(null);
  const [reason, setReason] = useState('');
  const productImages = useMemo(() => new Map(
    categoriesQuery.data?.flatMap((category) => category.products.map((product) => [product.id, product.imageUrl] as const)) ?? [],
  ), [categoriesQuery.data]);
  const reverseMutation = useMutation({
    mutationFn: () => reversal ? api.reverseBooking(activeGroupId, reversal.id, reason.trim()) : Promise.reject(new Error(t('activities.noSelection'))),
    onSuccess: async () => {
      setReversal(null);
      setReason('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bookings', activeGroupId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard', activeGroupId] }),
        queryClient.invalidateQueries({ queryKey: ['ledger', activeGroupId] }),
        queryClient.invalidateQueries({ queryKey: ['account-summaries', activeGroupId] }),
      ]);
    },
  });

  if (bookingsQuery.isLoading) return <Page title={t('activities.title')}><StatePanel kind="loading" /></Page>;
  if (bookingsQuery.isError || !bookingsQuery.data) return <Page title={t('activities.title')}><StatePanel kind="error" message={t('activities.error')} /></Page>;

  const filtered = bookingsQuery.data.filter((booking) => `${booking.memberName} ${booking.bookedByName} ${booking.productName} ${booking.categoryName}`.toLowerCase().includes(deferredSearch));
  const columnLabels = {
    bookedFor: t('activities.bookedFor'),
    bookedBy: t('activities.bookedBy'),
    booking: t('activities.booking'),
    category: t('common.category'),
    time: t('activities.time'),
    amount: t('common.amount'),
    status: t('common.status'),
    action: t('common.action'),
  };

  return (
    <Page className={styles.page} title={t('activities.title')} wide>
      <div className={tableStyles.toolbar}>
        <div className={tableStyles.search}>
          <Field htmlFor="activity-search" label={t('activities.searchLabel')}>
            <div className={styles.searchControl}><Search aria-hidden="true" size={19} /><TextInput id="activity-search" onChange={(event) => setSearch(event.target.value)} placeholder={t('activities.searchPlaceholder')} value={search} /></div>
          </Field>
        </div>
      </div>
      {filtered.length === 0 ? <StatePanel kind="empty" message={t('activities.noResults')} /> : (
        <div className={`${tableStyles.tableWrap} ${styles.activityList}`}>
          <table aria-label={t('activities.title')} className={`${tableStyles.table} ${styles.activityTable}`}>
            <thead><tr><th>{columnLabels.bookedFor}</th><th>{columnLabels.bookedBy}</th><th>{columnLabels.booking}</th><th>{columnLabels.category}</th><th>{columnLabels.time}</th><th className={tableStyles.number}>{columnLabels.amount}</th><th>{columnLabels.status}</th><th><span className="sr-only">{columnLabels.action}</span></th></tr></thead>
            <tbody>
              {filtered.map((booking) => {
                const productImageUrl = productImages.get(booking.productId);
                const memberAvatarUrl = booking.memberId === activeGroup.membership?.id ? session.user.avatarUrl : booking.memberAvatarUrl;
                const bookedByAvatarUrl = booking.bookedByMemberId === activeGroup.membership?.id ? session.user.avatarUrl : booking.bookedByAvatarUrl;
                return <tr key={booking.id}>
                  <td data-label={columnLabels.bookedFor}><MembershipIdentity avatarUrl={memberAvatarUrl} name={booking.memberName} status={booking.memberStatus} /></td>
                  <td data-label={columnLabels.bookedBy}><MembershipIdentity avatarUrl={bookedByAvatarUrl} name={booking.bookedByName} status={booking.bookedByStatus} /></td>
                  <td data-label={columnLabels.booking}>
                    <span className={styles.bookingProduct}>
                      {productImageUrl ? <img alt="" decoding="async" loading="lazy" src={productImageUrl} /> : null}
                      <span><strong>{booking.productName}</strong>{booking.quantity > 1 ? ` × ${booking.quantity}` : ''}{booking.reason ? <small>{booking.reason}</small> : null}</span>
                    </span>
                  </td>
                  <td data-label={columnLabels.category}>{booking.categoryName}</td>
                  <td data-label={columnLabels.time}>{new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(booking.bookedAt))}</td>
                  <td className={tableStyles.number} data-label={columnLabels.amount}>{formatMoney(booking.total)}</td>
                  <td data-label={columnLabels.status}><BookingState status={booking.status} /></td>
                  <td data-label={columnLabels.action}>{booking.status === 'POSTED' && booking.canVoid ? <Button leadingIcon={<RotateCcw size={16} />} onClick={() => setReversal(booking)} size="small" variant="ghost">{t('activities.reverse')}</Button> : null}</td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      )}
      <Modal onClose={() => { setReversal(null); setReason(''); }} open={Boolean(reversal)} title={t('activities.reverseTitle')}>
        <form className={styles.reversalForm} onSubmit={(event) => { event.preventDefault(); reverseMutation.mutate(); }}>
          <p>{t('activities.reverseExplanation')}</p>
          {reversal?.voidWithoutReasonUntil && !reversal.voidReasonRequired ? <p className={styles.windowNotice}>{t('activities.reasonOptionalUntil', { time: new Intl.DateTimeFormat('de-DE', { timeStyle: 'short' }).format(new Date(reversal.voidWithoutReasonUntil)) })}</p> : null}
          <Field hint={reversal?.voidReasonRequired ? t('activities.reasonRequired') : t('activities.reasonOptional')} htmlFor="reversal-reason" label={t('finance.reason')}>
            <TextInput id="reversal-reason" onChange={(event) => setReason(event.target.value)} required={reversal?.voidReasonRequired} value={reason} />
          </Field>
          {reverseMutation.isError ? <p className={styles.error} role="alert">{reverseMutation.error.message}</p> : null}
          <div className={styles.actions}><Button onClick={() => { setReversal(null); setReason(''); }} variant="secondary">{t('common.cancel')}</Button><Button disabled={Boolean(reversal?.voidReasonRequired && !reason.trim()) || reverseMutation.isPending} type="submit">{t('activities.confirmReverse')}</Button></div>
        </form>
      </Modal>
    </Page>
  );
}
