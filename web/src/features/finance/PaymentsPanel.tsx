import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import CircleDollarSign from 'lucide-react/dist/esm/icons/circle-dollar-sign';
import Plus from 'lucide-react/dist/esm/icons/plus';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import X from 'lucide-react/dist/esm/icons/x';
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
  const accountsQuery = useQuery({ queryKey: ['account-summaries', activeGroupId], queryFn: () => api.getAccountSummaries(activeGroupId) });
  const transactionSettingsQuery = useQuery({ queryKey: ['transaction-settings', activeGroupId], queryFn: () => api.getTransactionSettings(activeGroupId) });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [membershipId, setMembershipId] = useState('');
  const [amount, setAmount] = useState('');
  const [receivedAt, setReceivedAt] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<Payment['method']>('');
  const [reference, setReference] = useState('');
  const [paymentToReverse, setPaymentToReverse] = useState<Payment | null>(null);
  const [reversalReason, setReversalReason] = useState('');
  const activeAccounts = accountsQuery.data?.filter((account) => account.status === 'ACTIVE') ?? [];
  const regularAccounts = activeAccounts.filter((account) => !account.isTemporaryGuest);
  const temporaryGuestAccounts = activeAccounts.filter((account) => account.isTemporaryGuest);
  const archivedAccounts = accountsQuery.data?.filter((account) => account.status === 'ARCHIVED') ?? [];
  const deletedAccounts = accountsQuery.data?.filter((account) => account.status === 'DELETED' && BigInt(account.balance.minorUnits) > 0n) ?? [];
  const defaultAccount = regularAccounts[0] ?? temporaryGuestAccounts[0] ?? archivedAccounts[0] ?? deletedAccounts[0];
  const selectedMembershipId = membershipId || defaultAccount?.membershipId || '';
  const reasonMode = transactionSettingsQuery.data?.otherPaymentReasonMode
    ?? (transactionSettingsQuery.data?.otherPaymentReasonRequired ? 'REQUIRED' : 'OPTIONAL');
  const reasonEnabled = reasonMode !== 'OFF';
  const reasonRequired = reasonMode === 'REQUIRED';
  const openRecordDialog = () => {
    setMethod(transactionSettingsQuery.data?.paymentMethods[0]?.id ?? '');
    setDialogOpen(true);
  };
  const invalidateFinancialReads = async () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['payments', activeGroupId] }),
    queryClient.invalidateQueries({ queryKey: ['account-summaries', activeGroupId] }),
    queryClient.invalidateQueries({ queryKey: ['ledger', activeGroupId] }),
    queryClient.invalidateQueries({ queryKey: ['settlements', activeGroupId] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard', activeGroupId] }),
  ]);
  const paymentMutation = useMutation({
    mutationFn: () => api.createPayment(activeGroupId, { membershipId: selectedMembershipId, amount: { minorUnits: parseMajorUnits(amount, activeGroup.currency), currency: activeGroup.currency }, receivedAt, method, reference: reasonEnabled ? reference.trim() || undefined : undefined }),
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

  if (paymentsQuery.isLoading || accountsQuery.isLoading || transactionSettingsQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (!paymentsQuery.data || !accountsQuery.data || !transactionSettingsQuery.data) return <div className={styles.state}><StatePanel kind="error" message={t('finance.error')} /></div>;

  const total = paymentsQuery.data.filter((payment) => payment.status === 'POSTED').reduce((sum, payment) => sum + BigInt(payment.amount.minorUnits), 0n);
  return (
    <div className={styles.content}>
      <header className={styles.header}><div><h2>{t('finance.title')}</h2><p>{t('finance.intro')}</p></div><Button leadingIcon={<Plus size={18} />} onClick={openRecordDialog}>{t('finance.record')}</Button></header>
      <section className={styles.summary}><CircleDollarSign aria-hidden="true" size={28} /><div><span>{t('finance.recorded')}</span><strong>{formatMoney({ minorUnits: total.toString(), currency: activeGroup.currency })}</strong></div><small>{t('finance.transactionCount', { count: paymentsQuery.data.length })}</small></section>
      {paymentsQuery.data.length === 0 ? <StatePanel actionLabel={t('finance.record')} kind="empty" message={t('finance.empty')} onAction={openRecordDialog} /> : (
        <div className={tableStyles.tableWrap}>
          <table className={tableStyles.table}><thead><tr><th>{t('common.date')}</th><th>{t('common.member')}</th><th>{t('finance.paymentType')}</th><th>{t('finance.reason')}</th><th className={tableStyles.number}>{t('common.amount')}</th><th>{t('common.status')}</th><th><span className="sr-only">{t('common.action')}</span></th></tr></thead><tbody>{paymentsQuery.data.map((payment) => <tr key={payment.id}><td>{new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(payment.receivedAt))}</td><td><strong>{payment.memberName}</strong>{payment.membershipStatus === 'DELETED' ? <span className={tableStyles.status}>{t('common.deleted')}</span> : null}</td><td>{payment.methodLabel}</td><td>{payment.reference ?? '–'}</td><td className={tableStyles.number}>{formatMoney(payment.amount)}</td><td><span className={`${tableStyles.status} ${payment.status === 'REVERSED' ? tableStyles.statusMuted : ''}`}>{payment.status === 'POSTED' ? t('common.booked') : t('common.reversed')}</span></td><td>{payment.status === 'POSTED' ? <Button leadingIcon={<RotateCcw size={16} />} onClick={() => setPaymentToReverse(payment)} size="small" variant="ghost">{t('finance.reverse')}</Button> : null}</td></tr>)}</tbody></table>
        </div>
      )}
      <Modal onClose={() => setDialogOpen(false)} open={dialogOpen} title={t('finance.record')}>
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); paymentMutation.mutate(); }}>
          <Field htmlFor="payment-member" label={t('common.member')}>
            <SelectInput id="payment-member" onChange={(event) => setMembershipId(event.target.value)} value={membershipId || defaultAccount?.membershipId}>
              {regularAccounts.length > 0 ? <optgroup label={t('booking.regularMembers')}>{regularAccounts.map((account) => <option key={account.membershipId} value={account.membershipId}>{account.displayName}</option>)}</optgroup> : null}
              {temporaryGuestAccounts.length > 0 ? <optgroup label={t('booking.guests')}>{temporaryGuestAccounts.map((account) => <option key={account.membershipId} value={account.membershipId}>{account.displayName}</option>)}</optgroup> : null}
              {archivedAccounts.length > 0 ? <optgroup label={t('financeWorkspace.archivedMembers')}>{archivedAccounts.map((account) => <option key={account.membershipId} value={account.membershipId}>{account.displayName}</option>)}</optgroup> : null}
              {deletedAccounts.length > 0 ? <optgroup label={t('financeWorkspace.deletedAccounts')}>{deletedAccounts.map((account) => <option key={account.membershipId} value={account.membershipId}>{account.displayName}</option>)}</optgroup> : null}
            </SelectInput>
          </Field>
          <div className={styles.formRow}><Field htmlFor="payment-amount" label={`${t('finance.amountIn', { currency: activeGroup.currency })} *`}><TextInput id="payment-amount" inputMode="decimal" onChange={(event) => setAmount(event.target.value)} pattern={majorUnitsInputPattern(activeGroup.currency)} placeholder={majorUnitsPlaceholder(activeGroup.currency)} required type="text" value={amount} /></Field><Field htmlFor="payment-date" label={t('finance.receivedDate')}><TextInput id="payment-date" onChange={(event) => setReceivedAt(event.target.value)} required type="date" value={receivedAt} /></Field></div>
          <Field htmlFor="payment-method" label={t('finance.paymentType')}><SelectInput id="payment-method" onChange={(event) => setMethod(event.target.value)} required value={method}>{transactionSettingsQuery.data.paymentMethods.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</SelectInput></Field>
          {reasonEnabled ? <Field htmlFor="payment-reference" label={`${t('finance.reason')}${reasonRequired ? ' *' : ''}`}><TextInput id="payment-reference" list="payment-reason-suggestions" maxLength={120} onChange={(event) => setReference(event.target.value)} required={reasonRequired} value={reference} /><datalist id="payment-reason-suggestions">{transactionSettingsQuery.data.paymentReasons.map((item) => <option key={item.id} value={item.label} />)}</datalist></Field> : null}
          {paymentMutation.isError ? <p className={styles.error} role="alert">{paymentMutation.error.message}</p> : null}
          <div className={styles.actions}><Button leadingIcon={<X size={17} />} onClick={() => setDialogOpen(false)} variant="secondary">{t('common.cancel')}</Button><Button disabled={!amount || !method || (reasonRequired && !reference.trim()) || paymentMutation.isPending} leadingIcon={<CircleDollarSign size={17} />} type="submit">{t('finance.bookPayment')}</Button></div>
        </form>
      </Modal>
      <Modal onClose={() => setPaymentToReverse(null)} open={Boolean(paymentToReverse)} title={t('finance.reverseTitle')}>
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); reversalMutation.mutate(); }}>
          <p className={styles.explanation}>{t('finance.reverseExplanation')}</p>
          <Field htmlFor="payment-reversal-reason" label={t('finance.reason')}><TextInput id="payment-reversal-reason" onChange={(event) => setReversalReason(event.target.value)} required value={reversalReason} /></Field>
          {reversalMutation.isError ? <p className={styles.error} role="alert">{reversalMutation.error.message}</p> : null}
          <div className={styles.actions}><Button leadingIcon={<X size={17} />} onClick={() => setPaymentToReverse(null)} variant="secondary">{t('common.cancel')}</Button><Button disabled={!reversalReason.trim() || reversalMutation.isPending} leadingIcon={<RotateCcw size={17} />} type="submit">{t('finance.confirmReverse')}</Button></div>
        </form>
      </Modal>
    </div>
  );
}
