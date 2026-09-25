import CircleCheck from 'lucide-react/dist/esm/icons/circle-check';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '@/api/money';
import type { ExternalAccountActor, ExternalAccountTransaction, Money } from '@/api/types';
import { Avatar } from '@/components/ui/Avatar';
import tableStyles from '@/features/shared/Table.module.css';
import { ExternalAccountTransactionKindIcon } from './ExternalAccountTransactionKindIcon';
import styles from './ExternalTransactionPresentation.module.css';

/**
 * Shows a transaction kind as the same compact icon-and-label badge used by activity lists.
 *
 * @param props - Canonical external-account transaction kind.
 * @returns A localized semantic badge with a decorative icon.
 */
export function ExternalTransactionKind({ kind }: Pick<ExternalAccountTransaction, 'kind'>) {
  const { t } = useTranslation();
  const tone = kind === 'PAYMENT' || kind === 'INCOME' ? styles.kindPositive
    : kind === 'EXPENSE' || kind === 'REVERSAL' ? styles.kindNegative
      : kind === 'OPENING_BALANCE' || kind === 'TRANSFER' ? styles.kindInfo : styles.kindWarning;
  return <span className={`${styles.kind} ${tone}`} data-transaction-kind={kind}><ExternalAccountTransactionKindIcon kind={kind} size={16} /><span>{t(`externalAccounts.kinds.${kind}`)}</span></span>;
}

/**
 * Shows the signed effect on the primary external account, muting reversed originals.
 *
 * @param props - Monetary amount and current transaction status.
 * @returns A localized amount whose sign and state remain legible without color.
 */
export function ExternalTransactionAmount({ amount, status }: { amount: Money; status: ExternalAccountTransaction['status'] }) {
  const minorUnits = BigInt(amount.minorUnits);
  const tone = status === 'REVERSED' ? styles.amountReversed : minorUnits > 0n ? styles.amountPositive : minorUnits < 0n ? styles.amountNegative : '';
  return <strong className={`${styles.amount} ${tone}`}>{minorUnits > 0n ? '+' : ''}{formatMoney(amount)}</strong>;
}

/**
 * Shows the recorded actor with their protected avatar or initials fallback.
 *
 * @param props - Permission-scoped actor projection from transaction history.
 * @returns A compact identity requiring no member-directory request.
 */
export function ExternalTransactionActor({ actor }: { actor: ExternalAccountActor }) {
  return <span className={styles.actor}><Avatar decorative name={actor.displayName} size="small" src={actor.avatarUrl} /><span title={actor.displayName}>{actor.displayName}</span></span>;
}

/**
 * Shows the lifecycle state as an icon-and-label status pill.
 *
 * @param props - Current posted or reversed transaction status.
 * @returns An accessible localized status indicator.
 */
export function ExternalTransactionStatus({ status }: Pick<ExternalAccountTransaction, 'status'>) {
  const { t } = useTranslation();
  const reversed = status === 'REVERSED';
  return <span className={`${tableStyles.status} ${styles.status} ${reversed ? tableStyles.statusMuted : ''}`}>{reversed ? <RotateCcw aria-hidden="true" size={15} /> : <CircleCheck aria-hidden="true" size={15} />}{t(reversed ? 'common.reversed' : 'common.booked')}</span>;
}
