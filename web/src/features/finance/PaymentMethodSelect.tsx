import type { PaymentMethod } from '@/api/types';
import { SelectMenu } from '@/components/ui/SelectMenu';

interface PaymentMethodSelectProps {
  ariaLabel: string;
  id: string;
  methods: readonly PaymentMethod[];
  onChange: (value: string) => void;
  value: string;
}

/**
 * Renders the shared custom payment-method selector.
 *
 * @param props - Selection identity, configured methods, and change callback.
 * @returns An accessible custom listbox containing payment-method names.
 */
export function PaymentMethodSelect({ ariaLabel, id, methods, onChange, value }: PaymentMethodSelectProps) {
  return <SelectMenu ariaLabel={ariaLabel} id={id} onChange={onChange} options={methods.map((method) => ({ label: method.label, value: method.id }))} value={value} />;
}
