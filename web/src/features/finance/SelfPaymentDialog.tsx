import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import CheckCircle2 from 'lucide-react/dist/esm/icons/check-circle-2';
import CircleDollarSign from 'lucide-react/dist/esm/icons/circle-dollar-sign';
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left';
import CircleCheck from 'lucide-react/dist/esm/icons/circle-check';
import X from 'lucide-react/dist/esm/icons/x';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney, isCreditBalance, majorUnitsInputPattern, majorUnitsInputValue, majorUnitsPlaceholder, validatePositiveMajorUnits } from '@/api/money';
import type { Dashboard, Money, Payment, SelfPaymentCommand } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput, TextInput } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import styles from './SelfPaymentDialog.module.css';

type SelfPaymentStep = 'entry' | 'review' | 'success';

/**
 * Formats a local calendar day for an HTML date input without UTC drift.
 *
 * @param date - Local date whose calendar components should be preserved.
 * @returns A `YYYY-MM-DD` value suitable for a date input.
 */
function localDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Properties accepted by the reusable own-account payment action. */
export interface SelfPaymentDialogProps {
  openBalance: Money;
  className?: string;
  fullWidth?: boolean;
}

/**
 * Renders a permission-gated caller's own-payment button and reviewed flow.
 *
 * The component never accepts a membership identifier. The API derives the
 * payment target from the authenticated session and rechecks authorization.
 *
 * @param props - Current open balance and optional trigger presentation.
 * @returns A trigger with a responsive entry, review, and success dialog.
 */
