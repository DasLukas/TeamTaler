import type { ExternalAccount, ExternalAccountTransaction } from '@/api/types';

/**
 * Preserves server-projected account directions and fills only missing legacy projections.
 *
 * @param item - Adapted transaction with optional authoritative account references.
 * @param accounts - Current account collection used only as a compatibility fallback.
 * @returns The transaction with any missing directional references filled.
 */
export function projectTransactionAccounts(item: ExternalAccountTransaction, accounts: ExternalAccount[]): ExternalAccountTransaction {
  const primary = accounts.find((account) => account.id === item.primaryAccountId);
  const counterparty = accounts.find((account) => account.id === item.counterpartyAccountId);
  const primaryReference = primary ? { id: primary.id, name: primary.name, type: primary.type } : undefined;
  const counterpartyReference = counterparty ? { id: counterparty.id, name: counterparty.name, type: counterparty.type } : undefined;
  const outgoing = BigInt(item.amount.minorUnits) < 0n;
  const fallbackSource = outgoing ? primaryReference : counterpartyReference;
  const fallbackDestination = outgoing ? counterpartyReference : primaryReference;
  return {
    ...item,
    ...(item.sourceAccount || !fallbackSource ? {} : { sourceAccount: fallbackSource }),
    ...(item.destinationAccount || !fallbackDestination ? {} : { destinationAccount: fallbackDestination }),
  };
}
