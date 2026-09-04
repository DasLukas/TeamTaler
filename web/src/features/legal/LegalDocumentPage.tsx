import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import { api } from '@/api/client';
import { Brand } from '@/components/brand/Brand';
import { LegalLinks } from '@/components/legal/LegalLinks';
import { StatePanel } from '@/components/ui/StatePanel';
import styles from './LegalDocumentPage.module.css';

const PUBLIC_LEGAL_DOCUMENTS_QUERY_KEY = ['public-legal-documents'] as const;

type LegalDocumentName = 'imprint' | 'privacyPolicy';

interface LegalDocumentPageProps {
  document: LegalDocumentName;
}

/**
 * Renders one public, safely escaped plain-text legal document.
 *
 * @param props - Stable document identifier used to select content and copy.
 * @returns A public legal page or a localized loading/error state.
 */
function LegalDocumentPage({ document }: LegalDocumentPageProps) {
  const { t } = useTranslation();
  const documents = useQuery({
    queryKey: PUBLIC_LEGAL_DOCUMENTS_QUERY_KEY,
    queryFn: api.getPublicLegalDocuments,
    retry: false,
    staleTime: 0,
  });
  const content = documents.data?.[document] ?? '';
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link aria-label={t('legal.backHome')} className={styles.brandLink} to="/"><Brand /></Link>
      </header>
      <main className={styles.main}>
        <article className={styles.document}>
          <h1>{t(`legal.${document}.title`)}</h1>
          {documents.isLoading ? <StatePanel kind="loading" /> : null}
          {documents.isError ? <StatePanel actionLabel={t('common.retry')} kind="error" message={t('legal.loadError')} onAction={() => void documents.refetch()} /> : null}
          {!documents.isLoading && !documents.isError && content ? <div className={styles.content}><ReactMarkdown components={{ h1: 'h2' }}>{content}</ReactMarkdown></div> : null}
          {!documents.isLoading && !documents.isError && !content ? <StatePanel kind="empty" message={t('legal.notConfigured')} /> : null}
        </article>
      </main>
      <footer className={styles.footer}><LegalLinks /></footer>
    </div>
  );
}

/** Renders the public imprint route. */
export function ImprintPage() {
  return <LegalDocumentPage document="imprint" />;
}

/** Renders the public privacy-policy route. */
export function PrivacyPolicyPage() {
  return <LegalDocumentPage document="privacyPolicy" />;
}
