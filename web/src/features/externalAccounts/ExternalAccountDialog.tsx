import { useMutation, useQueryClient } from '@tanstack/react-query';
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left';
import CircleCheck from 'lucide-react/dist/esm/icons/circle-check';
import Save from 'lucide-react/dist/esm/icons/save';
import X from 'lucide-react/dist/esm/icons/x';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { majorUnitsPlaceholder, minorUnitsToSafeNumber } from '@/api/money';
import type { ExternalAccount, ExternalAccountCreateInput, ExternalAccountDetails, ExternalAccountType, ExternalAccountUpdateInput, PaymentMethod } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Field, TextArea, TextInput } from '@/components/ui/FormField';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { MultiSelectMenu } from '@/components/ui/MultiSelectMenu';
import { SelectMenu } from '@/components/ui/SelectMenu';
import { isBicRequiredForIban, isPaypalMeHandle, isValidBic, isValidIban, normalizeBic, normalizeIban, normalizePaypalMeHandle } from '@/features/finance/paymentTargets';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { ExternalAccountTypeIcon } from './ExternalAccountTypeIcon';
import { externalAccountKeys } from './externalAccountQueryKeys';
import { parseOptionalSignedAmount, signedAmountPattern } from './externalAccountValidation';
import styles from './ExternalAccountDialogs.module.css';

interface ExternalAccountDialogProps {
  account?: ExternalAccount;
  currency: string;
  collectionVersion: number;
  groupId: string;
  onAccessError: (error: unknown) => boolean;
  onClose: () => void;
  paymentMethods: PaymentMethod[];
}

type DialogStep = 'entry' | 'review';

