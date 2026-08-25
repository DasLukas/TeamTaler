import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Download from 'lucide-react/dist/esm/icons/download';
import FileArchive from 'lucide-react/dist/esm/icons/file-archive';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import X from 'lucide-react/dist/esm/icons/x';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { DataExportJob, DataExportScope } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { Field, TextInput } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { StatePanel } from '@/components/ui/StatePanel';
import { formatGermanDateTime } from '@/features/shared/dateFormat';
import styles from './DataExportPanel.module.css';

const ACTIVE_EXPORT_STATUSES = new Set<DataExportJob['status']>(['QUEUED', 'RUNNING']);
const REMOVABLE_EXPORT_STATUSES = new Set<DataExportJob['status']>(['QUEUED', 'RUNNING', 'READY']);

/** Properties configuring a group or personal structured-data export panel. */
export interface DataExportPanelProps {
  groupId: string;
  scope: DataExportScope;
  title: string;
  intro: string;
}

function exportQueryKey(groupId: string) {
  return ['data-exports', groupId] as const;
}

function formatBytes(value?: string): string | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes)) return null;
  return new Intl.NumberFormat('de-DE', { style: 'unit', unit: bytes >= 1_048_576 ? 'megabyte' : 'kilobyte', unitDisplay: 'short', maximumFractionDigits: 1 }).format(bytes / (bytes >= 1_048_576 ? 1_048_576 : 1024));
}

