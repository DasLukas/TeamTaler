import { formatMoney } from '@/api/money';
import type { Money } from '@/api/types';
import { formatGermanDate } from '@/features/shared/dateFormat';
import styles from './PaymentReviewSummary.module.css';

/** Properties rendered by the shared payment review summary. */
interface PaymentReviewSummaryProps {
  accountLabel: string;
  accountName: string;
  amount: Money;
  amountLabel: string;
  attachmentLabel: string;
  attachmentName?: string;
  dateLabel: string;
  intro: string;
  methodLabel: string;
  methodName: string;
  reason?: string;
  reasonLabel: string;
  receivedAt: string;
  showReason: boolean;
}

/**
 * Renders the immutable data snapshot shown before a payment is submitted.
 *
 * @param props - Localized labels and the reviewed payment values.
 * @returns An accessible definition list for both own and managed payments.
 */
export function PaymentReviewSummary({
  accountLabel,
  accountName,
  amount,
  amountLabel,
  attachmentLabel,
  attachmentName,
  dateLabel,
  intro,
  methodLabel,
  methodName,
  reason,
  reasonLabel,
  receivedAt,
  showReason,
}: PaymentReviewSummaryProps) {
  return (
    <div className={styles.summary}>
      <p>{intro}</p>
      <dl>
        <div><dt>{accountLabel}</dt><dd>{accountName}</dd></div>
        <div><dt>{amountLabel}</dt><dd><strong className={styles.paymentAmount} data-financial-state="payment">{formatMoney(amount)}</strong></dd></div>
        <div><dt>{dateLabel}</dt><dd>{formatGermanDate(receivedAt)}</dd></div>
        <div><dt>{methodLabel}</dt><dd>{methodName}</dd></div>
        {showReason ? <div><dt>{reasonLabel}</dt><dd>{reason || '–'}</dd></div> : null}
        {attachmentName ? <div><dt>{attachmentLabel}</dt><dd>{attachmentName}</dd></div> : null}
      </dl>
    </div>
  );
}
