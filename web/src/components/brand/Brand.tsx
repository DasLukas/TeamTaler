import styles from './Brand.module.css';
import { useTranslation } from 'react-i18next';

/** Properties accepted by the TeamTaler brand component. */
export interface BrandProps {
  compact?: boolean;
  className?: string;
}

/**
 * Renders the TeamTaler wordmark and circular team emblem.
 *
 * @param props - Compact-mode and optional class-name configuration.
 * @returns A localized, accessible brand mark.
 */
export function Brand({ compact = false, className = '' }: BrandProps) {
  const { t } = useTranslation();
  return (
    <span aria-label={t('brand.name')} className={`${styles.brand} ${className}`}>
      <img alt={t('brand.markAlt')} className={styles.emblem} src="/brand/teamtaler-mark.png" />
      {compact ? null : <strong>{t('brand.name')}</strong>}
    </span>
  );
}
