import type { ExternalAccount } from '@/api/types';

/**
 * Builds the masked provider descriptor shown beside an external account.
 *
 * @param account - Account whose already-masked provider details should be summarized.
 * @returns A compact IBAN or PayPal descriptor, or undefined for provider-less accounts.
 */
export function externalAccountDescriptor(account: ExternalAccount): string | undefined {
  if (account.details?.type === 'BANK') return `IBAN •••• ${account.details.iban.slice(-4)}`;
  if (account.details?.type === 'PAYPAL') return account.details.paypalMeHandle === '••••' ? 'PayPal.Me ••••' : `paypal.me/${account.details.paypalMeHandle}`;
  return undefined;
}
