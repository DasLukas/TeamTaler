import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import CircleDollarSign from 'lucide-react/dist/esm/icons/circle-dollar-sign';
import Plus from 'lucide-react/dist/esm/icons/plus';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney, majorUnitsInputPattern, majorUnitsPlaceholder, parseMajorUnits } from '@/api/money';
import type { Payment } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput, TextInput } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { StatePanel } from '@/components/ui/StatePanel';
import tableStyles from '@/features/shared/Table.module.css';
import { PAYMENT_METHOD_OPTIONS, paymentMethodLabelKey } from './paymentMethods';
import styles from './PaymentsPanel.module.css';

/**
 * Renders the finance workspace for auditable incoming payments.
 *
 * @returns A localized payment ledger with create and reversal dialogs.
 */
export function PaymentsPanel() {
  const { t } = useTranslation();
  const { activeGroupId, activeGroup } = useActiveGroup();
  const queryClient = useQueryClient();
  const paymentsQuery = useQuery({ queryKey: ['payments', activeGroupId], queryFn: () => api.getPayments(activeGroupId) });
  const membersQuery = useQuery({ queryKey: ['members', activeGroupId], queryFn: () => api.getMembers(activeGroupId) });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [membershipId, setMembershipId] = useState('');
  const [amount, setAmount] = useState('');
  const [receivedAt, setReceivedAt] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<Payment['method']>('BANK_TRANSFER');
  const [reference, setReference] = useState('');
  const [paymentToReverse, setPaymentToReverse] = useState<Payment | null>(null);
  const [reversalReason, setReversalReason] = useState('');
  const activeMembers = membersQuery.data?.filter((member) => member.active) ?? [];
  const invalidateFinancialReads = async () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['payments', activeGroupId] }),
    queryClient.invalidateQueries({ queryKey: ['account-summaries', activeGroupId] }),
    queryClient.invalidateQueries({ queryKey: ['ledger', activeGroupId] }),
    queryClient.invalidateQueries({ queryKey: ['settlements', activeGroupId] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard', activeGroupId] }),
  ]);
  const paymentMutation = useMutation({
    mutationFn: () => api.createPayment(activeGroupId, { membershipId: membershipId || activeMembers[0]?.id || '', amount: { minorUnits: parseMajorUnits(amount, activeGroup.currency), currency: activeGroup.currency }, receivedAt, method, reference: reference.trim() || undefined }),
    onSuccess: async () => {
      setDialogOpen(false);
      setAmount('');
      setReference('');
      await invalidateFinancialReads();
    },
  });
  const reversalMutation = useMutation({
    mutationFn: () => paymentToReverse ? api.reversePayment(activeGroupId, paymentToReverse.id, reversalReason.trim()) : Promise.reject(new Error(t('finance.noPaymentSelected'))),
    onSuccess: async () => {
      setPaymentToReverse(null);
      setReversalReason('');
      await invalidateFinancialReads();
    },
  });

  if (paymentsQuery.isLoading || membersQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (!paymentsQuery.data || !membersQuery.data) return <div className={styles.state}><StatePanel kind="error" message={t('finance.error')} /></div>;

  const total = paymentsQuery.data.filter((payment) => payment.status === 'POSTED').reduce((sum, payment) => sum + BigInt(payment.amount.minorUnits), 0n);
  return (
    <div className={styles.content}>
      <header className={styles.header}><div><h2>{t('finance.title')}</h2><p>{t('finance.intro')}</p></div><Button leadingIcon={<Plus size={18} />} onClick={() => setDialogOpen(true)}>{t('finance.record')}</Button></header>
      <section className={styles.summary}><CircleDollarSign aria-hidden="true" size={28} /><div><span>{t('finance.recorded')}</span><strong>{formatMoney({ minorUnits: total.toString(), currency: activeGroup.currency })}</strong></div><small>{t('finance.transactionCount', { count: paymentsQuery.data.length })}</small></section>
      {paymentsQuery.data.length === 0 ? <StatePanel actionLabel={t('finance.record')} kind="empty" message={t('finance.empty')} onAction={() => setDialogOpen(true)} /> : (
        <div className={tableStyles.tableWrap}>
          <table className={tableStyles.table}><thead><tr><th>{t('common.date')}</th><th>{t('common.member')}</th><th>{t('finance.paymentType')}</th><th>{t('common.reference')}</th><th className={tableStyles.number}>{t('common.amount')}</th><th>{t('common.status')}</th><th><span className="sr-only">{t('common.action')}</span></th></tr></thead><tbody>{paymentsQuery.data.map((payment) => <tr key={payment.id}><td>{new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(payment.receivedAt))}</td><td><strong>{payment.memberName}</strong></td><td>{t(paymentMethodLabelKey(payment.method))}</td><td>{payment.reference ?? '–'}</td><td className={tableStyles.number}>{formatMoney(payment.amount)}</td><td><span className={`${tableStyles.status} ${payment.status === 'REVERSED' ? tableStyles.statusMuted : ''}`}>{payment.status === 'POSTED' ? t('common.booked') : t('common.reversed')}</span></td><td>{payment.status === 'POSTED' ? <Button leadingIcon={<RotateCcw size={16} />} onClick={() => setPaymentToReverse(payment)} size="small" variant="ghost">{t('finance.reverse')}</Button> : null}</td></tr>)}</tbody></table>
        </div>
      )}
      <Modal onClose={() => setDialogOpen(false)} open={dialogOpen} title={t('finance.record')}>
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); paymentMutation.mutate(); }}>
          <Field htmlFor="payment-member" label={t('common.member')}><SelectInput id="payment-member" onChange={(event) => setMembershipId(event.target.value)} value={membershipId || activeMembers[0]?.id}>{activeMembers.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</SelectInput></Field>
          <div className={styles.formRow}><Field htmlFor="payment-amount" label={t('finance.amountIn', { currency: activeGroup.currency })}><TextInput id="payment-amount" inputMode="decimal" onChange={(event) => setAmount(event.target.value)} pattern={majorUnitsInputPattern(activeGroup.currency)} placeholder={majorUnitsPlaceholder(activeGroup.currency)} required type="text" value={amount} /></Field><Field htmlFor="payment-date" label={t('finance.receivedDate')}><TextInput id="payment-date" onChange={(event) => setReceivedAt(event.target.value)} required type="date" value={receivedAt} /></Field></div>
          <Field htmlFor="payment-method" label={t('finance.paymentType')}><SelectInput id="payment-method" onChange={(event) => setMethod(event.target.value as Payment['method'])} value={method}>{PAYMENT_METHOD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}</SelectInput></Field>
          <Field htmlFor="payment-reference" label={t('common.reference')}><TextInput id="payment-reference" onChange={(event) => setReference(event.target.value)} placeholder={t('finance.referencePlaceholder')} value={reference} /></Field>
          {paymentMutation.isError ? <p className={styles.error} role="alert">{paymentMutation.error.message}</p> : null}
          <div className={styles.actions}><Button onClick={() => setDialogOpen(false)} variant="secondary">{t('common.cancel')}</Button><Button disabled={!amount || paymentMutation.isPending} type="submit">{t('finance.bookPayment')}</Button></div>
        </form>
      </Modal>
      <Modal onClose={() => setPaymentToReverse(null)} open={Boolean(paymentToReverse)} title={t('finance.reverseTitle')}>
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); reversalMutation.mutate(); }}>
          <p className={styles.explanation}>{t('finance.reverseExplanation')}</p>
          <Field htmlFor="payment-reversal-reason" label={t('finance.reason')}><TextInput id="payment-reversal-reason" onChange={(event) => setReversalReason(event.target.value)} required value={reversalReason} /></Field>
          {reversalMutation.isError ? <p className={styles.error} role="alert">{reversalMutation.error.message}</p> : null}
          <div className={styles.actions}><Button onClick={() => setPaymentToReverse(null)} variant="secondary">{t('common.cancel')}</Button><Button disabled={!reversalReason.trim() || reversalMutation.isPending} type="submit">{t('finance.confirmReverse')}</Button></div>
        </form>
      </Modal>
    </div>
  );
}
