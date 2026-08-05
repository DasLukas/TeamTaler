import type { AccountSummary, Money } from '@/api/types';

/** Derived totals and membership groups used by the finance overview. */
export interface AccountOverview {
  receivables: Money;
  credits: Money;
  net: Money;
  active: AccountSummary[];
  archived: AccountSummary[];
}

function compareAccounts(left: AccountSummary, right: AccountSummary): number {
  const balanceDifference = BigInt(right.balance.minorUnits) - BigInt(left.balance.minorUnits);
  if (balanceDifference > 0n) return 1;
  if (balanceDifference < 0n) return -1;
  return left.displayName.localeCompare(right.displayName, 'de', { sensitivity: 'base' });
}

/**
 * Calculates exact account totals and deterministic status groups.
 *
 * @param accounts - Consolidated balances from the group account endpoint.
 * @param currency - Active group currency used when the collection is empty.
 * @returns Exact totals plus sorted active and archived account collections.
 */
export function deriveAccountOverview(accounts: AccountSummary[], currency: string): AccountOverview {
  let receivables = 0n;
  let credits = 0n;
  let net = 0n;
  for (const account of accounts) {
    const balance = BigInt(account.balance.minorUnits);
    net += balance;
    if (balance > 0n) receivables += balance;
    if (balance < 0n) credits -= balance;
  }
  const sorted = [...accounts].sort(compareAccounts);
  return {
    receivables: { minorUnits: receivables.toString(), currency },
    credits: { minorUnits: credits.toString(), currency },
    net: { minorUnits: net.toString(), currency },
    active: sorted.filter((account) => account.status === 'ACTIVE'),
    archived: sorted.filter((account) => account.status === 'ARCHIVED'),
  };
}
