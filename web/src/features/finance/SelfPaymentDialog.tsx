import { useMutation, useQueryClient } from '@tanstack/react-query';
import CheckCircle2 from 'lucide-react/dist/esm/icons/check-circle-2';
import CircleDollarSign from 'lucide-react/dist/esm/icons/circle-dollar-sign';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney, majorUnitsInputPattern, majorUnitsInputValue, majorUnitsPlaceholder, validatePositiveMajorUnits } from '@/api/money';
import type { Dashboard, Money, Payment, SelfPaymentCommand } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput, TextInput } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { PAYMENT_METHOD_OPTIONS, paymentMethodLabelKey } from './paymentMethods';
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
  const [method, setMethod] = useState<Payment['method']>('BANK_TRANSFER');
  const [reference, setReference] = useState('');
  const [referenceError, setReferenceError] = useState('');
  const [command, setCommand] = useState<SelfPaymentCommand | null>(null);
  const [updatedBalance, setUpdatedBalance] = useState<Money | null>(null);

  const reset = () => {
    setStep('entry');
    setAmount('');
    setAmountError('');
    setReceivedAt(localDateInputValue(new Date()));
    setMethod('BANK_TRANSFER');
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
    if (!trimmedReference) {
      setReferenceError(t('selfPayment.referenceRequired'));
      return;
    }
    setAmountError('');
    setReferenceError('');
    setCommand({
      amount: { minorUnits: validation.minorUnits, currency: activeGroup.currency },
      receivedAt,
      method,
      reference: trimmedReference,
    });
    setStep('review');
  };

  const paymentMethod = command ? t(paymentMethodLabelKey(command.method)) : '';

  return (
    <>
      <Button className={className} fullWidth={fullWidth} leadingIcon={<CircleDollarSign size={18} />} onClick={openDialog}>
        {t('selfPayment.action')}
      </Button>
      <Modal className={styles.dialog} onClose={closeDialog} open={open} title={t(`selfPayment.${step}Title`)} variant={compact ? 'sheet' : 'dialog'}>
        {step === 'entry' ? (
          <form className={styles.form} onSubmit={(event) => { event.preventDefault(); prepareReview(); }}>
            <div className={styles.account}><span>{t('selfPayment.account')}</span><strong>{session.user.displayName}</strong><small>{activeGroup.name}</small></div>
            <Field error={amountError || undefined} htmlFor="self-payment-amount" label={t('finance.amountIn', { currency: activeGroup.currency })}>
              <TextInput id="self-payment-amount" inputMode="decimal" onChange={(event) => { setAmount(event.target.value); setAmountError(''); }} pattern={majorUnitsInputPattern(activeGroup.currency)} placeholder={majorUnitsPlaceholder(activeGroup.currency)} required type="text" value={amount} />
            </Field>
            {BigInt(openBalance.minorUnits) > 0n ? <Button fullWidth onClick={() => { setAmount(majorUnitsInputValue(openBalance)); setAmountError(''); }} variant="secondary">{t('selfPayment.useOpenBalance', { amount: formatMoney(openBalance) })}</Button> : null}
            <div className={styles.formRow}>
              <Field htmlFor="self-payment-date" label={t('finance.receivedDate')}><TextInput id="self-payment-date" onChange={(event) => setReceivedAt(event.target.value)} required type="date" value={receivedAt} /></Field>
              <Field htmlFor="self-payment-method" label={t('finance.paymentType')}><SelectInput id="self-payment-method" onChange={(event) => setMethod(event.target.value as Payment['method'])} value={method}>{PAYMENT_METHOD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}</SelectInput></Field>
            </div>
            <Field error={referenceError || undefined} htmlFor="self-payment-reference" label={t('common.reference')}><TextInput id="self-payment-reference" maxLength={120} onChange={(event) => { setReference(event.target.value); setReferenceError(''); }} placeholder={t('finance.referencePlaceholder')} required value={reference} /></Field>
            <div className={styles.actions}><Button onClick={closeDialog} variant="secondary">{t('common.cancel')}</Button><Button type="submit">{t('selfPayment.review')}</Button></div>
          </form>
        ) : null}

        {step === 'review' && command ? (
          <div className={styles.review}>
            <p>{t('selfPayment.reviewIntro')}</p>
            <dl>
              <div><dt>{t('selfPayment.account')}</dt><dd>{session.user.displayName}</dd></div>
              <div><dt>{t('common.amount')}</dt><dd><strong>{formatMoney(command.amount)}</strong></dd></div>
              <div><dt>{t('common.date')}</dt><dd>{new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(`${receivedAt}T12:00:00`))}</dd></div>
              <div><dt>{t('finance.paymentType')}</dt><dd>{paymentMethod}</dd></div>
              <div><dt>{t('common.reference')}</dt><dd>{command.reference}</dd></div>
            </dl>
            {mutation.isError ? <p className={styles.error} role="alert">{mutation.error.message}</p> : null}
            <div className={styles.actions}><Button disabled={mutation.isPending} onClick={() => { mutation.reset(); setStep('entry'); }} variant="secondary">{t('common.back')}</Button><Button disabled={mutation.isPending} onClick={() => mutation.mutate(command)}>{mutation.isPending ? t('selfPayment.pending') : t('selfPayment.confirm', { amount: formatMoney(command.amount) })}</Button></div>
          </div>
        ) : null}

        {step === 'success' && command && updatedBalance ? (
          <div aria-live="polite" className={styles.success} role="status">
            <CheckCircle2 aria-hidden="true" size={44} strokeWidth={1.6} />
            <h3>{t('selfPayment.successHeading', { amount: formatMoney(command.amount) })}</h3>
            <p>{t('selfPayment.updatedBalance')}</p>
            <strong>{formatMoney(updatedBalance)}</strong>
            <Button fullWidth onClick={closeDialog}>{t('common.done')}</Button>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
