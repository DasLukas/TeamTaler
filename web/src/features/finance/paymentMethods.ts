import type { ConfigurableItem, Payment } from '@/api/types';
import i18n from '@/i18n';

/** Supported payment methods and their localized display keys. */
export const PAYMENT_METHOD_OPTIONS = [
  { value: 'BANK_TRANSFER', labelKey: 'finance.transfer' },
  { value: 'CASH', labelKey: 'finance.cash' },
  { value: 'PAYPAL', labelKey: 'finance.paypal' },
  { value: 'OTHER', labelKey: 'finance.other' },
] as const satisfies ReadonlyArray<{ value: Payment['method']; labelKey: string }>;

const DEFAULT_PAYMENT_METHOD_LABELS: Readonly<Record<string, string>> = {
  BANK_TRANSFER: 'Bank transfer',
  CASH: 'Cash',
  PAYPAL: 'PayPal',
  OTHER: 'Other',
};

/**
 * Resolves the translation key for a supported payment method.
 *
 * @param method - Canonical payment method returned by the API.
 * @returns The matching German interface translation key.
 */
export function paymentMethodLabelKey(method: Payment['method']): typeof PAYMENT_METHOD_OPTIONS[number]['labelKey'] {
  return PAYMENT_METHOD_OPTIONS.find((option) => option.value === method)?.labelKey ?? 'finance.other';
}

/**
 * Localizes untouched built-in payment methods while preserving administrator edits.
 *
 * @param id - Stable payment-method identifier.
 * @param label - Persisted administrator-facing label.
 * @returns A localized built-in label or the persisted custom label.
 */
export function localizedPaymentMethodLabel(id: string, label: string): string {
  if (DEFAULT_PAYMENT_METHOD_LABELS[id] !== label) return label;
  return i18n.t(paymentMethodLabelKey(id));
}

/**
 * Resolves a historical payment snapshot, including rows created before labels existed.
 *
 * @param id - Stable payment-method identifier stored with the payment.
 * @param label - Optional immutable label snapshot.
 * @returns The localized built-in fallback or the preserved snapshot.
 */
export function historicalPaymentMethodLabel(id: string, label?: string): string {
  if (label) return localizedPaymentMethodLabel(id, label);
  const builtIn = DEFAULT_PAYMENT_METHOD_LABELS[id];
  return builtIn ? localizedPaymentMethodLabel(id, builtIn) : id;
}

/**
 * Builds the localized, editable payment-method defaults used by new groups.
 *
 * @returns A new ordered collection containing the four built-in methods.
 */
export function defaultPaymentMethods(): ConfigurableItem[] {
  return PAYMENT_METHOD_OPTIONS.map((option) => ({
    id: option.value,
    label: i18n.t(option.labelKey),
  }));
}
