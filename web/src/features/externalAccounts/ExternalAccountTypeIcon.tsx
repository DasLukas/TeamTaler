import BadgeDollarSign from 'lucide-react/dist/esm/icons/badge-dollar-sign';
import Banknote from 'lucide-react/dist/esm/icons/banknote';
import Landmark from 'lucide-react/dist/esm/icons/landmark';
import WalletCards from 'lucide-react/dist/esm/icons/wallet-cards';
import type { ExternalAccountType } from '@/api/types';

/** Properties accepted by the semantic external-account type icon. */
export interface ExternalAccountTypeIconProps {
  /** Icon size in CSS pixels. */
  size?: number;
  /** Provider-neutral storage type represented by the icon. */
  type: ExternalAccountType;
}

/**
 * Maps an external-account storage type to its shared decorative Lucide icon.
 *
 * @param props - Account type and optional icon size.
 * @returns A decorative icon whose meaning is repeated by the adjacent text label.
 */
export function ExternalAccountTypeIcon({ size = 20, type }: ExternalAccountTypeIconProps) {
  const Icon = type === 'BANK' ? Landmark : type === 'PAYPAL' ? BadgeDollarSign : type === 'CASH' ? Banknote : WalletCards;
  return <Icon aria-hidden="true" size={size} />;
}
