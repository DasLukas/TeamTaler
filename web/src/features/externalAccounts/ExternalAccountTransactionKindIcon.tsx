import ArrowDownToLine from 'lucide-react/dist/esm/icons/arrow-down-to-line';
import ArrowLeftRight from 'lucide-react/dist/esm/icons/arrow-left-right';
import ArrowUpFromLine from 'lucide-react/dist/esm/icons/arrow-up-from-line';
import CircleDollarSign from 'lucide-react/dist/esm/icons/circle-dollar-sign';
import CreditCard from 'lucide-react/dist/esm/icons/credit-card';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import SlidersHorizontal from 'lucide-react/dist/esm/icons/sliders-horizontal';
import type { ExternalAccountTransactionKind } from '@/api/types';

/** Properties accepted by the semantic external-account transaction-kind icon. */
export interface ExternalAccountTransactionKindIconProps {
  /** Transaction kind represented by the icon. */
  kind: ExternalAccountTransactionKind;
  /** Icon size in CSS pixels. */
  size?: number;
}

/**
 * Maps an external-account transaction kind to its shared decorative Lucide icon.
 *
 * @param props - Transaction kind and optional icon size.
 * @returns A decorative icon whose meaning is repeated by the adjacent text label.
 */
export function ExternalAccountTransactionKindIcon({ kind, size = 20 }: ExternalAccountTransactionKindIconProps) {
  const Icon = kind === 'PAYMENT'
    ? CreditCard
    : kind === 'OPENING_BALANCE'
      ? CircleDollarSign
      : kind === 'INCOME'
        ? ArrowDownToLine
        : kind === 'EXPENSE'
          ? ArrowUpFromLine
          : kind === 'TRANSFER'
            ? ArrowLeftRight
            : kind === 'ADJUSTMENT'
              ? SlidersHorizontal
              : RotateCcw;
  return <Icon aria-hidden="true" size={size} />;
}
