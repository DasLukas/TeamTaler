import type { Payment } from '@/api/types';

/** Supported payment methods and their localized display keys. */
export const PAYMENT_METHOD_OPTIONS = [
  { value: 'BANK_TRANSFER', labelKey: 'finance.transfer' },
  { value: 'CASH', labelKey: 'finance.cash' },
  { value: 'PAYPAL', labelKey: 'finance.paypal' },
  { value: 'OTHER', labelKey: 'finance.other' },
] as const satisfies ReadonlyArray<{ value: Payment['method']; labelKey: string }>;

/**
 * Resolves the translation key for a supported payment method.
 *
 * @param method - Canonical payment method returned by the API.
 * @returns The matching German interface translation key.
 */
export function paymentMethodLabelKey(method: Payment['method']): typeof PAYMENT_METHOD_OPTIONS[number]['labelKey'] {
  return PAYMENT_METHOD_OPTIONS.find((option) => option.value === method)?.labelKey ?? 'finance.other';
}
