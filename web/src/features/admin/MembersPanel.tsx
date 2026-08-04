import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import Copy from 'lucide-react/dist/esm/icons/copy';
import Download from 'lucide-react/dist/esm/icons/download';
import FileUp from 'lucide-react/dist/esm/icons/file-up';
import MailPlus from 'lucide-react/dist/esm/icons/mail-plus';
import UserRoundPlus from 'lucide-react/dist/esm/icons/user-round-plus';
import { useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type {
  CreatedInvitation,
  EmailDeliveryStatus,
  InvitationImportRow,
  InvitationImportStatus,
  InvitationMetadata,
} from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { StatePanel } from '@/components/ui/StatePanel';
import tableStyles from '@/features/shared/Table.module.css';
import styles from './MembersPanel.module.css';

type MembersDialog = 'invite' | 'import' | null;

interface MemberImportDialogProps {
  activeGroupId: string;
  onClose: () => void;
}

interface DeliverySummary {
  waiting: number;
  sent: number;
  failed: number;
}

const MAX_CSV_BYTES = 256 * 1024;
const DELIVERY_POLL_INTERVAL_MS = 1_200;
const ACTIVE_DELIVERY_STATUSES = new Set<EmailDeliveryStatus>(['PENDING', 'SENDING']);

const INVITATION_STATUS_KEYS: Record<InvitationImportStatus, string> = {
  CREATED: 'members.csvImport.invitationStatus.created',
  INVALID: 'members.csvImport.invitationStatus.invalid',
  SKIPPED_ALREADY_MEMBER: 'members.csvImport.invitationStatus.alreadyMember',
  SKIPPED_ALREADY_INVITED: 'members.csvImport.invitationStatus.alreadyInvited',
};

const DELIVERY_STATUS_KEYS: Record<EmailDeliveryStatus, string> = {
  PENDING: 'members.csvImport.deliveryStatus.pending',
  SENDING: 'members.csvImport.deliveryStatus.sending',
  SENT: 'members.csvImport.deliveryStatus.sent',
  FAILED: 'members.csvImport.deliveryStatus.failed',
  CANCELLED: 'members.csvImport.deliveryStatus.cancelled',
  NOT_REQUESTED: 'members.csvImport.deliveryStatus.notRequested',
};

/**
 * Downloads a UTF-8 CSV template for the member invitation import.
 *
 * @param fileName - Localized filename offered by the browser.
 * @returns Nothing after dispatching the browser download.
 */
function downloadImportTemplate(fileName: string): void {
  const csv = '\uFEFFemail,display_name\r\nmember@example.com,Alex Example\r\n';
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Resolves the current delivery state for one imported row.
 *
 * @param row - Original row-level import result.
 * @param invitations - Latest non-secret invitation metadata keyed by invitation ID.
 * @returns The polled state, the import response state, or a safe default.
 */
function resolveDeliveryStatus(row: InvitationImportRow, invitations: ReadonlyMap<string, InvitationMetadata>): EmailDeliveryStatus {
  if (row.invitationId) {
    const current = invitations.get(row.invitationId)?.emailDeliveryStatus;
    if (current) return current;
  }
  if (row.emailDeliveryStatus) return row.emailDeliveryStatus;
  return row.invitationStatus === 'CREATED' ? 'PENDING' : 'NOT_REQUESTED';
}

/**
 * Counts the user-relevant delivery states displayed in the import summary.
 *
 * @param rows - Imported CSV row results.
 * @param invitations - Latest non-secret invitation metadata keyed by invitation ID.
 * @returns Counts for outstanding, accepted, and failed email delivery.
 */
function summarizeDeliveries(rows: InvitationImportRow[], invitations: ReadonlyMap<string, InvitationMetadata>): DeliverySummary {
  const summary: DeliverySummary = { waiting: 0, sent: 0, failed: 0 };
  for (const row of rows) {
    const status = resolveDeliveryStatus(row, invitations);
    if (status === 'PENDING' || status === 'SENDING') summary.waiting += 1;
    else if (status === 'SENT') summary.sent += 1;
    else if (status === 'FAILED') summary.failed += 1;
  }
  return summary;
}

/**
 * Returns localized explanatory copy for one row outcome.
 *
 * @param row - Row-level import result and optional stable validation code.
 * @param t - Active i18next translation function.
 * @returns A localized explanation without exposing internal error text.
 */
function importRowDetail(row: InvitationImportRow, t: TFunction): string {
  if (row.code === 'invalid_email') return t('members.csvImport.errors.invalidEmail');
  if (row.code === 'invalid_display_name') return t('members.csvImport.errors.invalidDisplayName');
  if (row.code === 'display_name_too_long') return t('members.csvImport.errors.displayNameTooLong');
  if (row.code === 'duplicate_email') return t('members.csvImport.errors.duplicateEmail');
  if (row.invitationStatus === 'INVALID') return t('members.csvImport.errors.invalidRow');
  if (row.invitationStatus === 'SKIPPED_ALREADY_MEMBER') return t('members.csvImport.errors.alreadyMember');
  if (row.invitationStatus === 'SKIPPED_ALREADY_INVITED') return t('members.csvImport.errors.alreadyInvited');
  return t('members.csvImport.noDetails');
}

/**
 * Selects the visual badge treatment for one invitation outcome.
 *
 * @param status - Invitation creation result.
 * @returns Shared and feature-specific CSS classes for the status badge.
 */
function invitationBadgeClass(status: InvitationImportStatus): string {
  if (status === 'INVALID') return `${tableStyles.status} ${styles.statusError}`;
  if (status.startsWith('SKIPPED_')) return `${tableStyles.status} ${tableStyles.statusMuted}`;
  return tableStyles.status;
}

/**
 * Selects the visual badge treatment for one delivery state.
 *
 * @param status - Current outbound email state.
 * @returns Shared and feature-specific CSS classes for the status badge.
 */
function deliveryBadgeClass(status: EmailDeliveryStatus): string {
  if (status === 'FAILED') return `${tableStyles.status} ${styles.statusError}`;
  if (status === 'PENDING' || status === 'SENDING') return `${tableStyles.status} ${tableStyles.statusWarning}`;
  if (status === 'CANCELLED' || status === 'NOT_REQUESTED') return `${tableStyles.status} ${tableStyles.statusMuted}`;
  return tableStyles.status;
}

/**
 * Renders the file selection and row-level result flow for member invitations.
 *
 * @param props - Active group scope and modal close callback.
 * @returns A localized, accessible CSV import modal.
 */
function MemberImportDialog({ activeGroupId, onClose }: MemberImportDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selectedFile, setSelectedFile] = useState<File>();
  const [fileError, setFileError] = useState('');
  const importMutation = useMutation({
    mutationFn: (file: File) => api.importInvitations(activeGroupId, file),
  });
  const result = importMutation.data;
  const invitationQueryKey = ['invitations', activeGroupId] as const;
  const trackedInvitationIds = useMemo(() => result?.rows.flatMap((row) => row.invitationId ? [row.invitationId] : []) ?? [], [result]);
  const trackedInvitationIdSet = useMemo(() => new Set(trackedInvitationIds), [trackedInvitationIds]);
  const invitationsQuery = useQuery({
    queryKey: invitationQueryKey,
    queryFn: () => api.getInvitations(activeGroupId),
    enabled: trackedInvitationIds.length > 0,
    refetchInterval: (query) => {
      if (trackedInvitationIds.length === 0) return false;
      const invitations = query.state.data;
      if (!invitations) return DELIVERY_POLL_INTERVAL_MS;
      let deliveryActive = false;
      for (const invitation of invitations) {
        if (!trackedInvitationIdSet.has(invitation.id)) continue;
        if (ACTIVE_DELIVERY_STATUSES.has(invitation.emailDeliveryStatus)) deliveryActive = true;
      }
      return deliveryActive ? DELIVERY_POLL_INTERVAL_MS : false;
    },
  });
  const retryMutation = useMutation({
    mutationFn: (invitationId: string) => api.retryInvitationEmail(activeGroupId, invitationId),
    onSuccess: async ({ invitationId, emailDeliveryStatus }) => {
      queryClient.setQueryData<InvitationMetadata[]>(invitationQueryKey, (invitations) => invitations?.map((invitation) => (
        invitation.id === invitationId ? { ...invitation, emailDeliveryStatus, emailSentAt: undefined } : invitation
      )));
      await queryClient.invalidateQueries({ queryKey: invitationQueryKey });
    },
  });
  const invitationsById = useMemo(
    () => new Map((invitationsQuery.data ?? []).map((invitation) => [invitation.id, invitation])),
    [invitationsQuery.data],
  );
  const deliverySummary = useMemo(
    () => summarizeDeliveries(result?.rows ?? [], invitationsById),
    [invitationsById, result?.rows],
  );

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    importMutation.reset();
    setFileError('');
    if (!file) {
      setSelectedFile(undefined);
      return;
    }
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setSelectedFile(undefined);
      setFileError(t('members.csvImport.invalidFile'));
      event.target.value = '';
      return;
    }
    if (file.size === 0) {
      setSelectedFile(undefined);
      setFileError(t('members.csvImport.emptyFile'));
      event.target.value = '';
      return;
    }
    if (file.size > MAX_CSV_BYTES) {
      setSelectedFile(undefined);
      setFileError(t('members.csvImport.fileTooLarge'));
      event.target.value = '';
      return;
    }
    setSelectedFile(file);
  };

  const submitImport = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedFile) importMutation.mutate(selectedFile);
  };

  const startAnotherImport = () => {
    setSelectedFile(undefined);
    setFileError('');
    importMutation.reset();
    retryMutation.reset();
  };

  return (
    <Modal className={styles.importDialog} onClose={onClose} open title={t('members.csvImport.title')}>
      {result ? (
        <div className={styles.importResults}>
          <section aria-live="polite" className={styles.importSummary} role="status">
            <div>
              <h3>{t('members.csvImport.resultTitle')}</h3>
              <p>{t('members.csvImport.resultDescription')}</p>
            </div>
            <div className={styles.summaryGrid}>
              <div><strong>{result.summary.totalRows}</strong><span>{t('members.csvImport.summary.total')}</span></div>
              <div><strong>{result.summary.created}</strong><span>{t('members.csvImport.summary.created')}</span></div>
              <div><strong>{result.summary.invalid}</strong><span>{t('members.csvImport.summary.invalid')}</span></div>
              <div><strong>{result.summary.skipped}</strong><span>{t('members.csvImport.summary.skipped')}</span></div>
            </div>
            <p className={styles.deliverySummary}>
              <span>{t('members.csvImport.deliveryWaiting', { count: deliverySummary.waiting })}</span>
              <span>{t('members.csvImport.deliverySent', { count: deliverySummary.sent })}</span>
              <span>{t('members.csvImport.deliveryFailed', { count: deliverySummary.failed })}</span>
            </p>
          </section>
          {invitationsQuery.isError ? <p className={styles.error} role="alert">{t('members.csvImport.statusError')}</p> : null}
          {retryMutation.isError ? <p className={styles.error} role="alert">{t('members.csvImport.retryError')}</p> : null}
          <div className={`${tableStyles.tableWrap} ${styles.resultTableWrap}`}>
            <table className={tableStyles.table}>
              <caption className="sr-only">{t('members.csvImport.resultsTable')}</caption>
              <thead><tr><th scope="col">{t('members.csvImport.row')}</th><th scope="col">{t('common.name')}</th><th scope="col">{t('members.email')}</th><th scope="col">{t('members.csvImport.invitation')}</th><th scope="col">{t('members.csvImport.delivery')}</th><th scope="col">{t('common.details')}</th></tr></thead>
              <tbody>{result.rows.map((row) => {
                const deliveryStatus = resolveDeliveryStatus(row, invitationsById);
                const invitationId = row.invitationId;
                return (
                  <tr key={`${row.row}-${row.email ?? ''}`}>
                    <td className={tableStyles.number}>{row.row}</td>
                    <td>{row.displayName || '–'}</td>
                    <td>{row.email || '–'}</td>
                    <td><span className={invitationBadgeClass(row.invitationStatus)}>{t(INVITATION_STATUS_KEYS[row.invitationStatus])}</span></td>
                    <td><span className={deliveryBadgeClass(deliveryStatus)}>{t(DELIVERY_STATUS_KEYS[deliveryStatus])}</span></td>
                    <td className={styles.detailCell}>
                      <div className={styles.rowDetail}>
                        <span>{deliveryStatus === 'FAILED' ? t('members.csvImport.errors.deliveryFailed') : importRowDetail(row, t)}</span>
                        {deliveryStatus === 'FAILED' && invitationId ? (
                          <Button aria-label={t('members.csvImport.retryFor', { email: row.email ?? '' })} disabled={retryMutation.isPending} onClick={() => retryMutation.mutate(invitationId)} size="small" variant="ghost">
                            {retryMutation.isPending && retryMutation.variables === invitationId ? t('members.csvImport.retryPending') : t('members.csvImport.retry')}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
          <div className={styles.actions}><Button onClick={startAnotherImport} variant="secondary">{t('members.csvImport.importAnother')}</Button><Button onClick={onClose}>{t('common.done')}</Button></div>
        </div>
      ) : (
        <form className={styles.importForm} onSubmit={submitImport}>
          <div className={styles.importIntro}>
            <p>{t('members.csvImport.intro')}</p>
            <p>{t('members.csvImport.membershipNotice')}</p>
          </div>
          <div className={styles.templateRow}>
            <p>{t('members.csvImport.schema')}</p>
            <Button leadingIcon={<Download size={17} />} onClick={() => downloadImportTemplate(t('members.csvImport.templateFileName'))} size="small" variant="ghost">{t('members.csvImport.downloadTemplate')}</Button>
          </div>
          <Field error={fileError || undefined} hint={t('members.csvImport.fileHint')} htmlFor="member-import-file" label={t('members.csvImport.fileLabel')}>
            <TextInput accept=".csv,text/csv" id="member-import-file" onChange={handleFileChange} type="file" />
          </Field>
          {selectedFile ? <p className={styles.selectedFile} role="status">{t('members.csvImport.selectedFile', { name: selectedFile.name })}</p> : null}
          {importMutation.isError ? <p className={styles.error} role="alert">{t('members.csvImport.requestError', { message: importMutation.error.message })}</p> : null}
          <div className={styles.actions}><Button onClick={onClose} variant="secondary">{t('common.cancel')}</Button><Button disabled={!selectedFile || importMutation.isPending} leadingIcon={<FileUp size={17} />} type="submit">{importMutation.isPending ? t('members.csvImport.pending') : t('members.csvImport.submit')}</Button></div>
        </form>
      )}
    </Modal>
  );
}

/**
 * Renders the group member directory, one-time invitation flow, and CSV import.
 *
 * @returns A localized member table with invitation and bulk-import dialogs.
 */
export function MembersPanel() {
  const { t } = useTranslation();
  const { activeGroupId } = useActiveGroup();
  const membersQuery = useQuery({ queryKey: ['members', activeGroupId], queryFn: () => api.getMembers(activeGroupId) });
  const [dialog, setDialog] = useState<MembersDialog>(null);
  const [email, setEmail] = useState('');
  const [invitation, setInvitation] = useState<CreatedInvitation | null>(null);
  const invitationMutation = useMutation({
    mutationFn: () => api.createInvitation(activeGroupId, { email: email.trim() }),
    onSuccess: setInvitation,
  });

  if (membersQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (!membersQuery.data) return <div className={styles.state}><StatePanel kind="error" message={t('members.error')} /></div>;

  const closeInvitationDialog = () => {
    setDialog(null);
    setEmail('');
    setInvitation(null);
    invitationMutation.reset();
  };

  return (
    <div className={styles.content}>
      <header className={styles.header}>
        <div><h2>{t('members.title')}</h2><p>{t('members.activeCount', { count: membersQuery.data.length })}</p></div>
        <div className={styles.headerActions}><Button leadingIcon={<FileUp size={18} />} onClick={() => setDialog('import')} variant="secondary">{t('members.csvImport.action')}</Button><Button leadingIcon={<UserRoundPlus size={18} />} onClick={() => setDialog('invite')}>{t('members.invite')}</Button></div>
      </header>
      <div className={tableStyles.tableWrap}>
        <table className={tableStyles.table}>
          <thead><tr><th>{t('common.member')}</th><th>{t('members.email')}</th><th>{t('members.roles')}</th><th>{t('common.status')}</th></tr></thead>
          <tbody>{membersQuery.data.map((member) => <tr key={member.id}><td><span className={styles.member}><Avatar name={member.displayName} /> <strong>{member.displayName}</strong></span></td><td>{member.email}</td><td>{member.roles.filter((role) => role !== 'MEMBER').map((role) => role === 'ADMIN' ? t('roles.admin.label') : role === 'FINANCE_MANAGER' ? t('roles.finance.label') : t('roles.catalog.label')).join(', ') || t('roles.member')}</td><td><span className={`${tableStyles.status} ${!member.active ? tableStyles.statusMuted : ''}`}>{member.active ? t('common.active') : t('common.archived')}</span></td></tr>)}</tbody>
        </table>
      </div>
      <Modal onClose={closeInvitationDialog} open={dialog === 'invite'} title={t('members.invite')}>
        {invitation ? (
          <div className={styles.invitationReady}>
            <MailPlus aria-hidden="true" size={38} />
            <h3>{t('members.invitationCreated')}</h3>
            <p>{t('members.invitationExpiry', { date: new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(invitation.expiresAt)) })}</p>
            <div className={styles.copyRow}><TextInput aria-label={t('members.invitationLink')} readOnly value={invitation.acceptUrl} /><Button leadingIcon={<Copy size={17} />} onClick={() => void navigator.clipboard.writeText(invitation.acceptUrl)} variant="secondary">{t('common.copy')}</Button></div>
            <Button fullWidth onClick={closeInvitationDialog}>{t('common.done')}</Button>
          </div>
        ) : (
          <form className={styles.form} onSubmit={(event) => { event.preventDefault(); invitationMutation.mutate(); }}>
            <Field hint={t('members.emailHint')} htmlFor="invitation-email" label={t('auth.email')}>
              <TextInput id="invitation-email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
            </Field>
            <p className={styles.expiry}>{t('members.expiry')}</p>
            {invitationMutation.isError ? <p className={styles.error} role="alert">{invitationMutation.error.message}</p> : null}
            <div className={styles.actions}><Button onClick={closeInvitationDialog} variant="secondary">{t('common.cancel')}</Button><Button disabled={!email.trim() || invitationMutation.isPending} type="submit">{t('members.createLink')}</Button></div>
          </form>
        )}
      </Modal>
      {dialog === 'import' ? <MemberImportDialog activeGroupId={activeGroupId} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
