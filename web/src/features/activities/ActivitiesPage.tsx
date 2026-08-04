import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import Search from 'lucide-react/dist/esm/icons/search';
import { useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney } from '@/api/money';
import type { Booking } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { StatePanel } from '@/components/ui/StatePanel';
import tableStyles from '@/features/shared/Table.module.css';
import styles from './ActivitiesPage.module.css';

/**
 * Renders a searchable and auditable booking activity page.
 *
 * @returns A localized booking table and reversal workflow.
 */
export function ActivitiesPage() {
  const { t } = useTranslation();
  const { activeGroupId } = useActiveGroup();
  const queryClient = useQueryClient();
  const bookingsQuery = useQuery({ queryKey: ['bookings', activeGroupId], queryFn: () => api.getBookings(activeGroupId) });
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.toLowerCase());
  const [reversal, setReversal] = useState<Booking | null>(null);
  const [reason, setReason] = useState('');
  const reverseMutation = useMutation({
    mutationFn: () => reversal ? api.reverseBooking(activeGroupId, reversal.id, reason) : Promise.reject(new Error(t('activities.noSelection'))),
    onSuccess: async () => {
      setReversal(null);
      setReason('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bookings', activeGroupId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard', activeGroupId] }),
        queryClient.invalidateQueries({ queryKey: ['ledger', activeGroupId] }),
      ]);
    },
  });

  if (bookingsQuery.isLoading) return <Page title={t('activities.title')}><StatePanel kind="loading" /></Page>;
  if (bookingsQuery.isError || !bookingsQuery.data) return <Page title={t('activities.title')}><StatePanel kind="error" message={t('activities.error')} /></Page>;

  const filtered = bookingsQuery.data.filter((booking) => `${booking.memberName} ${booking.bookedByName} ${booking.productName} ${booking.categoryName}`.toLowerCase().includes(deferredSearch));

  return (
    <Page intro={t('activities.intro')} title={t('activities.title')} wide>
      <div className={tableStyles.toolbar}>
        <div className={tableStyles.search}>
          <Field htmlFor="activity-search" label={t('activities.searchLabel')}>
            <div className={styles.searchControl}><Search aria-hidden="true" size={19} /><TextInput id="activity-search" onChange={(event) => setSearch(event.target.value)} placeholder={t('activities.searchPlaceholder')} value={search} /></div>
          </Field>
        </div>
      </div>
      {filtered.length === 0 ? <StatePanel kind="empty" message={t('activities.noResults')} /> : (
        <div className={tableStyles.tableWrap}>
          <table className={tableStyles.table}>
            <thead><tr><th>{t('activities.bookedFor')}</th><th>{t('activities.bookedBy')}</th><th>{t('activities.booking')}</th><th>{t('common.category')}</th><th>{t('activities.time')}</th><th className={tableStyles.number}>{t('common.amount')}</th><th>{t('common.status')}</th><th><span className="sr-only">{t('common.action')}</span></th></tr></thead>
            <tbody>
              {filtered.map((booking) => (
                <tr key={booking.id}>
                  <td><span className={styles.member}><Avatar name={booking.memberName} size="small" />{booking.memberName}</span></td>
                  <td><span className={styles.member}><Avatar name={booking.bookedByName} size="small" />{booking.bookedByName}</span></td>
                  <td><strong>{booking.productName}</strong>{booking.quantity > 1 ? ` × ${booking.quantity}` : ''}{booking.reason ? <small>{booking.reason}</small> : null}</td>
                  <td>{booking.categoryName}</td>
                  <td>{new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(booking.bookedAt))}</td>
                  <td className={tableStyles.number}>{formatMoney(booking.total)}</td>
                  <td><span className={`${tableStyles.status} ${booking.status === 'REVERSED' ? tableStyles.statusMuted : ''}`}>{booking.status === 'POSTED' ? t('common.booked') : t('common.reversed')}</span></td>
                  <td>{booking.status === 'POSTED' && booking.canVoid ? <Button leadingIcon={<RotateCcw size={16} />} onClick={() => setReversal(booking)} size="small" variant="ghost">{t('activities.reverse')}</Button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal onClose={() => setReversal(null)} open={Boolean(reversal)} title={t('activities.reverseTitle')}>
        <form className={styles.reversalForm} onSubmit={(event) => { event.preventDefault(); reverseMutation.mutate(); }}>
          <p>{t('activities.reverseExplanation')}</p>
          <Field htmlFor="reversal-reason" label={t('finance.reason')}>
            <TextInput id="reversal-reason" onChange={(event) => setReason(event.target.value)} required value={reason} />
          </Field>
          {reverseMutation.isError ? <p className={styles.error} role="alert">{reverseMutation.error.message}</p> : null}
          <div className={styles.actions}><Button onClick={() => setReversal(null)} variant="secondary">{t('common.cancel')}</Button><Button disabled={!reason.trim() || reverseMutation.isPending} type="submit">{t('activities.confirmReverse')}</Button></div>
        </form>
      </Modal>
    </Page>
  );
}
