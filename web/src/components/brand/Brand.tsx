import styles from './Brand.module.css';
import { useTranslation } from 'react-i18next';

/** Properties accepted by the TeamTaler brand component. */
export interface BrandProps {
  compact?: boolean;
  className?: string;
  name?: string;
}

/**
 * Renders the TeamTaler wordmark and circular team emblem.
 *
 * The emblem is intentionally fixed so group imagery remains confined to
 * group-selection surfaces and can never replace the product identity.
 *
 * @param props - Compact mode, class name, and optional instance name.
 * @returns A localized, accessible brand mark.
 */
export function Brand({ compact = false, className = '', name }: BrandProps) {
  const { t } = useTranslation();
  const displayName = name?.trim() || t('brand.name');
  return (
    <span aria-label={displayName} className={`${styles.brand} ${className}`}>
      <img alt={t('brand.markAlt')} className={styles.emblem} src="/brand/teamtaler-emblem-transparent.webp" />
      {compact ? null : <strong>{displayName}</strong>}
    </span>
  );
}
