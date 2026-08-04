import styles from './Brand.module.css';
import { useTranslation } from 'react-i18next';

/** Properties accepted by the TeamTaler brand component. */
export interface BrandProps {
  compact?: boolean;
  className?: string;
  imageUrl?: string;
  imageAlt?: string;
}

/**
 * Renders the TeamTaler wordmark and circular team emblem.
 *
 * @param props - Compact mode, class name, and optional group-logo override.
 * @returns A localized, accessible brand mark.
 */
export function Brand({ compact = false, className = '', imageUrl, imageAlt }: BrandProps) {
  const { t } = useTranslation();
  return (
    <span aria-label={t('brand.name')} className={`${styles.brand} ${className}`}>
      <img alt={imageAlt ?? t('brand.markAlt')} className={styles.emblem} src={imageUrl || '/brand/teamtaler-mark.png'} />
      {compact ? null : <strong>{t('brand.name')}</strong>}
    </span>
  );
}