function downloadDataExport(job: DataExportJob): void {
  const anchor = document.createElement('a');
  anchor.href = api.getDataExportDownloadURL(job.id);
  anchor.download = `teamtaler-${job.scope === 'GROUP' ? 'gruppen' : 'benutzer'}daten-${job.requestedAt.slice(0, 10)}.zip`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Renders password-confirmed creation, progress, download, and deletion for structured exports.
 *
 * @param props - Active group, allowed scope, and localized panel copy.
 * @returns A self-refreshing actor-owned export history.
 */
export function DataExportPanel({ groupId, intro, scope, title }: DataExportPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const passwordId = useId();
  const idempotencyKeyRef = useRef('');
  const focusedExportRef = useRef('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [jobToDelete, setJobToDelete] = useState<DataExportJob | null>(null);
  const exportsQuery = useQuery({
    queryKey: exportQueryKey(groupId),
    queryFn: () => api.getDataExports(groupId),
    refetchInterval: (query) => query.state.data?.some((job) => ACTIVE_EXPORT_STATUSES.has(job.status)) ? 2_500 : false,
  });
  const jobs = useMemo(() => (exportsQuery.data ?? [])
    .filter((job) => job.scope === scope)
    .slice()
    .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt)), [exportsQuery.data, scope]);
  const createMutation = useMutation({
    mutationFn: () => scope === 'GROUP'
      ? api.createGroupDataExport(groupId, password, idempotencyKeyRef.current)
      : api.createPersonalDataExport(groupId, password, idempotencyKeyRef.current),
    onSuccess: async () => {
      setPassword('');
      idempotencyKeyRef.current = '';
      setDialogOpen(false);
      setMessage(t('exports.data.created'));
      await queryClient.invalidateQueries({ queryKey: exportQueryKey(groupId) });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (exportId: string) => api.deleteDataExport(exportId),
    onSuccess: async (_, exportId) => {
      setJobToDelete(null);
      queryClient.setQueryData<DataExportJob[]>(exportQueryKey(groupId), (current) => current?.filter((job) => job.id !== exportId));
      await queryClient.invalidateQueries({ queryKey: exportQueryKey(groupId) });
    },
  });
  useEffect(() => {
    const exportId = new URLSearchParams(window.location.search).get('export');
    if (!exportId || jobs.length === 0 || focusedExportRef.current === exportId) return;
    const job = document.getElementById(`data-export-${exportId}`);
    if (!job) return;
    focusedExportRef.current = exportId;
    job?.scrollIntoView({ block: 'center' });
    job?.focus({ preventScroll: true });
  }, [jobs]);

  const closeDialog = () => {
    setDialogOpen(false);
    setPassword('');
    idempotencyKeyRef.current = '';
    createMutation.reset();
  };

  return (
    <section aria-labelledby={`${passwordId}-title`} className={styles.panel}>
      <header className={styles.header}>
        <div><h2 id={`${passwordId}-title`}>{title}</h2><p>{intro}</p></div>
        <Button leadingIcon={<FileArchive size={18} />} onClick={() => { setMessage(''); idempotencyKeyRef.current = crypto.randomUUID(); setDialogOpen(true); }}>{t('exports.data.create')}</Button>
      </header>
      {message ? <p className={styles.message} role="status">{message}</p> : null}
      {exportsQuery.isLoading ? <StatePanel kind="loading" /> : null}
      {exportsQuery.isError ? <StatePanel actionLabel={t('common.retry')} kind="error" message={t('exports.data.loadError')} onAction={() => void exportsQuery.refetch()} /> : null}
      {!exportsQuery.isLoading && !exportsQuery.isError && jobs.length === 0 ? <p>{t('exports.data.empty')}</p> : null}
      {jobs.length > 0 ? <ul className={styles.jobs}>{jobs.map((job) => {
        const progress = job.progress;
        const bytes = formatBytes(job.sizeBytes);
        const progressLabel = progress ? t('exports.data.progress', { completed: progress.completed, total: progress.total }) : '';
        return (
          <li className={styles.job} id={`data-export-${job.id}`} key={job.id} tabIndex={-1}>
            <div className={styles.jobSummary}>
              <div className={styles.jobHeading}><strong>{t(`exports.data.scope.${job.scope}`)}</strong><span className={styles.status}>{t(`exports.data.status.${job.status}`)}</span></div>
              <small>{t('exports.data.requestedAt', { date: formatGermanDateTime(job.requestedAt) })}{bytes ? ` · ${bytes}` : ''}</small>
              {job.expiresAt && job.status === 'READY' ? <small>{t('exports.data.expiresAt', { date: formatGermanDateTime(job.expiresAt) })}</small> : null}
              {progress && progress.total > 0 ? <><progress aria-label={progressLabel} className={styles.progress} max={progress.total} value={progress.completed} /><small>{progressLabel}</small></> : null}
              {job.status === 'FAILED' && job.errorCode ? <p role="alert">{job.errorCode}</p> : null}
            </div>
            <div className={styles.jobActions}>
              {job.status === 'READY' ? <Button leadingIcon={<Download size={16} />} onClick={() => downloadDataExport(job)} size="small">{t('exports.data.download')}</Button> : null}
              {REMOVABLE_EXPORT_STATUSES.has(job.status) ? <Button disabled={deleteMutation.isPending} leadingIcon={job.status === 'READY' ? <Trash2 size={16} /> : <X size={16} />} onClick={() => { deleteMutation.reset(); setJobToDelete(job); }} size="small" variant="ghost">{t(job.status === 'READY' ? 'exports.data.removeFile' : 'exports.data.cancel')}</Button> : null}
            </div>
          </li>
        );
      })}</ul> : null}
      <ConfirmationDialog
        confirmIcon={jobToDelete?.status === 'READY' ? <Trash2 size={17} /> : <X size={17} />}
        confirmLabel={t(jobToDelete?.status === 'READY' ? 'exports.data.removeFile' : 'exports.data.cancel')}
        errorMessage={deleteMutation.isError ? t('exports.data.removeError') : undefined}
        message={t(jobToDelete?.status === 'READY' ? 'exports.data.removeFileMessage' : 'exports.data.cancelMessage')}
        onClose={() => setJobToDelete(null)}
        onConfirm={() => { if (jobToDelete) deleteMutation.mutate(jobToDelete.id); }}
        open={Boolean(jobToDelete)}
        pending={deleteMutation.isPending}
        title={t(jobToDelete?.status === 'READY' ? 'exports.data.removeFileTitle' : 'exports.data.cancelTitle')}
        tone="danger"
      />
      <Modal onClose={closeDialog} open={dialogOpen} title={t('exports.data.passwordTitle')}>
        <form className={styles.dialogContent} onSubmit={(event) => { event.preventDefault(); createMutation.mutate(); }}>
          <p>{t('exports.data.passwordIntro')}</p>
          <Field htmlFor={`${passwordId}-password`} label={t('exports.data.password')}><TextInput autoComplete="current-password" autoFocus id={`${passwordId}-password`} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></Field>
          {createMutation.isError ? <p className={styles.error} role="alert">{createMutation.error.message || t('exports.data.createError')}</p> : null}
          <div className={styles.dialogActions}>
            <Button leadingIcon={<X size={17} />} onClick={closeDialog} variant="secondary">{t('common.cancel')}</Button>
            <Button disabled={!password || createMutation.isPending} leadingIcon={<FileArchive size={17} />} type="submit">{t('exports.data.confirm')}</Button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
