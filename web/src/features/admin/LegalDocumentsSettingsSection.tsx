import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import ExternalLink from 'lucide-react/dist/esm/icons/external-link';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import Save from 'lucide-react/dist/esm/icons/save';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { LegalDocument, LegalDocumentKey, SystemLegalDocuments, SystemLegalDocumentsUpdate } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { Field, TextArea } from '@/components/ui/FormField';
import { StatePanel } from '@/components/ui/StatePanel';
import styles from './LegalDocumentsSettingsSection.module.css';

const LEGAL_DOCUMENTS_QUERY_KEY = ['system-legal-documents'] as const;
const PUBLIC_LEGAL_DOCUMENTS_QUERY_KEY = ['public-legal-documents'] as const;
const MAXIMUM_DOCUMENT_BYTES = 64 * 1024;

type LegalDocumentField = 'imprint' | 'privacyPolicy';

interface LegalDocumentEditorProps {
  document: LegalDocument;
  documentKey: LegalDocumentKey;
  field: LegalDocumentField;
  href: '/impressum' | '/datenschutz';
  revision: number;
}

function documentUpdate(field: LegalDocumentField, content: string): SystemLegalDocumentsUpdate {
  return field === 'imprint' ? { imprint: content } : { privacyPolicy: content };
}

/** Renders one conflict-safe legal-document editor and host-file reset control. */
function LegalDocumentEditor({ document, documentKey, field, href, revision }: LegalDocumentEditorProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [content, setContent] = useState(document.content);
  const [resetOpen, setResetOpen] = useState(false);
  const synchronize = async (persisted?: SystemLegalDocuments) => {
    if (persisted) queryClient.setQueryData(LEGAL_DOCUMENTS_QUERY_KEY, persisted);
    await queryClient.invalidateQueries({ queryKey: PUBLIC_LEGAL_DOCUMENTS_QUERY_KEY });
  };
  const saveMutation = useMutation({
    mutationFn: () => api.updateSystemLegalDocuments(documentUpdate(field, content.trim()), revision),
    onSuccess: async (persisted) => {
      await synchronize(persisted);
    },
    onError: async () => { await queryClient.invalidateQueries({ queryKey: LEGAL_DOCUMENTS_QUERY_KEY }); },
  });
  const resetMutation = useMutation({
    mutationFn: () => api.resetSystemLegalDocuments([documentKey], revision),
    onSuccess: async (persisted) => {
      setResetOpen(false);
      await synchronize(persisted);
    },
    onError: async () => { await queryClient.invalidateQueries({ queryKey: LEGAL_DOCUMENTS_QUERY_KEY }); },
  });
  const normalizedContent = content.trim();
  const contentBytes = new TextEncoder().encode(normalizedContent).byteLength;
  const changed = normalizedContent !== document.content;
  const pending = saveMutation.isPending || resetMutation.isPending;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    saveMutation.mutate();
  };
  return (
    <article className={styles.editor}>
      <header className={styles.editorHeader}>
        <div>
          <h4>{t(`systemSettings.legal.${field}.title`)}</h4>
          <p>{t(`systemSettings.legal.${field}.description`)}</p>
        </div>
        <Link className={styles.publicLink} rel="noreferrer" target="_blank" to={href}>
          {t('systemSettings.legal.openPublic')}<ExternalLink aria-hidden="true" size={15} />
        </Link>
      </header>
      <form className={styles.form} onSubmit={submit}>
        <Field hint={t(`systemSettings.legal.${field}.hint`)} htmlFor={`legal-${field}`} label={t('systemSettings.legal.content')} required>
          <TextArea disabled={pending} id={`legal-${field}`} maxLength={MAXIMUM_DOCUMENT_BYTES} onChange={(event) => setContent(event.target.value)} required value={content} />
        </Field>
        <div className={styles.meta}>
          <span>{t('systemSettings.legal.source')}: <strong>{t(`systemSettings.legal.sources.${document.source.toLowerCase()}`)}</strong></span>
          <span>{t('systemSettings.legal.size', { current: contentBytes, maximum: MAXIMUM_DOCUMENT_BYTES })}</span>
        </div>
        {saveMutation.isError || resetMutation.isError ? <p className={styles.error} role="alert">{t('systemSettings.legal.saveError')}</p> : null}
        {saveMutation.isSuccess || resetMutation.isSuccess ? <p className={styles.success} role="status">{t('systemSettings.legal.saved')}</p> : null}
        <div className={styles.actions}>
          <Button disabled={pending || document.source !== 'DATABASE'} leadingIcon={<RotateCcw size={17} />} onClick={() => setResetOpen(true)} variant="secondary">{t('systemSettings.legal.useHostFile')}</Button>
          <Button disabled={pending || !changed || !normalizedContent || contentBytes > MAXIMUM_DOCUMENT_BYTES} leadingIcon={<Save size={17} />} type="submit">{saveMutation.isPending ? t('common.saving') : t('common.save')}</Button>
        </div>
      </form>
      <ConfirmationDialog
        confirmIcon={<RotateCcw size={17} />}
        confirmLabel={resetMutation.isPending ? t('systemSettings.resetting') : t('systemSettings.legal.useHostFile')}
        errorMessage={resetMutation.isError ? t('systemSettings.legal.saveError') : undefined}
        message={t('systemSettings.legal.resetMessage')}
        onClose={() => setResetOpen(false)}
        onConfirm={() => resetMutation.mutate()}
        open={resetOpen}
        pending={resetMutation.isPending}
        title={t('systemSettings.legal.resetTitle', { document: t(`systemSettings.legal.${field}.title`) })}
      />
    </article>
  );
}

/**
 * Loads and renders the system-administration editors for public legal content.
 *
 * @returns Versioned imprint and privacy-policy editors.
 */
export function LegalDocumentsSettingsSection() {
  const { t } = useTranslation();
  const documents = useQuery({ queryKey: LEGAL_DOCUMENTS_QUERY_KEY, queryFn: api.getSystemLegalDocuments });
  return (
    <section aria-labelledby="system-legal-title" className={styles.section}>
      <header><h3 id="system-legal-title">{t('systemSettings.legal.title')}</h3><p>{t('systemSettings.legal.intro')}</p></header>
      {documents.isLoading ? <StatePanel kind="loading" /> : null}
      {documents.isError || !documents.data && !documents.isLoading ? <StatePanel actionLabel={t('common.retry')} kind="error" message={t('systemSettings.legal.loadError')} onAction={() => void documents.refetch()} /> : null}
      {documents.data ? (
        <div className={styles.editors}>
          <LegalDocumentEditor key={`imprint-${documents.data.imprint.source}-${documents.data.imprint.overrideVersion ?? 0}-${documents.data.imprint.updatedAt ?? ''}-${documents.data.imprint.content}`} document={documents.data.imprint} documentKey="IMPRINT" field="imprint" href="/impressum" revision={documents.data.revision} />
          <LegalDocumentEditor key={`privacy-${documents.data.privacyPolicy.source}-${documents.data.privacyPolicy.overrideVersion ?? 0}-${documents.data.privacyPolicy.updatedAt ?? ''}-${documents.data.privacyPolicy.content}`} document={documents.data.privacyPolicy} documentKey="PRIVACY_POLICY" field="privacyPolicy" href="/datenschutz" revision={documents.data.revision} />
        </div>
      ) : null}
    </section>
  );
}
