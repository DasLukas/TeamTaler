import type { LucideProps } from 'lucide-react';

/** SVG icon properties with the currency of the displayed financial workspace. */
export interface FinanceNavigationIconProps extends LucideProps {
  currency?: string;
}

/**
 * Renders a currency glyph in the same fixed footprint as navigation icons.
 * @param props - Currency code and standard SVG presentation properties.
 * @returns A decorative currency symbol; invalid codes use the generic currency sign.
 */
export function FinanceNavigationIcon({ currency = 'EUR', size = 24, ...props }: FinanceNavigationIconProps) {
  let symbol = '¤';
  try {
    symbol = new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0).find((part) => part.type === 'currency')?.value ?? symbol;
  } catch { /* Keep a stable fallback for malformed currency data. */ }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <text x="12" y="12" dy=".35em" textAnchor="middle" fontFamily="inherit" fontSize={symbol.length > 2 ? 11 : symbol.length > 1 ? 15 : 23} fontWeight="400">{symbol}</text>
  </svg>;
}
