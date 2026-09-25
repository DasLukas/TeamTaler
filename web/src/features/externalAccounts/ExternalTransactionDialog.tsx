import { useMutation, useQueryClient } from '@tanstack/react-query';
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left';
import CircleCheck from 'lucide-react/dist/esm/icons/circle-check';
import Save from 'lucide-react/dist/esm/icons/save';
import X from 'lucide-react/dist/esm/icons/x';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney, majorUnitsInputPattern, majorUnitsPlaceholder, minorUnitsToSafeNumber } from '@/api/money';
import type { ExternalAccount, ExternalAccountTransactionInput } from '@/api/types';
import { useInstanceCapabilities } from '@/app/useSession';
import { Button } from '@/components/ui/Button';
import { Field, TextArea, TextInput } from '@/components/ui/FormField';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { SelectMenu } from '@/components/ui/SelectMenu';
import { PaymentAttachmentField } from '@/features/finance/PaymentAttachmentField';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { ExternalAccountTransactionKindIcon } from './ExternalAccountTransactionKindIcon';
import { ExternalAccountTypeIcon } from './ExternalAccountTypeIcon';
import { externalAccountKeys } from './externalAccountQueryKeys';
import { validateExternalAccountPositiveAmount } from './externalAccountValidation';
import styles from './ExternalAccountDialogs.module.css';

interface ExternalTransactionDialogProps {
  accounts: ExternalAccount[];
  currency: string;
  groupId: string;
  onAccessError: (error: unknown) => boolean;
  onClose: () => void;
}

