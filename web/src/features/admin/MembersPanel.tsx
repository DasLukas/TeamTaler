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
import QrCode from 'lucide-react/dist/esm/icons/qr-code';
import { useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/api/client';
import type {
  CreatedInvitation,
  EmailDeliveryStatus,
  InvitationImportRow,
  InvitationImportStatus,
  InvitationInput,
  InvitationMetadata,
  Membership,
  Role,
} from '@/api/types';
import { can } from '@/app/permissions';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { StatePanel } from '@/components/ui/StatePanel';
import tableStyles from '@/features/shared/Table.module.css';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { RoleAssignmentPicker } from './RoleAssignmentPicker';
import { RoleMultiSelect } from './RoleMultiSelect';
import { PublicJoinLinkDialog } from './PublicJoinLinkDialog';
import { roleDisplayName } from './roleDisplayName';
import styles from './MembersPanel.module.css';

type MembersDialog = 'invite' | 'import' | 'edit' | 'revoke' | 'resend' | 'remove' | 'rename-guest' | 'claim-guest' | null;

interface MemberImportDialogProps {
  activeGroupId: string;
  defaultRole?: Role;
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

/**
 * Determines whether a membership still represents a temporary guest.
 *
 * @param member - Membership returned by the administrator directory.
 * @returns Whether the guest has no claimable account email yet.
 */
function isTemporaryGuest(member: Membership): boolean {
  return member.isTemporaryGuest && member.email === null;
}

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
function downloadImportTemplate(fileName: string, defaultRoleName = ''): void {
  const escapedRoleName = `"${defaultRoleName.replaceAll('"', '""')}"`;
  const csv = `\uFEFFemail,display_name,roles\r\nmember@example.com,Alex Example,${defaultRoleName ? escapedRoleName : ''}\r\n`;
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
  if (row.code === 'unknown_role') return t('members.csvImport.errors.unknownRole');
  if (row.code === 'missing_default_role') return t('members.csvImport.errors.missingDefaultRole');
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
function MemberImportDialog({ activeGroupId, defaultRole, onClose }: MemberImportDialogProps) {
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
          <p className={styles.defaultRoleNotice}>{defaultRole ? t('members.csvImport.defaultRole', { role: roleDisplayName(defaultRole) }) : t('members.csvImport.noDefaultRole')}</p>
          <div className={styles.templateRow}>
            <p>{t('members.csvImport.schema')}</p>
            <Button leadingIcon={<Download size={17} />} onClick={() => downloadImportTemplate(t('members.csvImport.templateFileName'), defaultRole?.name)} size="small" variant="ghost">{t('members.csvImport.downloadTemplate')}</Button>
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

const emptyInvitationInput = (): InvitationInput => ({ email: '', displayName: '', roleIds: [], roles: ['MEMBER'], groupPermissions: [], categoryPermissions: [] });

/**
 * Renders open invitations, active members, former members, and all associated
 * lifecycle dialogs and versioned role assignment controls.
 *
 * @returns A localized member and invitation administration workspace.
 */
export function MembersPanel() {
  const { t } = useTranslation();
  const { activeGroupId, activeGroup, session } = useActiveGroup();
  const queryClient = useQueryClient();
  const membersQueryKey = ['members', activeGroupId] as const;
  const invitationQueryKey = ['invitations', activeGroupId] as const;
  const compact = useMediaQuery('(max-width: 767px)');
  const membersQuery = useQuery({ queryKey: membersQueryKey, queryFn: () => api.getMembers(activeGroupId) });
  const canManageRoles = can(activeGroup.membership?.effectiveGrants, 'ROLE_MANAGEMENT');
  const canManageProtectedRoles = can(activeGroup.membership?.effectiveGrants, 'GROUP_ADMINISTRATION');
  const canManageAssignments = canManageRoles || canManageProtectedRoles;
  const rolesQueryKey = ['roles', activeGroupId] as const;
  const rolesQuery = useQuery({ queryKey: rolesQueryKey, queryFn: () => api.getRoles(activeGroupId), enabled: canManageAssignments });
  const invitationsQuery = useQuery({
    queryKey: invitationQueryKey,
    queryFn: () => api.getInvitations(activeGroupId),
    refetchInterval: (query) => query.state.data?.some((item) => ACTIVE_DELIVERY_STATUSES.has(item.emailDeliveryStatus)) ? DELIVERY_POLL_INTERVAL_MS : false,
  });
  const settingsQuery = useQuery({ queryKey: ['group-settings', activeGroupId], queryFn: () => api.getGroupSettings(activeGroupId), enabled: canManageProtectedRoles });
  const [dialog, setDialog] = useState<MembersDialog>(null);
  const [publicJoinOpen, setPublicJoinOpen] = useState(false);
  const [draft, setDraft] = useState<InvitationInput>(emptyInvitationInput);
  const [createdInvitation, setCreatedInvitation] = useState<CreatedInvitation | null>(null);
  const [selectedInvitation, setSelectedInvitation] = useState<InvitationMetadata | null>(null);
  const [selectedMember, setSelectedMember] = useState<Membership | null>(null);
  const [resendResult, setResendResult] = useState<{ acceptUrl: string; expiresAt: string } | null>(null);
  const [guestDisplayName, setGuestDisplayName] = useState('');
  const [guestClaimEmail, setGuestClaimEmail] = useState('');
  const [guestClaimRoleIds, setGuestClaimRoleIds] = useState<string[]>([]);
  const [guestClaimInvitation, setGuestClaimInvitation] = useState<CreatedInvitation | null>(null);

  const createMutation = useMutation({
    mutationFn: () => api.createInvitation(activeGroupId, { ...draft, email: draft.email.trim(), displayName: draft.displayName.trim(), roleIds: draft.roleIds ?? [] }),
    onSuccess: async (result) => {
      setCreatedInvitation(result);
      await queryClient.invalidateQueries({ queryKey: invitationQueryKey });
    },
  });
  const updateMutation = useMutation({
    mutationFn: () => {
      if (!selectedInvitation) return Promise.reject(new Error(t('members.noInvitationSelected')));
      return canManageAssignments
        ? api.updateInvitation(activeGroupId, selectedInvitation.id, {
          displayName: draft.displayName.trim(),
          roleIds: draft.roleIds ?? [],
          roleAssignmentsVersion: selectedInvitation.roleAssignmentsVersion,
        })
        : api.updateInvitation(activeGroupId, selectedInvitation.id, {
          displayName: draft.displayName.trim(),
          roleAssignmentsVersion: selectedInvitation.roleAssignmentsVersion,
          roles: draft.roles,
          groupPermissions: draft.groupPermissions,
          categoryPermissions: draft.categoryPermissions,
        });
    },
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
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: membersQueryKey }),
        queryClient.invalidateQueries({ queryKey: invitationQueryKey }),
        ...(selfRemoval ? [queryClient.invalidateQueries({ queryKey: ['session'] })] : []),
      ]);
    },
  });
  const renameGuestMutation = useMutation({
    mutationFn: () => selectedMember
      ? api.renameMember(activeGroupId, selectedMember.id, guestDisplayName.trim())
      : Promise.reject(new Error(t('members.noMemberSelected'))),
    onSuccess: async () => {
      setDialog(null);
      setSelectedMember(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: membersQueryKey }),
        queryClient.invalidateQueries({ queryKey: ['booking-context', activeGroupId] }),
      ]);
    },
  });
  const claimGuestMutation = useMutation({
    mutationFn: () => selectedMember
      ? api.createTemporaryGuestClaimInvitation(activeGroupId, selectedMember.id, guestClaimEmail.trim(), guestClaimRoleIds)
      : Promise.reject(new Error(t('members.noMemberSelected'))),
    onSuccess: async (invitation) => {
      setGuestClaimInvitation(invitation);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: invitationQueryKey }),
        queryClient.invalidateQueries({ queryKey: membersQueryKey }),
      ]);
    },
  });

  const invalidateRoleAssignmentData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: membersQueryKey }),
      queryClient.invalidateQueries({ queryKey: invitationQueryKey }),
      queryClient.invalidateQueries({ queryKey: rolesQueryKey }),
      queryClient.invalidateQueries({ queryKey: ['role-assignments', activeGroupId] }),
      queryClient.invalidateQueries({ queryKey: ['session'] }),
    ]);
  };
  const applyMemberRoles = async (member: Membership, roleIds: string[]) => {
    try {
      await api.updateMemberRoles(activeGroupId, member.id, roleIds, member.roleAssignmentsVersion ?? 1);
      await invalidateRoleAssignmentData();
    } catch (error) {
      if (error instanceof ApiError && error.problem.status === 412) await invalidateRoleAssignmentData();
      throw error;
    }
  };
  const applyInvitationRoles = async (invitation: InvitationMetadata, roleIds: string[]) => {
    try {
      await api.updateInvitationRoles(activeGroupId, invitation.id, roleIds, invitation.roleAssignmentsVersion);
      await invalidateRoleAssignmentData();
    } catch (error) {
      if (error instanceof ApiError && error.problem.status === 412) await invalidateRoleAssignmentData();
      throw error;
    }
  };

  if (membersQuery.isLoading || invitationsQuery.isLoading || (canManageAssignments && rolesQuery.isLoading) || (canManageProtectedRoles && settingsQuery.isLoading)) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (!membersQuery.data || !invitationsQuery.data || (canManageAssignments && !rolesQuery.data) || (canManageProtectedRoles && !settingsQuery.data)) return <div className={styles.state}><StatePanel kind="error" message={t('members.error')} /></div>;

  const activeMembers = membersQuery.data.filter((member) => member.active);
  const formerMembers = membersQuery.data.filter((member) => !member.active);
  const openInvitations = invitationsQuery.data.filter((invitation) => !invitation.acceptedAt && !invitation.revokedAt);
  const claimInvitationMembershipIds = new Set(openInvitations.flatMap((invitation) => invitation.targetMembershipId && Date.parse(invitation.expiresAt) > invitationsQuery.dataUpdatedAt ? [invitation.targetMembershipId] : []));
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
    setGuestDisplayName('');
    setGuestClaimEmail('');
    setGuestClaimRoleIds([]);
    setGuestClaimInvitation(null);
    createMutation.reset();
    updateMutation.reset();
    revokeMutation.reset();
    resendMutation.reset();
    archiveMutation.reset();
    renameGuestMutation.reset();
    claimGuestMutation.reset();
  };
  const openInvite = (member?: Membership) => {
    setDraft({ ...emptyInvitationInput(), email: member?.email ?? '', displayName: member?.displayName ?? '', roleIds: settingsQuery.data?.defaultRoleId ? [settingsQuery.data.defaultRoleId] : [] });
    setDialog('invite');
  };
  const openEdit = (invitation: InvitationMetadata) => {
    setSelectedInvitation(invitation);
    setDraft({ email: invitation.email, displayName: invitation.displayName ?? '', roleIds: invitation.roleIds ?? [], roles: invitation.roles, groupPermissions: invitation.groupPermissions, categoryPermissions: invitation.categoryPermissions });
    setDialog('edit');
  };
  const openGuestRename = (member: Membership) => {
    setSelectedMember(member);
    setGuestDisplayName(member.displayName);
    setDialog('rename-guest');
  };
  const openGuestClaim = (member: Membership) => {
    setSelectedMember(member);
    setGuestClaimEmail('');
    setGuestClaimRoleIds(settingsQuery.data?.defaultRoleId ? [settingsQuery.data.defaultRoleId] : []);
    setGuestClaimInvitation(null);
    setDialog('claim-guest');
  };
  const roles = rolesQuery.data ?? [];
  const defaultRole = roles.find((role) => role.id === settingsQuery.data?.defaultRoleId);
  const guestClaimRoleConfigured = Boolean(settingsQuery.data?.defaultRoleId);
  const reservedAdminRole = roles.find((role) => role.presetKey === 'GROUP_ADMINISTRATOR');
  const lockedAdministratorRoleIds = (roleIds: readonly string[]) => reservedAdminRole
    && reservedAdminRole.memberCount <= 1
    && roleIds.includes(reservedAdminRole.id)
    ? [reservedAdminRole.id]
    : [];
  const renderGuestClaimAction = (member: Membership, claimPending: boolean) => {
    if (claimPending) return <span className={styles.claimPending}>{t('members.claimPending')}</span>;
    const descriptionId = `claim-unavailable-${member.id}`;
    return <span className={styles.claimAction}>
      <Button
        aria-describedby={guestClaimRoleConfigured ? undefined : descriptionId}
        aria-label={t('members.claimGuestFor', { name: member.displayName })}
        disabled={!guestClaimRoleConfigured}
        leadingIcon={<MailPlus size={16} />}
        onClick={() => openGuestClaim(member)}
        size="small"
        title={guestClaimRoleConfigured ? undefined : t('members.claimUnavailableNoRole')}
        variant="ghost"
      >{t('members.claimGuest')}</Button>
      {!guestClaimRoleConfigured ? <span className={styles.claimUnavailable} id={descriptionId}>{t('members.claimUnavailableNoRole')}</span> : null}
    </span>;
  };

  return (
    <div className={styles.content}>
      <header className={styles.header}>
        <h2>{t('members.title')}</h2>
        {canManageProtectedRoles ? <div className={styles.headerActions}>
          <Button aria-label={t('publicJoin.action')} className={styles.headerAction} leadingIcon={<QrCode size={18} />} onClick={() => setPublicJoinOpen(true)} title={t('publicJoin.action')} variant="secondary">{t('publicJoin.action')}</Button>
          {canManageRoles ? <>
            <Button aria-label={t('members.csvImport.action')} className={styles.headerAction} leadingIcon={<FileUp size={18} />} onClick={() => setDialog('import')} title={t('members.csvImport.action')} variant="secondary">{t('members.csvImport.action')}</Button>
            <Button aria-label={t('members.invite')} className={styles.headerAction} leadingIcon={<UserRoundPlus size={18} />} onClick={() => openInvite()} title={t('members.invite')}>{t('members.invite')}</Button>
          </> : null}
        </div> : null}
      </header>

      <section className={styles.section}>
        <div className={styles.sectionHeading}><h3>{t('members.openInvitations')}</h3><span>{openInvitations.length}</span></div>
        {openInvitations.length === 0 ? <p className={styles.emptySection}>{t('members.noOpenInvitations')}</p> : (
          compact ? <div className={styles.mobileCards}>{openInvitations.map((item) => {
            const expired = Date.parse(item.expiresAt) <= invitationsQuery.dataUpdatedAt;
            const resendBlocked = ACTIVE_DELIVERY_STATUSES.has(item.emailDeliveryStatus);
            const claimInvitation = Boolean(item.targetMembershipId);
            return <article className={styles.mobileCard} key={item.id}>
              <header className={styles.mobileCardHeader}><div><strong>{item.displayName || item.email}</strong><small>{item.email}</small></div><span className={deliveryBadgeClass(item.emailDeliveryStatus)}>{t(DELIVERY_STATUS_KEYS[item.emailDeliveryStatus])}</span></header>
              <p className={expired ? styles.expired : styles.mobileMetadata}>{expired ? t('members.expired') : t('members.validUntilDate', { date: new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(item.expiresAt)) })}</p>
              {claimInvitation ? <p className={styles.temporaryGuestRole}>{t('members.claimInvitationRoleLocked')}</p> : <RoleAssignmentPicker canManageGroup={canManageProtectedRoles} canManageRoles={canManageRoles} onApply={(roleIds) => applyInvitationRoles(item, roleIds)} roleIds={item.roleIds ?? []} roles={roles} subjectName={item.displayName || item.email} />}
              {canManageProtectedRoles ? <div className={styles.mobileActions}>
                {!claimInvitation ? <Button aria-label={t('members.editInvitationFor', { email: item.email })} leadingIcon={<Pencil size={16} />} onClick={() => openEdit(item)} size="small" variant="ghost">{t('common.edit')}</Button> : null}
                <Button aria-label={t('members.resendFor', { email: item.email })} disabled={resendBlocked} leadingIcon={<RotateCcw size={16} />} onClick={() => { setSelectedInvitation(item); setResendResult(null); setDialog('resend'); }} size="small" variant="ghost">{t('members.resend')}</Button>
                <Button aria-label={t('members.deleteInvitationFor', { email: item.email })} leadingIcon={<Trash2 size={16} />} onClick={() => { setSelectedInvitation(item); setDialog('revoke'); }} size="small" variant="ghost">{t('common.delete')}</Button>
              </div> : null}
            </article>;
          })}</div> : <div className={tableStyles.tableWrap}>
            <table className={tableStyles.table}>
              <thead><tr><th>{t('members.email')}</th><th>{t('common.name')}</th><th>{t('members.roles')}</th><th>{t('members.delivery')}</th><th>{t('members.validUntil')}</th>{canManageProtectedRoles ? <th><span className="sr-only">{t('common.action')}</span></th> : null}</tr></thead>
              <tbody>{openInvitations.map((item) => {
                const expired = Date.parse(item.expiresAt) <= invitationsQuery.dataUpdatedAt;
                const resendBlocked = ACTIVE_DELIVERY_STATUSES.has(item.emailDeliveryStatus);
                const claimInvitation = Boolean(item.targetMembershipId);
                return (
                  <tr key={item.id}>
                    <td>{canManageProtectedRoles && !claimInvitation ? <button className={styles.rowLink} onClick={() => openEdit(item)} type="button"><strong>{item.email}</strong></button> : <strong>{item.email}</strong>}</td>
                    <td>{item.displayName || '–'}</td>
                    <td className={styles.roleCell}>{claimInvitation ? <span className={styles.temporaryGuestRole}>{t('members.claimInvitationRoleLocked')}</span> : <RoleAssignmentPicker canManageGroup={canManageProtectedRoles} canManageRoles={canManageRoles} onApply={(roleIds) => applyInvitationRoles(item, roleIds)} roleIds={item.roleIds ?? []} roles={roles} subjectName={item.displayName || item.email} />}</td>
                    <td><span className={deliveryBadgeClass(item.emailDeliveryStatus)}>{t(DELIVERY_STATUS_KEYS[item.emailDeliveryStatus])}</span></td>
                    <td><span className={expired ? styles.expired : ''}>{expired ? t('members.expired') : new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(item.expiresAt))}</span></td>
                    {canManageProtectedRoles ? <td><div className={styles.tableActions}>
                      {!claimInvitation ? <Button aria-label={t('members.editInvitationFor', { email: item.email })} leadingIcon={<Pencil size={16} />} onClick={() => openEdit(item)} size="small" variant="ghost">{t('common.edit')}</Button> : null}
                      <Button aria-label={t('members.resendFor', { email: item.email })} disabled={resendBlocked} leadingIcon={<RotateCcw size={16} />} onClick={() => { setSelectedInvitation(item); setResendResult(null); setDialog('resend'); }} size="small" variant="ghost">{t('members.resend')}</Button>
                      <Button aria-label={t('members.deleteInvitationFor', { email: item.email })} leadingIcon={<Trash2 size={16} />} onClick={() => { setSelectedInvitation(item); setDialog('revoke'); }} size="small" variant="ghost">{t('common.delete')}</Button>
                    </div></td> : null}
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeading}><h3>{t('members.activeMembers')}</h3><span>{activeMembers.length}</span></div>
        {compact ? <div className={styles.mobileCards}>{activeMembers.map((member) => {
          const temporaryGuest = isTemporaryGuest(member);
          const claimPending = claimInvitationMembershipIds.has(member.id);
          return <article className={styles.mobileCard} key={member.id}>
            <header className={styles.mobileCardHeader}><span className={styles.member}><Avatar decorative name={member.displayName} src={member.avatarUrl} /><span><span className={styles.memberName}><strong>{member.displayName}</strong>{temporaryGuest ? <span className={styles.guestBadge}>{t('members.temporaryGuestBadge')}</span> : null}</span><small>{member.email ?? t('members.noLogin')}</small></span></span></header>
            {temporaryGuest ? <p className={styles.temporaryGuestRole}>{t('members.temporaryGuestRole')}</p> : <RoleAssignmentPicker canManageGroup={canManageProtectedRoles} canManageRoles={canManageRoles} lockedRoleIds={lockedAdministratorRoleIds(member.roleIds ?? [])} onApply={(roleIds) => applyMemberRoles(member, roleIds)} roleIds={member.roleIds ?? []} roles={roles} subjectName={member.displayName} />}
            {canManageProtectedRoles ? <div className={styles.mobileActions}>
              {temporaryGuest ? <Button aria-label={t('members.renameGuestFor', { name: member.displayName })} leadingIcon={<Pencil size={16} />} onClick={() => openGuestRename(member)} size="small" variant="ghost">{t('members.renameGuest')}</Button> : null}
              {temporaryGuest ? renderGuestClaimAction(member, claimPending) : null}
              <Button aria-label={t('members.removeFor', { name: member.displayName })} leadingIcon={<UserMinus size={16} />} onClick={() => { setSelectedMember(member); setDialog('remove'); }} size="small" variant="ghost">{temporaryGuest ? t('members.archiveGuest') : t('members.remove')}</Button>
            </div> : null}
          </article>;
        })}</div> : <div className={tableStyles.tableWrap}>
          <table className={tableStyles.table}>
            <thead><tr><th>{t('common.member')}</th><th>{t('members.email')}</th><th>{t('members.roles')}</th>{canManageProtectedRoles ? <th><span className="sr-only">{t('common.action')}</span></th> : null}</tr></thead>
            <tbody>{activeMembers.map((member) => {
              const temporaryGuest = isTemporaryGuest(member);
              const claimPending = claimInvitationMembershipIds.has(member.id);
              return <tr key={member.id}>
                <td><span className={styles.member}><Avatar decorative name={member.displayName} src={member.avatarUrl} /> <span className={styles.memberName}><strong>{member.displayName}</strong>{temporaryGuest ? <span className={styles.guestBadge}>{t('members.temporaryGuestBadge')}</span> : null}</span></span></td>
                <td>{member.email ?? <span className={styles.noLogin}>{t('members.noLogin')}</span>}</td>
                <td className={styles.roleCell}>{temporaryGuest ? <span className={styles.temporaryGuestRole}>{t('members.temporaryGuestRole')}</span> : <RoleAssignmentPicker canManageGroup={canManageProtectedRoles} canManageRoles={canManageRoles} lockedRoleIds={lockedAdministratorRoleIds(member.roleIds ?? [])} onApply={(roleIds) => applyMemberRoles(member, roleIds)} roleIds={member.roleIds ?? []} roles={roles} subjectName={member.displayName} />}</td>
                {canManageProtectedRoles ? <td><div className={styles.tableActions}>
                  {temporaryGuest ? <Button aria-label={t('members.renameGuestFor', { name: member.displayName })} leadingIcon={<Pencil size={16} />} onClick={() => openGuestRename(member)} size="small" variant="ghost">{t('members.renameGuest')}</Button> : null}
                  {temporaryGuest ? renderGuestClaimAction(member, claimPending) : null}
                  <Button aria-label={t('members.removeFor', { name: member.displayName })} leadingIcon={<UserMinus size={16} />} onClick={() => { setSelectedMember(member); setDialog('remove'); }} size="small" variant="ghost">{temporaryGuest ? t('members.archiveGuest') : t('members.remove')}</Button>
                </div></td> : null}
              </tr>;
            })}</tbody>
          </table>
        </div>}
      </section>

      {canManageProtectedRoles ? <section className={styles.section}>
        <div className={styles.sectionHeading}><h3>{t('members.formerMembers')}</h3><span>{formerMembers.length}</span></div>
        {formerMembers.length === 0 ? <p className={styles.emptySection}>{t('members.noFormerMembers')}</p> : (
          <div className={tableStyles.tableWrap}><table className={tableStyles.table}>
            <thead><tr><th>{t('common.member')}</th><th>{t('members.email')}</th><th><span className="sr-only">{t('common.action')}</span></th></tr></thead>
            <tbody>{formerMembers.map((member) => <tr key={member.id}><td><span className={styles.member}><Avatar decorative name={member.displayName} src={member.avatarUrl} /> <span className={styles.memberName}><strong>{member.displayName}</strong>{isTemporaryGuest(member) ? <span className={styles.guestBadge}>{t('members.temporaryGuestBadge')}</span> : null}</span></span></td><td>{member.email ?? <span className={styles.noLogin}>{t('members.noLogin')}</span>}</td><td>{member.email ? <Button leadingIcon={<MailPlus size={16} />} onClick={() => openInvite(member)} size="small" variant="ghost">{t('members.inviteAgain')}</Button> : null}</td></tr>)}</tbody>
          </table></div>
        )}
      </section> : null}

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
            {canManageAssignments ? <RoleMultiSelect canManageGroup={canManageProtectedRoles} canManageRoles={canManageRoles} label={t('roleManagement.invitationRoles')} onChange={(roleIds) => setDraft((current) => ({ ...current, roleIds }))} roleIds={draft.roleIds ?? []} roles={roles} /> : <p className={styles.expiry}>{t('members.baseRoleOnly')}</p>}
            <p className={styles.expiry}>{t('members.expiry')}</p>
            {createMutation.isError ? <p className={styles.error} role="alert">{createMutation.error.message}</p> : null}
            <div className={styles.actions}><Button onClick={closeDialog} variant="secondary">{t('common.cancel')}</Button><Button disabled={!draft.email.trim() || (draft.roleIds?.length ?? 0) === 0 || createMutation.isPending} type="submit">{t('members.createInvitation')}</Button></div>
          </form>
        )}
      </Modal>

      <Modal className={styles.permissionDialog} onClose={closeDialog} open={dialog === 'edit'} title={t('members.editInvitation')}>
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); updateMutation.mutate(); }}>
          <Field hint={t('members.emailImmutable')} htmlFor="edit-invitation-email" label={t('auth.email')}><TextInput disabled id="edit-invitation-email" value={draft.email} /></Field>
          <Field hint={t('members.displayNameHint')} htmlFor="edit-invitation-display-name" label={t('auth.displayName')}><TextInput id="edit-invitation-display-name" maxLength={120} onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))} value={draft.displayName} /></Field>
          {canManageAssignments ? <RoleMultiSelect canManageGroup={canManageProtectedRoles} canManageRoles={canManageRoles} label={t('roleManagement.invitationRoles')} onChange={(roleIds) => setDraft((current) => ({ ...current, roleIds }))} roleIds={draft.roleIds ?? []} roles={roles} /> : <p className={styles.expiry}>{t('members.rolesProtected')}</p>}
          {updateMutation.isError ? <p className={styles.error} role="alert">{updateMutation.error.message}</p> : null}
          <div className={styles.actions}><Button onClick={closeDialog} variant="secondary">{t('common.cancel')}</Button><Button disabled={(draft.roleIds?.length ?? 0) === 0 || updateMutation.isPending} type="submit">{t('common.save')}</Button></div>
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

      <Modal onClose={closeDialog} open={dialog === 'rename-guest'} title={t('members.renameGuestTitle')}>
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); renameGuestMutation.mutate(); }}>
          <p className={styles.expiry}>{t('members.renameGuestDescription')}</p>
          <Field hint={t('members.renameGuestHint')} htmlFor="temporary-guest-display-name" label={t('auth.displayName')}>
            <TextInput autoComplete="off" id="temporary-guest-display-name" maxLength={120} onChange={(event) => { setGuestDisplayName(event.target.value); renameGuestMutation.reset(); }} required value={guestDisplayName} />
          </Field>
          {renameGuestMutation.isError ? <p className={styles.error} role="alert">{renameGuestMutation.error.message}</p> : null}
          <div className={styles.actions}><Button onClick={closeDialog} variant="secondary">{t('common.cancel')}</Button><Button disabled={!guestDisplayName.trim() || guestDisplayName.trim() === selectedMember?.displayName || renameGuestMutation.isPending} type="submit">{renameGuestMutation.isPending ? t('members.renameGuestPending') : t('common.save')}</Button></div>
        </form>
      </Modal>

      <Modal onClose={closeDialog} open={dialog === 'claim-guest'} title={t('members.claimGuestTitle')}>
        {guestClaimInvitation ? <div className={styles.invitationReady}>
          <MailPlus aria-hidden="true" size={38} />
          <h3>{t('members.claimGuestReadyTitle')}</h3>
          <p>{t('members.claimGuestReadyDescription', { name: selectedMember?.displayName ?? '', email: guestClaimInvitation.email })}</p>
          <p>{t('members.invitationExpiry', { date: new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(guestClaimInvitation.expiresAt)) })}</p>
          {guestClaimInvitation.acceptUrl ? <div className={styles.fallbackLink}><p>{t('members.fallbackHint')}</p><div className={styles.copyRow}><TextInput aria-label={t('members.invitationLink')} readOnly value={guestClaimInvitation.acceptUrl} /><Button leadingIcon={<Copy size={17} />} onClick={() => void navigator.clipboard.writeText(guestClaimInvitation.acceptUrl)} variant="secondary">{t('common.copy')}</Button></div></div> : null}
          <Button fullWidth onClick={closeDialog}>{t('common.done')}</Button>
        </div> : <form className={styles.form} onSubmit={(event) => { event.preventDefault(); claimGuestMutation.mutate(); }}>
          <p className={styles.expiry}>{t('members.claimGuestDescription', { name: selectedMember?.displayName ?? '' })}</p>
          <Field hint={t('members.claimGuestEmailHint')} htmlFor="temporary-guest-claim-email" label={t('auth.email')}>
            <TextInput autoComplete="email" id="temporary-guest-claim-email" onChange={(event) => { setGuestClaimEmail(event.target.value); claimGuestMutation.reset(); }} required type="email" value={guestClaimEmail} />
          </Field>
          {canManageRoles ? (
            <RoleMultiSelect canManageGroup={canManageProtectedRoles} canManageRoles label={t('roleManagement.memberRoles')} onChange={(roleIds) => { setGuestClaimRoleIds(roleIds); claimGuestMutation.reset(); }} roleIds={guestClaimRoleIds} roles={roles} />
          ) : <p className={styles.claimNotice}>{t('members.claimDefaultRole', { role: defaultRole ? roleDisplayName(defaultRole) : t('members.claimUnavailableNoRole') })}</p>}
          <p className={styles.claimNotice}>{t('members.claimGuestHistoryNotice')}</p>
          {claimGuestMutation.isError ? <p className={styles.error} role="alert">{claimGuestMutation.error.message}</p> : null}
          <div className={styles.actions}><Button onClick={closeDialog} variant="secondary">{t('common.cancel')}</Button><Button disabled={!guestClaimEmail.trim() || guestClaimRoleIds.length === 0 || claimGuestMutation.isPending} type="submit">{claimGuestMutation.isPending ? t('members.claimGuestPending') : t('members.claimGuestCreate')}</Button></div>
        </form>}
      </Modal>

      <Modal onClose={closeDialog} open={dialog === 'remove'} title={selectedMember && isTemporaryGuest(selectedMember) ? t('members.archiveGuestTitle') : selectedMember?.userId === session.user.id ? t('members.removeSelfTitle') : t('members.removeTitle')}>
        <div className={styles.confirmDialog}><p>{selectedMember && isTemporaryGuest(selectedMember) ? t('members.archiveGuestExplanation', { name: selectedMember.displayName }) : selectedMember?.userId === session.user.id ? t('members.removeSelfExplanation') : t('members.removeExplanation', { name: selectedMember?.displayName ?? '' })}</p>{archiveMutation.isError ? <p className={styles.error} role="alert">{archiveMutation.error.message}</p> : null}<div className={styles.actions}><Button onClick={closeDialog} variant="secondary">{t('common.cancel')}</Button><Button disabled={archiveMutation.isPending} onClick={() => archiveMutation.mutate()} variant="danger">{selectedMember && isTemporaryGuest(selectedMember) ? t('members.archiveGuest') : selectedMember?.userId === session.user.id ? t('members.confirmSelfRemoval') : t('members.remove')}</Button></div></div>
      </Modal>

      {dialog === 'import' ? <MemberImportDialog activeGroupId={activeGroupId} defaultRole={defaultRole} onClose={closeDialog} /> : null}
      {publicJoinOpen ? <PublicJoinLinkDialog groupId={activeGroupId} onClose={() => setPublicJoinOpen(false)} /> : null}
    </div>
  );
}
