import Check from 'lucide-react/dist/esm/icons/check';
import Copy from 'lucide-react/dist/esm/icons/copy';
import Download from 'lucide-react/dist/esm/icons/download';
import ExternalLink from 'lucide-react/dist/esm/icons/external-link';
import Landmark from 'lucide-react/dist/esm/icons/landmark';
import Wallet from 'lucide-react/dist/esm/icons/wallet';
import { useDeferredValue, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '@/api/money';
import type { Money, PaymentTarget } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { downloadDataUrl } from '@/features/shared/browserDownload';
import { useQrCodeDataUrl } from '@/hooks/useQrCodeDataUrl';
import { buildEpcQrPayload, buildPaypalMePaymentUrl, normalizeBic, normalizeIban } from './paymentTargets';
import styles from './PaymentInstructionPanel.module.css';

/** Properties accepted by an external payment instruction panel. */
export interface PaymentInstructionPanelProps {
  amount: Money | null;
  paymentTarget: PaymentTarget | null | undefined;
  reference: string;
}

interface CopyState {
  context: string;
  key: string;
  value: string;
  failed: boolean;
}

function readableIban(iban: string): string {
  return normalizeIban(iban).replace(/(.{4})/g, '$1 ').trim();
}

/**
 * Renders amount-gated PayPal.Me or local SEPA payment instructions.
 *
 * External actions never submit the TeamTaler payment command. The surrounding
 * reviewed flow remains the only owner of the accounting mutation.
 *
 * @param props - Validated amount, configured destination, and live payment reason.
 * @returns A responsive instruction region, or nothing without a configured target.
 */
export function PaymentInstructionPanel({ amount, paymentTarget, reference }: PaymentInstructionPanelProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const [copyState, setCopyState] = useState<CopyState>({ context: '', key: '', value: '', failed: false });
  const instructionContext = paymentTarget
    ? JSON.stringify([paymentTarget, amount?.minorUnits ?? null, amount?.currency ?? null, reference])
    : '';
  let paypalUrl = '';
  if (paymentTarget?.type === 'PAYPAL_ME' && amount) {
    try {
      paypalUrl = buildPaypalMePaymentUrl(paymentTarget.paypalMeHandle, amount);
    } catch {
      paypalUrl = '';
    }
  }
  const epcResult = paymentTarget?.type === 'SEPA_TRANSFER' && amount
    ? buildEpcQrPayload(paymentTarget, amount, reference)
    : null;
  const qrPayload = epcResult?.payload ?? '';
  const deferredQrPayload = useDeferredValue(qrPayload);
  const qrCode = useQrCodeDataUrl(deferredQrPayload);
  const qrPayloadIsCurrent = Boolean(qrPayload) && deferredQrPayload === qrPayload;
  const qrDataUrl = qrPayloadIsCurrent ? qrCode.dataUrl : '';
  const qrLoading = Boolean(qrPayload) && (!qrPayloadIsCurrent || qrCode.loading);
  const qrError = qrPayloadIsCurrent ? qrCode.error : null;

  if (!paymentTarget) return null;

  const copy = async (key: string, value: string) => {
    const context = instructionContext;
    try {
      await navigator.clipboard.writeText(value);
      setCopyState({ context, key, value, failed: false });
    } catch {
      setCopyState({ context, key, value, failed: true });
    }
  };
  const copyFeedback = (key: string, value: string) => copyState.context === instructionContext && copyState.key === key && copyState.value === value && !copyState.failed;
  const copyFailed = copyState.context === instructionContext && copyState.failed && (paymentTarget.type === 'PAYPAL_ME' ? copyState.value === paypalUrl : true);

  if (paymentTarget.type === 'PAYPAL_ME') {
    return <section aria-labelledby={headingId} className={styles.panel}>
      <header className={styles.header}><Wallet aria-hidden="true" size={22} /><div><h3 id={headingId}>{t('paymentInstructions.paypalTitle')}</h3><p>{t('paymentInstructions.paypalDescription')}</p></div></header>
      <div className={styles.linkRow}>
        <Field htmlFor="self-payment-paypal-link" label={t('paymentInstructions.paypalLink')}>
          <TextInput id="self-payment-paypal-link" placeholder={t('paymentInstructions.enterAmount')} readOnly value={paypalUrl} />
        </Field>
        <Button aria-label={t('paymentInstructions.copyField', { field: t('paymentInstructions.paypalLink') })} disabled={!paypalUrl} leadingIcon={copyFeedback('paypal', paypalUrl) ? <Check size={17} /> : <Copy size={17} />} onClick={() => void copy('paypal', paypalUrl)} variant="secondary">{copyFeedback('paypal', paypalUrl) ? t('common.copied') : t('common.copy')}</Button>
      </div>
      <a aria-disabled={!paypalUrl} className={`${styles.externalLink} ${!paypalUrl ? styles.disabledLink : ''}`} href={paypalUrl || undefined} rel="noopener noreferrer" tabIndex={paypalUrl ? undefined : -1} target="_blank"><ExternalLink aria-hidden="true" size={18} />{t('paymentInstructions.openPaypal')}</a>
      {!amount ? <p className={styles.amountHint}>{t('paymentInstructions.enterAmount')}</p> : null}
      {copyFailed ? <p className={styles.error} role="alert">{t('paymentInstructions.copyError')}</p> : null}
      <p className={styles.notice}>{t('paymentInstructions.externalNotice')}</p>
    </section>;
  }

  const manualValues = [
    { key: 'recipient', label: t('paymentInstructions.recipient'), display: paymentTarget.recipientName, copy: paymentTarget.recipientName },
    { key: 'iban', label: t('paymentInstructions.iban'), display: readableIban(paymentTarget.iban), copy: normalizeIban(paymentTarget.iban) },
    ...(paymentTarget.bic ? [{ key: 'bic', label: t('paymentInstructions.bic'), display: normalizeBic(paymentTarget.bic), copy: normalizeBic(paymentTarget.bic) }] : []),
    ...(amount ? [{ key: 'amount', label: t('common.amount'), display: formatMoney(amount), copy: formatMoney(amount) }] : []),
    ...(reference.trim() ? [{ key: 'reference', label: t('finance.reason'), display: reference.trim(), copy: reference.trim() }] : []),
  ];
  const payloadError = epcResult?.error ? t(`paymentInstructions.epcErrors.${epcResult.error}`) : '';

  return <section aria-labelledby={headingId} className={styles.panel}>
    <header className={styles.header}><Landmark aria-hidden="true" size={22} /><div><h3 id={headingId}>{t('paymentInstructions.sepaTitle')}</h3><p>{t('paymentInstructions.sepaDescription')}</p></div></header>
    <div className={styles.sepaLayout}>
      <div className={styles.qrColumn}>
        <div className={styles.qrFrame}>
          {qrDataUrl && amount ? <img alt={t('paymentInstructions.qrAlt', { amount: formatMoney(amount), recipient: paymentTarget.recipientName })} height={240} src={qrDataUrl} width={240} /> : null}
          {!amount ? <span>{t('paymentInstructions.enterAmount')}</span> : null}
          {amount && qrLoading ? <span role="status">{t('paymentInstructions.qrLoading')}</span> : null}
          {payloadError ? <span role="alert">{payloadError}</span> : null}
          {qrError ? <span role="alert">{t('paymentInstructions.qrError')}</span> : null}
        </div>
        <Button disabled={!qrDataUrl} leadingIcon={<Download size={17} />} onClick={() => downloadDataUrl(qrDataUrl, 'teamtaler-sepa-payment-qr.png')} size="small" variant="ghost">{t('paymentInstructions.downloadQr')}</Button>
      </div>
      <dl className={styles.details}>
        {manualValues.map((item) => <div className={styles.detailRow} key={item.key}>
          <div><dt>{item.label}</dt><dd>{item.display}</dd></div>
          <Button aria-label={t('paymentInstructions.copyField', { field: item.label })} disabled={!amount} iconOnly leadingIcon={copyFeedback(item.key, item.copy) ? <Check size={17} /> : <Copy size={17} />} onClick={() => void copy(item.key, item.copy)} size="small" variant="ghost">{copyFeedback(item.key, item.copy) ? t('common.copied') : t('common.copy')}</Button>
        </div>)}
      </dl>
    </div>
    {copyFailed ? <p className={styles.error} role="alert">{t('paymentInstructions.copyError')}</p> : null}
    <p aria-live="polite" className="sr-only">{copyState.context === instructionContext && copyState.key && !copyState.failed ? t('paymentInstructions.copiedField', { field: manualValues.find((item) => item.key === copyState.key)?.label ?? t('paymentInstructions.paypalLink') }) : ''}</p>
    <p className={styles.notice}>{t('paymentInstructions.externalNotice')}</p>
  </section>;
}
