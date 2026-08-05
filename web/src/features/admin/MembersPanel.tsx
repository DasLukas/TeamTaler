import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import Copy from 'lucide-react/dist/esm/icons/copy';
import Download from 'lucide-react/dist/esm/icons/download';
import FileUp from 'lucide-react/dist/esm/icons/file-up';
import MailPlus from 'lucide-react/dist/esm/icons/mail-plus';
import Pencil from 'lucide-react/dist/esm/icons/pencil';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import UserMinus from 'lucide-react/dist/esm/icons/user-minus';
import UserRoundPlus from 'lucide-react/dist/esm/icons/user-round-plus';
import { useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type {
  CreatedInvitation,
  EmailDeliveryStatus,
  InvitationImportRow,
  InvitationImportStatus,
  InvitationInput,
  InvitationMetadata,
  Membership,
  PermissionUpdate,
} from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { StatePanel } from '@/components/ui/StatePanel';
import tableStyles from '@/features/shared/Table.module.css';
import { PermissionEditor } from './PermissionEditor';
import styles from './MembersPanel.module.css';

type MembersDialog = 'invite' | 'import' | 'edit' | 'revoke' | 'resend' | 'remove' | null;

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

const MANUAL_DELIVERY_COPY_KEYS: Record<EmailDeliveryStatus, { title: string; description: string }> = {
  PENDING: { title: 'members.invitationStatus.pendingTitle', description: 'members.invitationStatus.pendingDescription' },
  SENDING: { title: 'members.invitationStatus.sendingTitle', description: 'members.invitationStatus.sendingDescription' },
  SENT: { title: 'members.invitationStatus.sentTitle', description: 'members.invitationStatus.sentDescription' },
  FAILED: { title: 'members.invitationStatus.failedTitle', description: 'members.invitationStatus.failedDescription' },
  CANCELLED: { title: 'members.invitationStatus.cancelledTitle', description: 'members.invitationStatus.cancelledDescription' },
  NOT_REQUESTED: { title: 'members.invitationStatus.notRequestedTitle', description: 'members.invitationStatus.notRequestedDescription' },
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
    mutationFn: (invitationId: string) => api.resendInvitationEmail(activeGroupId, invitationId),
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

/** Inputs for navigating from the member directory to one member's rights. */
export interface MembersPanelProps {
  onOpenRights?: (membershipId: string) => void;
}

const emptyInvitationInput = (): InvitationInput => ({ email: '', displayName: '', roles: ['MEMBER'], categoryPermissions: [] });

function roleSummary(member: Pick<Membership, 'roles'>, t: TFunction): string {
  return member.roles.filter((role) => role !== 'MEMBER').map((role) => role === 'ADMIN'
    ? t('roles.admin.label')
    : role === 'FINANCE_MANAGER' ? t('roles.finance.label') : t('roles.catalog.label')).join(', ') || t('roles.member');
}

/**
 * Renders open invitations, active members, former members, and all associated
 * lifecycle dialogs.
 *
 * @param props - Optional callback used to open one active member in the rights tab.
 * @returns A localized member and invitation administration workspace.
 */
export function MembersPanel({ onOpenRights }: MembersPanelProps) {
  const { t } = useTranslation();
  const { activeGroupId, session } = useActiveGroup();
  const queryClient = useQueryClient();
  const membersQueryKey = ['members', activeGroupId] as const;
  const invitationQueryKey = ['invitations', activeGroupId] as const;
  const membersQuery = useQuery({ queryKey: membersQueryKey, queryFn: () => api.getMembers(activeGroupId) });
  const categoriesQuery = useQuery({ queryKey: ['categories', activeGroupId], queryFn: () => api.getCategories(activeGroupId) });
  const invitationsQuery = useQuery({
    queryKey: invitationQueryKey,
    queryFn: () => api.getInvitations(activeGroupId),
    refetchInterval: (query) => query.state.data?.some((item) => ACTIVE_DELIVERY_STATUSES.has(item.emailDeliveryStatus)) ? DELIVERY_POLL_INTERVAL_MS : false,
  });
  const [dialog, setDialog] = useState<MembersDialog>(null);
  const [draft, setDraft] = useState<InvitationInput>(emptyInvitationInput);
  const [createdInvitation, setCreatedInvitation] = useState<CreatedInvitation | null>(null);
  const [selectedInvitation, setSelectedInvitation] = useState<InvitationMetadata | null>(null);
  const [selectedMember, setSelectedMember] = useState<Membership | null>(null);
  const [resendResult, setResendResult] = useState<{ acceptUrl: string; expiresAt: string } | null>(null);

  const createMutation = useMutation({
    mutationFn: () => api.createInvitation(activeGroupId, { ...draft, email: draft.email.trim(), displayName: draft.displayName.trim() }),
    onSuccess: async (result) => {
      setCreatedInvitation(result);
      await queryClient.invalidateQueries({ queryKey: invitationQueryKey });
    },
  });
  const updateMutation = useMutation({
    mutationFn: () => selectedInvitation
      ? api.updateInvitation(activeGroupId, selectedInvitation.id, { displayName: draft.displayName.trim(), roles: draft.roles, categoryPermissions: draft.categoryPermissions })
      : Promise.reject(new Error(t('members.noInvitationSelected'))),
    onSuccess: async () => {
      setDialog(null);
      await queryClient.invalidateQueries({ queryKey: invitationQueryKey });
    },
  });
  const revokeMutation = useMutation({
    mutationFn: () => selectedInvitation ? api.revokeInvitation(activeGroupId, selectedInvitation.id) : Promise.reject(new Error(t('members.noInvitationSelected'))),
    onSuccess: async () => {
      setDialog(null);
      setSelectedInvitation(null);
      await queryClient.invalidateQueries({ queryKey: invitationQueryKey });
    },
  });
  const resendMutation = useMutation({
    mutationFn: () => selectedInvitation ? api.resendInvitationEmail(activeGroupId, selectedInvitation.id) : Promise.reject(new Error(t('members.noInvitationSelected'))),
    onSuccess: async (result) => {
      setResendResult({ acceptUrl: result.acceptUrl, expiresAt: result.expiresAt });
      await queryClient.invalidateQueries({ queryKey: invitationQueryKey });
    },
  });
  const archiveMutation = useMutation({
    mutationFn: () => selectedMember ? api.archiveMember(activeGroupId, selectedMember.id, selectedMember.userId === session.user.id) : Promise.reject(new Error(t('members.noMemberSelected'))),
    onSuccess: async () => {
      const selfRemoval = selectedMember?.userId === session.user.id;
      setDialog(null);
      setSelectedMember(null);
      await queryClient.invalidateQueries({ queryKey: membersQueryKey });
      if (selfRemoval) await queryClient.invalidateQueries({ queryKey: ['session'] });
    },
  });

  if (membersQuery.isLoading || invitationsQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (!membersQuery.data || !invitationsQuery.data) return <div className={styles.state}><StatePanel kind="error" message={t('members.error')} /></div>;

  const activeMembers = membersQuery.data.filter((member) => member.active);
  const formerMembers = membersQuery.data.filter((member) => !member.active);
  const openInvitations = invitationsQuery.data.filter((invitation) => !invitation.acceptedAt && !invitation.revokedAt);
  const invitationDeliveryStatus = createdInvitation
    ? invitationsQuery.data.find((item) => item.id === createdInvitation.id)?.emailDeliveryStatus ?? createdInvitation.emailDeliveryStatus
    : null;
  const closeDialog = () => {
    setDialog(null);
    setDraft(emptyInvitationInput());
    setCreatedInvitation(null);
    setSelectedInvitation(null);
    setSelectedMember(null);
    setResendResult(null);
    createMutation.reset();
    updateMutation.reset();
    revokeMutation.reset();
    resendMutation.reset();
    archiveMutation.reset();
  };
  const openInvite = (member?: Membership) => {
    setDraft({ ...emptyInvitationInput(), email: member?.email ?? '', displayName: member?.displayName ?? '' });
    setDialog('invite');
  };
  const openEdit = (invitation: InvitationMetadata) => {
    setSelectedInvitation(invitation);
    setDraft({ email: invitation.email, displayName: invitation.displayName ?? '', roles: invitation.roles, categoryPermissions: invitation.categoryPermissions });
    setDialog('edit');
  };
  const permissionValue: PermissionUpdate = { roles: draft.roles, categoryPermissions: draft.categoryPermissions };
  const setPermissionValue = (value: PermissionUpdate) => setDraft((current) => ({ ...current, ...value }));

  return (
    <div className={styles.content}>
      <header className={styles.header}>
        <div><h2>{t('members.title')}</h2><p>{t('members.activeCount', { count: activeMembers.length })}</p></div>
        <div className={styles.headerActions}><Button leadingIcon={<FileUp size={18} />} onClick={() => setDialog('import')} variant="secondary">{t('members.csvImport.action')}</Button><Button leadingIcon={<UserRoundPlus size={18} />} onClick={() => openInvite()}>{t('members.invite')}</Button></div>
      </header>

      <section className={styles.section}>
        <div className={styles.sectionHeading}><h3>{t('members.openInvitations')}</h3><span>{openInvitations.length}</span></div>
        {openInvitations.length === 0 ? <p className={styles.emptySection}>{t('members.noOpenInvitations')}</p> : (
          <div className={tableStyles.tableWrap}>
            <table className={tableStyles.table}>
              <thead><tr><th>{t('members.email')}</th><th>{t('common.name')}</th><th>{t('members.delivery')}</th><th>{t('members.validUntil')}</th><th><span className="sr-only">{t('common.action')}</span></th></tr></thead>
              <tbody>{openInvitations.map((item) => {
                const expired = Date.parse(item.expiresAt) <= invitationsQuery.dataUpdatedAt;
                const resendBlocked = ACTIVE_DELIVERY_STATUSES.has(item.emailDeliveryStatus);
                return (
                  <tr key={item.id}>
                    <td><button className={styles.rowLink} onClick={() => openEdit(item)} type="button"><strong>{item.email}</strong></button></td>
                    <td>{item.displayName || '–'}</td>
                    <td><span className={deliveryBadgeClass(item.emailDeliveryStatus)}>{t(DELIVERY_STATUS_KEYS[item.emailDeliveryStatus])}</span></td>
                    <td><span className={expired ? styles.expired : ''}>{expired ? t('members.expired') : new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(item.expiresAt))}</span></td>
                    <td><div className={styles.tableActions}>
                      <Button aria-label={t('members.editInvitationFor', { email: item.email })} leadingIcon={<Pencil size={16} />} onClick={() => openEdit(item)} size="small" variant="ghost">{t('common.edit')}</Button>
                      <Button aria-label={t('members.resendFor', { email: item.email })} disabled={resendBlocked} leadingIcon={<RotateCcw size={16} />} onClick={() => { setSelectedInvitation(item); setResendResult(null); setDialog('resend'); }} size="small" variant="ghost">{t('members.resend')}</Button>
                      <Button aria-label={t('members.deleteInvitationFor', { email: item.email })} leadingIcon={<Trash2 size={16} />} onClick={() => { setSelectedInvitation(item); setDialog('revoke'); }} size="small" variant="ghost">{t('common.delete')}</Button>
                    </div></td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeading}><h3>{t('members.activeMembers')}</h3><span>{activeMembers.length}</span></div>
        <div className={tableStyles.tableWrap}>
          <table className={tableStyles.table}>
            <thead><tr><th>{t('common.member')}</th><th>{t('members.email')}</th><th>{t('members.roles')}</th><th><span className="sr-only">{t('common.action')}</span></th></tr></thead>
            <tbody>{activeMembers.map((member) => <tr key={member.id}>
              <td><button className={`${styles.rowLink} ${styles.member}`} onClick={() => onOpenRights?.(member.id)} type="button"><Avatar decorative name={member.displayName} src={member.avatarUrl} /> <strong>{member.displayName}</strong></button></td>
              <td>{member.email}</td><td>{roleSummary(member, t)}</td>
              <td><Button aria-label={t('members.removeFor', { name: member.displayName })} leadingIcon={<UserMinus size={16} />} onClick={() => { setSelectedMember(member); setDialog('remove'); }} size="small" variant="ghost">{t('members.remove')}</Button></td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeading}><h3>{t('members.formerMembers')}</h3><span>{formerMembers.length}</span></div>
        {formerMembers.length === 0 ? <p className={styles.emptySection}>{t('members.noFormerMembers')}</p> : (
          <div className={tableStyles.tableWrap}><table className={tableStyles.table}>
            <thead><tr><th>{t('common.member')}</th><th>{t('members.email')}</th><th><span className="sr-only">{t('common.action')}</span></th></tr></thead>
            <tbody>{formerMembers.map((member) => <tr key={member.id}><td><span className={styles.member}><Avatar decorative name={member.displayName} src={member.avatarUrl} /> <strong>{member.displayName}</strong></span></td><td>{member.email}</td><td><Button leadingIcon={<MailPlus size={16} />} onClick={() => openInvite(member)} size="small" variant="ghost">{t('members.inviteAgain')}</Button></td></tr>)}</tbody>
          </table></div>
        )}
      </section>

      <Modal className={styles.permissionDialog} onClose={closeDialog} open={dialog === 'invite'} title={t('members.invite')}>
        {createdInvitation ? (
          <div className={styles.invitationReady}>
            <MailPlus aria-hidden="true" size={38} />
            {invitationDeliveryStatus ? <section aria-live="polite" className={`${styles.deliveryNotice} ${invitationDeliveryStatus === 'FAILED' || invitationDeliveryStatus === 'CANCELLED' ? styles.deliveryNoticeError : ''}`} role="status"><h3>{t(MANUAL_DELIVERY_COPY_KEYS[invitationDeliveryStatus].title)}</h3><p>{t(MANUAL_DELIVERY_COPY_KEYS[invitationDeliveryStatus].description, { email: createdInvitation.email })}</p></section> : null}
            {invitationsQuery.isError ? <p className={styles.error} role="alert">{t('members.invitationStatus.statusError')}</p> : null}
            <p>{t('members.invitationExpiry', { date: new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(createdInvitation.expiresAt)) })}</p>
            <div className={styles.fallbackLink}><p>{t('members.fallbackHint')}</p><div className={styles.copyRow}><TextInput aria-label={t('members.invitationLink')} readOnly value={createdInvitation.acceptUrl} /><Button leadingIcon={<Copy size={17} />} onClick={() => void navigator.clipboard.writeText(createdInvitation.acceptUrl)} variant="secondary">{t('common.copy')}</Button></div></div>
            <Button fullWidth onClick={closeDialog}>{t('common.done')}</Button>
          </div>
        ) : (
          <form className={styles.form} onSubmit={(event) => { event.preventDefault(); createMutation.mutate(); }}>
            <div className={styles.formGrid}>
              <Field hint={t('members.emailHint')} htmlFor="invitation-email" label={t('auth.email')}><TextInput id="invitation-email" onChange={(event) => setDraft((current) => ({ ...current, email: event.target.value }))} required type="email" value={draft.email} /></Field>
              <Field hint={t('members.displayNameHint')} htmlFor="invitation-display-name" label={t('auth.displayName')}><TextInput id="invitation-display-name" maxLength={120} onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))} value={draft.displayName} /></Field>
            </div>
            {categoriesQuery.data ? <PermissionEditor categories={categoriesQuery.data} onChange={setPermissionValue} subjectName={draft.displayName || draft.email || t('common.member')} value={permissionValue} /> : <StatePanel kind="loading" />}
            <p className={styles.expiry}>{t('members.expiry')}</p>
            {createMutation.isError ? <p className={styles.error} role="alert">{createMutation.error.message}</p> : null}
            <div className={styles.actions}><Button onClick={closeDialog} variant="secondary">{t('common.cancel')}</Button><Button disabled={!draft.email.trim() || createMutation.isPending || categoriesQuery.isLoading} type="submit">{t('members.createInvitation')}</Button></div>
          </form>
        )}
      </Modal>

      <Modal className={styles.permissionDialog} onClose={closeDialog} open={dialog === 'edit'} title={t('members.editInvitation')}>
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); updateMutation.mutate(); }}>
          <Field hint={t('members.emailImmutable')} htmlFor="edit-invitation-email" label={t('auth.email')}><TextInput disabled id="edit-invitation-email" value={draft.email} /></Field>
          <Field hint={t('members.displayNameHint')} htmlFor="edit-invitation-display-name" label={t('auth.displayName')}><TextInput id="edit-invitation-display-name" maxLength={120} onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))} value={draft.displayName} /></Field>
          {categoriesQuery.data ? <PermissionEditor categories={categoriesQuery.data} onChange={setPermissionValue} subjectName={draft.displayName || draft.email} value={permissionValue} /> : null}
          {updateMutation.isError ? <p className={styles.error} role="alert">{updateMutation.error.message}</p> : null}
          <div className={styles.actions}><Button onClick={closeDialog} variant="secondary">{t('common.cancel')}</Button><Button disabled={updateMutation.isPending} type="submit">{t('common.save')}</Button></div>
        </form>
      </Modal>

      <Modal onClose={closeDialog} open={dialog === 'revoke'} title={t('members.deleteInvitationTitle')}>
        <div className={styles.confirmDialog}><p>{t('members.deleteInvitationExplanation', { email: selectedInvitation?.email ?? '' })}</p>{revokeMutation.isError ? <p className={styles.error} role="alert">{revokeMutation.error.message}</p> : null}<div className={styles.actions}><Button onClick={closeDialog} variant="secondary">{t('common.cancel')}</Button><Button disabled={revokeMutation.isPending} onClick={() => revokeMutation.mutate()} variant="danger">{t('common.delete')}</Button></div></div>
      </Modal>

      <Modal onClose={closeDialog} open={dialog === 'resend'} title={t('members.resendTitle')}>
        <div className={styles.confirmDialog}>
          {resendResult ? <><p>{t('members.resendSuccess', { email: selectedInvitation?.email ?? '', date: new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(resendResult.expiresAt)) })}</p><p className={styles.warning}>{t('members.oldLinksInvalid')}</p>{resendResult.acceptUrl ? <div className={styles.copyRow}><TextInput aria-label={t('members.invitationLink')} readOnly value={resendResult.acceptUrl} /><Button leadingIcon={<Copy size={17} />} onClick={() => void navigator.clipboard.writeText(resendResult.acceptUrl)} variant="secondary">{t('common.copy')}</Button></div> : <p className={styles.warning}>{t('members.resendFallbackUnavailable')}</p>}<Button fullWidth onClick={closeDialog}>{t('common.done')}</Button></> : <><p>{t('members.resendExplanation', { email: selectedInvitation?.email ?? '' })}</p>{resendMutation.isError ? <p className={styles.error} role="alert">{resendMutation.error.message}</p> : null}<div className={styles.actions}><Button onClick={closeDialog} variant="secondary">{t('common.cancel')}</Button><Button disabled={resendMutation.isPending} onClick={() => resendMutation.mutate()}>{t('members.resend')}</Button></div></>}
        </div>
      </Modal>

      <Modal onClose={closeDialog} open={dialog === 'remove'} title={selectedMember?.userId === session.user.id ? t('members.removeSelfTitle') : t('members.removeTitle')}>
        <div className={styles.confirmDialog}><p>{selectedMember?.userId === session.user.id ? t('members.removeSelfExplanation') : t('members.removeExplanation', { name: selectedMember?.displayName ?? '' })}</p>{archiveMutation.isError ? <p className={styles.error} role="alert">{archiveMutation.error.message}</p> : null}<div className={styles.actions}><Button onClick={closeDialog} variant="secondary">{t('common.cancel')}</Button><Button disabled={archiveMutation.isPending} onClick={() => archiveMutation.mutate()} variant="danger">{selectedMember?.userId === session.user.id ? t('members.confirmSelfRemoval') : t('members.remove')}</Button></div></div>
      </Modal>

      {dialog === 'import' ? <MemberImportDialog activeGroupId={activeGroupId} onClose={closeDialog} /> : null}
    </div>
  );
}