/** Records a reviewed manual account flow independently of earlier transactions. */
export function ExternalTransactionDialog({ accounts, currency, groupId, onAccessError, onClose }: ExternalTransactionDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { attachmentUploadMaxBytes } = useInstanceCapabilities();
  const compact = useMediaQuery('(max-width: 600px)');
  const entryFormId = useId();
  const [step, setStep] = useState<'entry' | 'review'>('entry');
  const [kind, setKind] = useState<ExternalAccountTransactionInput['kind']>('INCOME');
  const [sourceAccountChoice, setSourceAccountChoice] = useState(accounts.find((account) => account.status === 'ACTIVE')?.id ?? '');
  const [destinationAccountChoice, setDestinationAccountChoice] = useState(accounts.find((account) => account.status === 'ACTIVE')?.id ?? '');
  const [amount, setAmount] = useState('');
  const [amountError, setAmountError] = useState('');
  const [occurredAt, setOccurredAt] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [command, setCommand] = useState<ExternalAccountTransactionInput>();
  const activeAccounts = accounts.filter((account) => account.status === 'ACTIVE');
  const selectedKind = kind === 'TRANSFER' && activeAccounts.length < 2 ? 'INCOME' : kind;
  const sourceAccountId = activeAccounts.find((account) => account.id === sourceAccountChoice)?.id ?? activeAccounts[0]?.id ?? '';
  const destinationAccountId = activeAccounts.find((account) => account.id === destinationAccountChoice && (selectedKind !== 'TRANSFER' || account.id !== sourceAccountId))?.id
    ?? activeAccounts.find((account) => selectedKind !== 'TRANSFER' || account.id !== sourceAccountId)?.id
    ?? '';
  const usesSource = selectedKind === 'EXPENSE' || selectedKind === 'TRANSFER';
  const usesDestination = selectedKind === 'INCOME' || selectedKind === 'TRANSFER';
  const transactionKindOptions = [
    { label: t('externalAccounts.kinds.INCOME'), value: 'INCOME', visual: <ExternalAccountTransactionKindIcon kind="INCOME" /> },
    { label: t('externalAccounts.kinds.EXPENSE'), value: 'EXPENSE', visual: <ExternalAccountTransactionKindIcon kind="EXPENSE" /> },
    ...(activeAccounts.length >= 2 ? [{ label: t('externalAccounts.kinds.TRANSFER'), value: 'TRANSFER' as const, visual: <ExternalAccountTransactionKindIcon kind="TRANSFER" /> }] : []),
  ] as const;
  const accountOptions = activeAccounts.map((account) => ({
    label: account.name,
    value: account.id,
    visual: <ExternalAccountTypeIcon type={account.type} />,
  }));

  const selectedSource = activeAccounts.find((account) => account.id === sourceAccountId);
  const wouldBeNegative = Boolean(selectedSource && command && usesSource && BigInt(selectedSource.balance.minorUnits) - BigInt(String(command.amountMinor)) < 0n);
  const accountsValid = selectedKind === 'TRANSFER' ? Boolean(sourceAccountId && destinationAccountId && sourceAccountId !== destinationAccountId) : usesSource ? Boolean(sourceAccountId) : Boolean(destinationAccountId);
  const valid = Boolean(amount && occurredAt && reason.trim() && accountsValid);

  const prepareReview = () => {
    const validation = validateExternalAccountPositiveAmount(amount, currency);
    if (!validation.minorUnits) {
      setAmountError(validation.error ?? t('errors.amountFormat'));
      return;
    }
    if (!valid) return;
    setAmountError('');
    setCommand({
      kind: selectedKind,
      occurredAt,
      amountMinor: minorUnitsToSafeNumber(validation.minorUnits),
      ...(usesSource ? { sourceAccountId } : {}),
      ...(usesDestination ? { destinationAccountId } : {}),
      reason: reason.trim(),
      ...(reference.trim() ? { reference: reference.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    setStep('review');
  };

  const mutation = useMutation({
    mutationFn: async () => {
      if (!command) return Promise.reject(new Error(t('externalAccounts.transactionMissing')));
      return api.createExternalAccountTransaction(groupId, command, attachment ?? undefined);
    },
    onError: (error) => { onAccessError(error); },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: externalAccountKeys.all(groupId) }),
        queryClient.invalidateQueries({ queryKey: ['dashboard', groupId] }),
      ]);
      onClose();
    },
  });

  return <Modal onClose={onClose} open title={t('externalAccounts.recordTransaction')} variant={compact ? 'sheet' : 'dialog'}>
    {step === 'entry' ? <form className={styles.form} id={entryFormId} onSubmit={(event) => { event.preventDefault(); prepareReview(); }}>
      <div className={styles.grid}>
        <Field htmlFor="external-transaction-kind" label={t('externalAccounts.fields.kind')} required><SelectMenu id="external-transaction-kind" onChange={setKind} options={transactionKindOptions} value={selectedKind} /></Field>
        <Field error={amountError || undefined} htmlFor="external-transaction-amount" label={`${t('common.amount')} (${currency})`} required><TextInput id="external-transaction-amount" inputMode="decimal" onChange={(event) => { setAmount(event.target.value); setAmountError(''); }} pattern={majorUnitsInputPattern(currency)} placeholder={majorUnitsPlaceholder(currency)} required value={amount} /></Field>
        {usesSource ? <Field htmlFor="external-transaction-source" label={t('externalAccounts.fields.sourceAccount')} required><SelectMenu id="external-transaction-source" onChange={setSourceAccountChoice} options={accountOptions} value={sourceAccountId} /></Field> : null}
        {usesDestination ? <Field htmlFor="external-transaction-destination" label={t('externalAccounts.fields.destinationAccount')} required><SelectMenu id="external-transaction-destination" onChange={setDestinationAccountChoice} options={accountOptions.map((option) => ({ ...option, disabled: selectedKind === 'TRANSFER' && option.value === sourceAccountId }))} value={destinationAccountId} /></Field> : null}
        <Field htmlFor="external-transaction-date" label={t('common.date')} required><TextInput id="external-transaction-date" onChange={(event) => setOccurredAt(event.target.value)} required type="date" value={occurredAt} /></Field>
        <Field htmlFor="external-transaction-reason" label={t('externalAccounts.fields.reason')} required><TextInput id="external-transaction-reason" maxLength={120} onChange={(event) => setReason(event.target.value)} required value={reason} /></Field>
        <Field htmlFor="external-transaction-reference" label={t('externalAccounts.fields.reference')}><TextInput id="external-transaction-reference" maxLength={120} onChange={(event) => setReference(event.target.value)} value={reference} /></Field>
      </div>
      <Field htmlFor="external-transaction-note" label={t('externalAccounts.fields.note')}><TextArea id="external-transaction-note" maxLength={2000} onChange={(event) => setNote(event.target.value)} value={note} /></Field>
      <PaymentAttachmentField attachmentMode="OPTIONAL" file={attachment} maxBytes={attachmentUploadMaxBytes} onChange={setAttachment} showOptionalLabel={false} />
      <ModalFooter><div className={styles.actions}><Button leadingIcon={<X size={17} />} onClick={onClose} variant="secondary">{t('common.cancel')}</Button><Button disabled={!valid} form={entryFormId} leadingIcon={<CircleCheck size={17} />} type="submit">{t('externalAccounts.review')}</Button></div></ModalFooter>
    </form> : command ? <div className={styles.review}>
      <p>{t('externalAccounts.reviewTransactionIntro')}</p>
      <dl><div><dt>{t('externalAccounts.fields.kind')}</dt><dd>{t(`externalAccounts.kinds.${command.kind}`)}</dd></div><div><dt>{t('common.amount')}</dt><dd>{formatMoney({ minorUnits: String(command.amountMinor), currency })}</dd></div><div><dt>{t('externalAccounts.fields.reason')}</dt><dd>{command.reason}</dd></div>{attachment ? <div><dt>{t('paymentAttachment.label')}</dt><dd>{attachment.name}</dd></div> : null}</dl>
      {wouldBeNegative ? <p className={styles.warning} role="status">{t('externalAccounts.negativeBalanceWarning')}</p> : null}
      {mutation.isError ? <p className={styles.error} role="alert">{mutation.error.message}</p> : null}
      <ModalFooter><div className={styles.actions}><Button disabled={mutation.isPending} leadingIcon={<ArrowLeft size={17} />} onClick={() => setStep('entry')} variant="secondary">{t('common.back')}</Button><Button disabled={mutation.isPending} leadingIcon={<Save size={17} />} onClick={() => mutation.mutate()}>{mutation.isPending ? t('behaviorSettings.saving') : t('common.save')}</Button></div></ModalFooter>
    </div> : null}
  </Modal>;
}
