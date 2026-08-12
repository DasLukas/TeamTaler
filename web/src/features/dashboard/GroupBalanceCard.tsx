import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { formatSignedMoney } from '@/api/money';
import type { Money } from '@/api/types';
import styles from './GroupBalanceCard.module.css';

/** Properties accepted by the permission-gated group balance card. */
export interface GroupBalanceCardProps {
  balance: Money;
}

type GroupBalanceState = 'due' | 'balanced' | 'credit';

/**
 * Resolves the semantic state of a signed group receivable balance.
 *
 * @param balance - Consolidated group receivable using the ledger sign convention.
 * @returns `due` for positive receivables, `credit` for negative member credit, or `balanced` for zero.
 */
function groupBalanceState(balance: Money): GroupBalanceState {
  const amount = BigInt(balance.minorUnits);
  if (amount > 0n) return 'due';
  if (amount < 0n) return 'credit';
  return 'balanced';
}

/**
 * Renders the current signed net balance across all group member accounts.
 *
 * @param props - The complete-ledger group balance returned by the dashboard API.
 * @returns An accessible status card without period or category statistics.
 */
export function GroupBalanceCard({ balance }: GroupBalanceCardProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const state = groupBalanceState(balance);

  return (
    <section aria-labelledby={titleId} className={styles.section}>
      <h2 id={titleId}>{t('dashboard.groupBalance.title')}</h2>
      <div className={`${styles.card} ${styles[state]}`} data-financial-state={state}>
        <span>{t(`dashboard.groupBalance.${state}`)}</span>
        <strong>{formatSignedMoney(balance)}</strong>
        <p>{t(`dashboard.groupBalance.${state}Description`)}</p>
      </div>
    </section>
  );
}