export function SelfPaymentDialog({ openBalance, className, fullWidth = false }: SelfPaymentDialogProps) {
  const { t } = useTranslation();
  const { activeGroupId, activeGroup, session } = useActiveGroup();
  const queryClient = useQueryClient();
  const compact = useMediaQuery('(max-width: 600px)');
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<SelfPaymentStep>('entry');
  const [amount, setAmount] = useState('');
  const [amountError, setAmountError] = useState('');
  const [receivedAt, setReceivedAt] = useState(() => localDateInputValue(new Date()));
  const transactionSettingsQuery = useQuery({ queryKey: ['transaction-settings', activeGroupId], queryFn: () => api.getTransactionSettings(activeGroupId) });
  const [method, setMethod] = useState<Payment['method']>('');
  const [reference, setReference] = useState('');
  const [referenceError, setReferenceError] = useState('');
  const [command, setCommand] = useState<SelfPaymentCommand | null>(null);
  const [updatedBalance, setUpdatedBalance] = useState<Money | null>(null);
  const reasonMode = transactionSettingsQuery.data?.ownPaymentReasonMode
    ?? (transactionSettingsQuery.data?.ownPaymentReasonRequired === false ? 'OPTIONAL' : 'REQUIRED');
  const reasonEnabled = reasonMode !== 'OFF';
  const reasonRequired = reasonMode === 'REQUIRED';

  const reset = () => {
    setStep('entry');
    setAmount('');
    setAmountError('');
    setReceivedAt(localDateInputValue(new Date()));
    setMethod(transactionSettingsQuery.data?.paymentMethods[0]?.id ?? '');
    setReference('');
    setReferenceError('');
    setCommand(null);
    setUpdatedBalance(null);
  };

  const mutation = useMutation({
    mutationFn: (input: SelfPaymentCommand) => api.createOwnPayment(activeGroupId, input),
    onSuccess: async (payment) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard', activeGroupId] }),
        queryClient.invalidateQueries({ queryKey: ['ledger', activeGroupId] }),
        queryClient.invalidateQueries({ queryKey: ['payments', activeGroupId] }),
        queryClient.invalidateQueries({ queryKey: ['account-summaries', activeGroupId] }),
        queryClient.invalidateQueries({ queryKey: ['settlements', activeGroupId] }),
      ]);
      const dashboard = queryClient.getQueryData<Dashboard>(['dashboard', activeGroupId]);
      setUpdatedBalance(dashboard?.openBalance ?? {
        minorUnits: (BigInt(openBalance.minorUnits) - BigInt(payment.amount.minorUnits)).toString(),
        currency: openBalance.currency,
      });
      setStep('success');
    },
  });

  const openDialog = () => {
    mutation.reset();
    reset();
    setMethod(transactionSettingsQuery.data?.paymentMethods[0]?.id ?? '');
    setOpen(true);
  };
  const closeDialog = () => {
    setOpen(false);
    mutation.reset();
    reset();
  };

  const prepareReview = () => {
    const validation = validatePositiveMajorUnits(amount, activeGroup.currency);
    if (!validation.minorUnits) {
      setAmountError(validation.error ?? t('errors.amountFormat'));
      return;
    }
    const trimmedReference = reference.trim();
    if (reasonRequired && !trimmedReference) {
      setReferenceError(t('selfPayment.referenceRequired'));
      return;
    }
    setAmountError('');
    setReferenceError('');
    setCommand({
      amount: { minorUnits: validation.minorUnits, currency: activeGroup.currency },
      receivedAt,
      method,
      reference: reasonEnabled ? trimmedReference || undefined : undefined,
    });
    setStep('review');
  };

  const paymentMethod = command ? transactionSettingsQuery.data?.paymentMethods.find((item) => item.id === command.method)?.label ?? command.method : '';
  const updatedBalanceIsCredit = updatedBalance ? isCreditBalance(updatedBalance) : false;

  return (
    <>
      <Button className={className} disabled={!transactionSettingsQuery.data?.paymentMethods.length} fullWidth={fullWidth} leadingIcon={<CircleDollarSign size={18} />} onClick={openDialog}>
        {t('selfPayment.action')}
      </Button>
      <Modal className={styles.dialog} onClose={closeDialog} open={open} title={t(`selfPayment.${step}Title`)} variant={compact ? 'sheet' : 'dialog'}>
        {step === 'entry' ? (
          <form className={styles.form} onSubmit={(event) => { event.preventDefault(); prepareReview(); }}>
            <Field error={amountError || undefined} htmlFor="self-payment-amount" label={t('finance.amountIn', { currency: activeGroup.currency })}>
              <TextInput id="self-payment-amount" inputMode="decimal" onChange={(event) => { setAmount(event.target.value); setAmountError(''); }} pattern={majorUnitsInputPattern(activeGroup.currency)} placeholder={majorUnitsPlaceholder(activeGroup.currency)} required type="text" value={amount} />
            </Field>
            {BigInt(openBalance.minorUnits) > 0n ? <Button fullWidth leadingIcon={<CircleDollarSign size={17} />} onClick={() => { setAmount(majorUnitsInputValue(openBalance)); setAmountError(''); }} variant="secondary">{t('selfPayment.useOpenBalance', { amount: formatMoney(openBalance) })}</Button> : null}
            <div className={styles.formRow}>
              <Field htmlFor="self-payment-date" label={t('finance.receivedDate')}><TextInput id="self-payment-date" onChange={(event) => setReceivedAt(event.target.value)} required type="date" value={receivedAt} /></Field>
              <Field htmlFor="self-payment-method" label={t('finance.paymentType')}><SelectInput id="self-payment-method" onChange={(event) => setMethod(event.target.value)} required value={method}>{transactionSettingsQuery.data?.paymentMethods.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</SelectInput></Field>
            </div>
            {reasonEnabled ? <Field error={referenceError || undefined} htmlFor="self-payment-reference" label={`${t('finance.reason')}${reasonRequired ? ' *' : ''}`}><TextInput id="self-payment-reference" list="self-payment-reason-suggestions" maxLength={120} onChange={(event) => { setReference(event.target.value); setReferenceError(''); }} required={reasonRequired} value={reference} /><datalist id="self-payment-reason-suggestions">{transactionSettingsQuery.data?.paymentReasons.map((item) => <option key={item.id} value={item.label} />)}</datalist></Field> : null}
            <div className={styles.actions}><Button leadingIcon={<X size={17} />} onClick={closeDialog} variant="secondary">{t('common.cancel')}</Button><Button leadingIcon={<CircleCheck size={17} />} type="submit">{t('selfPayment.review')}</Button></div>
          </form>
        ) : null}

        {step === 'review' && command ? (
          <div className={styles.review}>
            <p>{t('selfPayment.reviewIntro')}</p>
            <dl>
              <div><dt>{t('selfPayment.account')}</dt><dd>{session.user.displayName}</dd></div>
              <div><dt>{t('common.amount')}</dt><dd><strong className={styles.paymentAmount} data-financial-state="payment">{formatMoney(command.amount)}</strong></dd></div>
              <div><dt>{t('common.date')}</dt><dd>{new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(`${receivedAt}T12:00:00`))}</dd></div>
              <div><dt>{t('finance.paymentType')}</dt><dd>{paymentMethod}</dd></div>
              {reasonEnabled ? <div><dt>{t('finance.reason')}</dt><dd>{command.reference || '–'}</dd></div> : null}
            </dl>
            {mutation.isError ? <p className={styles.error} role="alert">{mutation.error.message}</p> : null}
            <div className={styles.actions}><Button disabled={mutation.isPending} leadingIcon={<ArrowLeft size={17} />} onClick={() => { mutation.reset(); setStep('entry'); }} variant="secondary">{t('common.back')}</Button><Button disabled={mutation.isPending} leadingIcon={<CircleDollarSign size={17} />} onClick={() => mutation.mutate(command)}>{mutation.isPending ? t('selfPayment.pending') : t('selfPayment.confirm', { amount: formatMoney(command.amount) })}</Button></div>
          </div>
        ) : null}

        {step === 'success' && command && updatedBalance ? (
          <div aria-live="polite" className={styles.success} role="status">
            <CheckCircle2 aria-hidden="true" size={44} strokeWidth={1.6} />
            <h3>{t('selfPayment.successHeading', { amount: formatMoney(command.amount) })}</h3>
            <p>{t('selfPayment.updatedBalance')}</p>
            <strong className={updatedBalanceIsCredit ? styles.creditBalance : undefined} data-financial-state={updatedBalanceIsCredit ? 'credit' : 'due'}>{formatMoney(updatedBalance)}</strong>
            <Button fullWidth leadingIcon={<CircleCheck size={17} />} onClick={closeDialog}>{t('common.done')}</Button>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
