import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import CalendarCheck from 'lucide-react/dist/esm/icons/calendar-check';
import LockKeyhole from 'lucide-react/dist/esm/icons/lock-keyhole';
import Printer from 'lucide-react/dist/esm/icons/printer';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney } from '@/api/money';
import type { Period } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { StatePanel } from '@/components/ui/StatePanel';
import tableStyles from '@/features/shared/Table.module.css';
import styles from './SettlementsPanel.module.css';

/**
 * Renders the period-close workflow and immutable settlement overview.
 *
 * @returns Localized period controls, settlement table, and close dialog.
 */
export function SettlementsPanel() {
  const { t } = useTranslation();
  const { activeGroupId } = useActiveGroup();
  const queryClient = useQueryClient();
  const periodsQuery = useQuery({ queryKey: ['periods', activeGroupId], queryFn: () => api.getPeriods(activeGroupId) });
  const settlementsQuery = useQuery({ queryKey: ['settlements', activeGroupId], queryFn: () => api.getSettlements(activeGroupId) });
  const [periodToClose, setPeriodToClose] = useState<Period | null>(null);
  const [label, setLabel] = useState('');
  const [dueAt, setDueAt] = useState('');
  const closeMutation = useMutation({
    mutationFn: () => periodToClose ? api.closePeriod(activeGroupId, periodToClose.id, { label: label.trim(), dueAt }) : Promise.reject(new Error(t('periods.noSelection'))),
    onSuccess: async () => {
      setPeriodToClose(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['periods', activeGroupId] }),
        queryClient.invalidateQueries({ queryKey: ['settlements', activeGroupId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard', activeGroupId] }),
        queryClient.invalidateQueries({ queryKey: ['notifications', activeGroupId] }),
      ]);
    },
  });

  if (periodsQuery.isLoading || settlementsQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (!periodsQuery.data || !settlementsQuery.data) return <div className={styles.state}><StatePanel kind="error" message={t('periods.error')} /></div>;

  const openPeriod = periodsQuery.data.find((period) => period.status === 'OPEN');
  const beginClose = (period: Period) => {
    setPeriodToClose(period);
    setLabel(period.label);
    const defaultDue = new Date();
    defaultDue.setDate(defaultDue.getDate() + 14);
    setDueAt(defaultDue.toISOString().slice(0, 10));
  };

  return (
    <div className={styles.content}>
      <header className={styles.header}><div><h2>{t('periods.title')}</h2><p>{t('periods.intro')}</p></div>{openPeriod ? <Button leadingIcon={<LockKeyhole size={18} />} onClick={() => beginClose(openPeriod)}>{t('periods.close')}</Button> : null}</header>
      {openPeriod ? <section className={styles.openPeriod}><span><CalendarCheck size={27} /></span><div><small>{t('periods.current')}</small><strong>{openPeriod.label}</strong><p>{t('periods.openedSince', { date: new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(openPeriod.startsAt)) })}</p></div></section> : null}
      <h3>{t('periods.closedSettlements')}</h3>
      {settlementsQuery.data.length === 0 ? <StatePanel kind="empty" message={t('periods.empty')} /> : (
        <div className={tableStyles.tableWrap}>
          <table className={tableStyles.table}><thead><tr><th>{t('periods.period')}</th><th>{t('common.member')}</th><th>{t('periods.due')}</th><th className={tableStyles.number}>{t('periods.claim')}</th><th className={tableStyles.number}>{t('periods.paid')}</th><th>{t('common.status')}</th><th><span className="sr-only">{t('common.action')}</span></th></tr></thead><tbody>{settlementsQuery.data.map((settlement) => <tr key={settlement.id}><td><strong>{settlement.periodLabel}</strong></td><td>{settlement.memberName}</td><td>{new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(settlement.dueAt))}</td><td className={tableStyles.number}>{formatMoney(settlement.amount)}</td><td className={tableStyles.number}>{formatMoney(settlement.paidAmount)}</td><td><span className={`${tableStyles.status} ${settlement.status === 'PARTIAL' || settlement.status === 'OPEN' ? tableStyles.statusWarning : ''}`}>{settlement.status === 'PAID' ? t('common.paid') : settlement.status === 'PARTIAL' ? t('common.partiallyPaid') : settlement.status === 'CREDIT' ? t('common.credit') : t('common.open')}</span></td><td><Button leadingIcon={<Printer size={16} />} onClick={() => window.print()} size="small" variant="ghost">{t('common.print')}</Button></td></tr>)}</tbody></table>
        </div>
      )}
      <Modal onClose={() => setPeriodToClose(null)} open={Boolean(periodToClose)} title={t('periods.closeDialog')}>
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); closeMutation.mutate(); }}>
          <p>{t('periods.closeExplanation')}</p>
          <Field htmlFor="period-label" label={t('periods.label')}><TextInput id="period-label" onChange={(event) => setLabel(event.target.value)} required value={label} /></Field>
          <Field htmlFor="period-due" label={t('periods.paymentDue')}><TextInput id="period-due" onChange={(event) => setDueAt(event.target.value)} required type="date" value={dueAt} /></Field>
          {closeMutation.isError ? <p className={styles.error} role="alert">{closeMutation.error.message}</p> : null}
          <div className={styles.actions}><Button onClick={() => setPeriodToClose(null)} variant="secondary">{t('common.cancel')}</Button><Button disabled={!label.trim() || !dueAt || closeMutation.isPending} type="submit">{t('periods.confirmClose')}</Button></div>
        </form>
      </Modal>
    </div>
  );
}