/** Creates or updates a provider-neutral external account and its payment-method links after an explicit review. */
export function ExternalAccountDialog({ account, collectionVersion, currency, groupId, onAccessError, onClose, paymentMethods }: ExternalAccountDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const compact = useMediaQuery('(max-width: 600px)');
  const entryFormId = useId();
  const accountTypeHintId = useId();
  const [step, setStep] = useState<DialogStep>('entry');
  const [name, setName] = useState(account?.name ?? '');
  const [type, setType] = useState<ExternalAccountType>(account?.type ?? 'CASH');
  const bankDetails = account?.details?.type === 'BANK' ? account.details : undefined;
  const paypalDetails = account?.details?.type === 'PAYPAL' ? account.details : undefined;
  const [recipientName, setRecipientName] = useState(bankDetails?.recipientName ?? '');
  const [iban, setIban] = useState(bankDetails?.iban ?? '');
  const [bic, setBic] = useState(bankDetails?.bic ?? '');
  const [paypalMeHandle, setPaypalMeHandle] = useState(paypalDetails?.paypalMeHandle ?? '');
  const [openingAmount, setOpeningAmount] = useState('');
  const [openingDate, setOpeningDate] = useState(new Date().toISOString().slice(0, 10));
  const [openingReason, setOpeningReason] = useState('');
  const [openingReference, setOpeningReference] = useState('');
  const [openingNote, setOpeningNote] = useState('');
  const [amountError, setAmountError] = useState('');
  const [paymentMethodIds, setPaymentMethodIds] = useState<string[]>(account?.linkedPaymentMethodIds ?? []);
  const persistedAccountId = useRef<string | undefined>(undefined);

  const normalizedName = name.trim();
  const normalizedIban = normalizeIban(iban);
  const normalizedBic = normalizeBic(bic);
  const normalizedPaypal = normalizePaypalMeHandle(paypalMeHandle);
  const preservesExistingType = account?.type === type;
  const recipientValid = preservesExistingType && recipientName === '••••' || recipientName.trim().length > 0 && recipientName.trim().length <= 70;
  const ibanValid = preservesExistingType && iban === bankDetails?.iban && iban.startsWith('••••') || isValidIban(normalizedIban);
  const bicValid = preservesExistingType && bic === bankDetails?.bic && bic === '••••' || isValidBic(normalizedBic);
  const paypalValid = preservesExistingType && paypalMeHandle === paypalDetails?.paypalMeHandle && paypalMeHandle === '••••' || Boolean(normalizedPaypal && isPaypalMeHandle(normalizedPaypal));
  const providerValid = type !== 'BANK'
    ? type !== 'PAYPAL' || paypalValid
    : recipientValid && ibanValid && bicValid && (!isBicRequiredForIban(normalizedIban) || Boolean(normalizedBic));
  const openingRequiredValid = !openingAmount.trim() || Boolean(openingDate && openingReason.trim());
  const entryValid = Boolean(normalizedName && providerValid && openingRequiredValid);
  const selectedPaymentMethods = paymentMethods.filter((method) => paymentMethodIds.includes(method.id));
  const initialPaymentMethodIds = account?.linkedPaymentMethodIds ?? [];
  const paymentMethodsChanged = paymentMethodIds.length !== initialPaymentMethodIds.length || paymentMethodIds.some((id) => !initialPaymentMethodIds.includes(id));
  const accountTypeLocked = Boolean(account && !account.canChangeType);
  const accountTypeOptions = (['CASH', 'BANK', 'PAYPAL', 'OTHER'] as const).map((value) => ({
    label: t(`externalAccounts.types.${value}`),
    value,
    visual: <ExternalAccountTypeIcon type={value} />,
  }));

  const details = (): ExternalAccountDetails => type === 'BANK'
    ? { type: 'BANK', recipientName: recipientName.trim(), iban: normalizedIban, ...(normalizedBic ? { bic: normalizedBic } : {}) }
    : type === 'PAYPAL' ? { type: 'PAYPAL', paypalMeHandle: normalizedPaypal ?? paypalMeHandle.trim() } : null;

  const mutation = useMutation({
    mutationFn: async () => {
      let accountId = persistedAccountId.current;
      if (!accountId) {
        const input: ExternalAccountUpdateInput = { name: normalizedName, type, details: details() };
        let collection;
        if (account) collection = await api.updateExternalAccount(groupId, account.id, input, collectionVersion);
        else {
          const openingMinor = parseOptionalSignedAmount(openingAmount, currency);
          const createInput: ExternalAccountCreateInput = {
            ...input,
            ...(openingMinor ? { openingBalance: {
                amountMinor: minorUnitsToSafeNumber(openingMinor),
                occurredAt: openingDate,
                reason: openingReason.trim(),
                ...(openingReference.trim() ? { reference: openingReference.trim() } : {}),
                ...(openingNote.trim() ? { note: openingNote.trim() } : {}),
              } } : {}),
          };
          collection = await api.createExternalAccount(groupId, createInput, collectionVersion);
        }
        accountId = account?.id ?? collection.items.find((item) => item.name === normalizedName)?.id;
        if (!accountId) throw new Error(t('externalAccounts.savedAccountUnavailable'));
        persistedAccountId.current = accountId;
      }
      if (paymentMethodsChanged) {
        const currentLinks = await api.getExternalAccountLinks(groupId);
        const selectedIds = new Set(paymentMethodIds);
        const currentAccountIdsByMethod = new Map(currentLinks.links.map((link) => [link.paymentMethodId, link.externalAccountId]));
        await api.updateExternalAccountLinks(groupId, {
          version: currentLinks.version,
          links: paymentMethods.map((method) => {
            const currentAccountId = currentAccountIdsByMethod.get(method.id) ?? null;
            if (selectedIds.has(method.id)) return { paymentMethodId: method.id, externalAccountId: accountId };
            return { paymentMethodId: method.id, externalAccountId: currentAccountId === accountId ? null : currentAccountId };
          }),
        });
      }
    },
    onError: async (error) => {
      onAccessError(error);
      if (persistedAccountId.current) await queryClient.invalidateQueries({ queryKey: externalAccountKeys.all(groupId) });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: externalAccountKeys.all(groupId) }),
        queryClient.invalidateQueries({ queryKey: ['group-settings', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['transaction-settings', groupId] }),
      ]);
      onClose();
    },
  });

  const prepareReview = () => {
    try {
      parseOptionalSignedAmount(openingAmount, currency);
      setAmountError('');
      if (entryValid) setStep('review');
    } catch (error) {
      setAmountError(error instanceof Error ? error.message : t('errors.amountFormat'));
    }
  };

  return <Modal onClose={onClose} open title={t(account ? 'externalAccounts.editAccount' : 'externalAccounts.createAccount')} variant={compact ? 'sheet' : 'dialog'}>
    {step === 'entry' ? <form className={styles.form} id={entryFormId} onSubmit={(event) => { event.preventDefault(); prepareReview(); }}>
      <div className={styles.grid}>
        <Field htmlFor="external-account-name" label={t('externalAccounts.fields.name')} required><TextInput id="external-account-name" maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} /></Field>
        <Field hint={accountTypeLocked ? t('externalAccounts.typeLocked') : undefined} htmlFor="external-account-type" label={t('externalAccounts.fields.type')} messageId={accountTypeLocked ? accountTypeHintId : undefined} required>
          <SelectMenu ariaDescribedBy={accountTypeLocked ? accountTypeHintId : undefined} disabled={accountTypeLocked} id="external-account-type" onChange={setType} options={accountTypeOptions} value={type} />
        </Field>
      </div>
      {type === 'BANK' ? <div className={styles.grid}>
        <Field htmlFor="external-account-recipient" label={t('externalAccounts.fields.recipientName')} required><TextInput id="external-account-recipient" maxLength={70} onChange={(event) => setRecipientName(event.target.value)} required value={recipientName} /></Field>
        <Field error={iban && !ibanValid ? t('behaviorSettings.sepaIbanInvalid') : undefined} htmlFor="external-account-iban" label={t('externalAccounts.fields.iban')} required><TextInput id="external-account-iban" maxLength={42} onBlur={() => { if (!(preservesExistingType && iban === bankDetails?.iban && iban.startsWith('••••'))) setIban(normalizedIban); }} onChange={(event) => setIban(event.target.value)} required value={iban} /></Field>
        <Field error={bic && !bicValid ? t('behaviorSettings.sepaBicInvalid') : undefined} htmlFor="external-account-bic" label={t('externalAccounts.fields.bic')} required={isBicRequiredForIban(normalizedIban)}><TextInput id="external-account-bic" maxLength={14} onBlur={() => { if (!(preservesExistingType && bic === bankDetails?.bic && bic === '••••')) setBic(normalizedBic); }} onChange={(event) => setBic(event.target.value)} required={isBicRequiredForIban(normalizedIban)} value={bic} /></Field>
      </div> : null}
      {type === 'PAYPAL' ? <Field error={paypalMeHandle && !paypalValid ? t('behaviorSettings.paypalMeHandleInvalid') : undefined} htmlFor="external-account-paypal" label={t('externalAccounts.fields.paypalMeHandle')} required><TextInput id="external-account-paypal" maxLength={120} onChange={(event) => setPaypalMeHandle(event.target.value)} required value={paypalMeHandle} /></Field> : null}
      <Field hint={account?.status === 'ARCHIVED' ? t('externalAccounts.archivedLinksLocked') : t('externalAccounts.paymentMethodsHint')} htmlFor="external-account-payment-methods" label={t('externalAccounts.linkedPaymentMethods')}>
        <MultiSelectMenu
          allLabel={t('externalAccounts.noLinkedMethods')}
          disabled={account?.status === 'ARCHIVED'}
          emptyLabel={t('externalAccounts.paymentMethodsEmpty')}
          id="external-account-payment-methods"
          label={t('externalAccounts.linkedPaymentMethods')}
          noResultsLabel={t('externalAccounts.paymentMethodsNoResults')}
          onChange={setPaymentMethodIds}
          options={paymentMethods.map((method) => ({ label: method.label, value: method.id }))}
          searchLabel={t('externalAccounts.paymentMethodsSearch')}
          summary={selectedPaymentMethods.length > 0 ? <span className={styles.paymentMethodSummary}>{selectedPaymentMethods.slice(0, 3).map((method) => <span key={method.id}>{method.label}</span>)}{selectedPaymentMethods.length > 3 ? <small>+{selectedPaymentMethods.length - 3}</small> : null}</span> : undefined}
          values={paymentMethodIds}
        />
      </Field>
      {!account ? <fieldset className={styles.fieldset}><legend>{t('externalAccounts.openingBalance')}</legend><div className={styles.grid}>
        <Field error={amountError || undefined} hint={t('externalAccounts.openingBalanceHint')} htmlFor="external-account-opening" label={`${t('common.amount')} (${currency})`}><TextInput id="external-account-opening" inputMode="decimal" onChange={(event) => { setOpeningAmount(event.target.value); setAmountError(''); }} pattern={signedAmountPattern(currency)} placeholder={majorUnitsPlaceholder(currency)} value={openingAmount} /></Field>
        <Field htmlFor="external-account-opening-date" label={t('common.date')} required={Boolean(openingAmount)}><TextInput id="external-account-opening-date" onChange={(event) => setOpeningDate(event.target.value)} required={Boolean(openingAmount)} type="date" value={openingDate} /></Field>
        <Field htmlFor="external-account-opening-reason" label={t('externalAccounts.fields.reason')} required={Boolean(openingAmount)}><TextInput id="external-account-opening-reason" maxLength={120} onChange={(event) => setOpeningReason(event.target.value)} required={Boolean(openingAmount)} value={openingReason} /></Field>
        <Field htmlFor="external-account-opening-reference" label={t('externalAccounts.fields.reference')}><TextInput id="external-account-opening-reference" maxLength={120} onChange={(event) => setOpeningReference(event.target.value)} value={openingReference} /></Field>
      </div><Field htmlFor="external-account-opening-note" label={t('externalAccounts.fields.note')}><TextArea id="external-account-opening-note" maxLength={2000} onChange={(event) => setOpeningNote(event.target.value)} value={openingNote} /></Field></fieldset> : null}
      <ModalFooter><div className={styles.actions}><Button leadingIcon={<X size={17} />} onClick={onClose} variant="secondary">{t('common.cancel')}</Button><Button disabled={!entryValid} form={entryFormId} leadingIcon={<CircleCheck size={17} />} type="submit">{t('externalAccounts.review')}</Button></div></ModalFooter>
    </form> : <div className={styles.review}>
      <p>{t('externalAccounts.reviewAccountIntro')}</p>
      <dl><div><dt>{t('externalAccounts.fields.name')}</dt><dd>{normalizedName}</dd></div><div><dt>{t('externalAccounts.fields.type')}</dt><dd>{t(`externalAccounts.types.${type}`)}</dd></div><div><dt>{t('externalAccounts.linkedPaymentMethods')}</dt><dd>{selectedPaymentMethods.map((method) => method.label).join(', ') || t('externalAccounts.noLinkedMethods')}</dd></div>{openingAmount ? <div><dt>{t('externalAccounts.openingBalance')}</dt><dd>{openingAmount} {currency}</dd></div> : null}</dl>
      {mutation.isError ? <p className={styles.error} role="alert">{mutation.error.message}</p> : null}
      <ModalFooter><div className={styles.actions}><Button disabled={mutation.isPending} leadingIcon={<ArrowLeft size={17} />} onClick={() => setStep('entry')} variant="secondary">{t('common.back')}</Button><Button disabled={mutation.isPending} leadingIcon={<Save size={17} />} onClick={() => mutation.mutate()}>{mutation.isPending ? t('behaviorSettings.saving') : t('common.save')}</Button></div></ModalFooter>
    </div>}
  </Modal>;
}
