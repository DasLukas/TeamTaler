import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Brand } from '@/components/brand/Brand';
import { LegalLinks } from '@/components/legal/LegalLinks';
import styles from './AuthLayout.module.css';

/** Properties accepted by the shared authentication layout. */
export interface AuthLayoutProps {
  title: string;
  intro: string;
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * Renders the focused frame shared by login and invitation acceptance.
 *
 * @param props - Page heading, content, and optional footer.
 * @returns The responsive authentication layout.
 */
export function AuthLayout({ title, intro, children, footer }: AuthLayoutProps) {
  const { t } = useTranslation();
  return (
    <main className={styles.layout}>
      <section className={styles.brandPanel}>
        <Brand />
        <div>
          <h1><Trans i18nKey="auth.slogan" components={{ br: <br /> }} defaults={t('auth.slogan')} /></h1>
          <p>{t('auth.productSummary')}</p>
        </div>
      </section>
      <section className={styles.formPanel}>
        <div className={styles.card}>
          <h1>{title}</h1>
          <p>{intro}</p>
          {children}
          <footer>
            {footer ? <div className={styles.contextFooter}>{footer}</div> : null}
            <LegalLinks />
          </footer>
        </div>
      </section>
    </main>
  );
}
