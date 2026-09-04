import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import styles from './LegalLinks.module.css';

/** Properties accepted by the shared legal navigation. */
export interface LegalLinksProps {
  className?: string;
}

/**
 * Renders persistent links to every public legal document.
 *
 * @param props - Optional additional class name for layout integration.
 * @returns A localized legal-navigation landmark.
 */
export function LegalLinks({ className = '' }: LegalLinksProps) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('legal.navigation')} className={`${styles.links} ${className}`}>
      <Link to="/impressum">{t('legal.imprint.title')}</Link>
      <span aria-hidden="true">·</span>
      <Link to="/datenschutz">{t('legal.privacyPolicy.title')}</Link>
    </nav>
  );
}

/**
 * Renders the legal navigation as an application-content footer.
 *
 * @returns A footer suitable for every authenticated route.
 */
export function LegalFooter() {
  return <footer className={styles.footer}><LegalLinks /></footer>;
}
