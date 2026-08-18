import styles from './Brand.module.css';
import { useTranslation } from 'react-i18next';

/** Properties accepted by the TeamTaler brand component. */
export interface BrandProps {
  compact?: boolean;
  className?: string;
  imageUrl?: string;
  imageAlt?: string;
  name?: string;
}

/**
 * Renders the TeamTaler wordmark and circular team emblem.
 *
 * @param props - Compact mode, class name, and optional group-logo override.
 * @returns A localized, accessible brand mark.
 */
export function Brand({ compact = false, className = '', imageUrl, imageAlt, name }: BrandProps) {
  const { t } = useTranslation();
  const displayName = name?.trim() || t('brand.name');
  return (
    <span aria-label={displayName} className={`${styles.brand} ${className}`}>
      <img alt={imageAlt ?? t('brand.markAlt')} className={styles.emblem} src={imageUrl || '/brand/teamtaler-mark.png'} />
      {compact ? null : <strong>{displayName}</strong>}
    </span>
  );
}
