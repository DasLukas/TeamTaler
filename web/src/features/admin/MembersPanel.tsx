import { useMutation, useQuery } from '@tanstack/react-query';
import Copy from 'lucide-react/dist/esm/icons/copy';
import MailPlus from 'lucide-react/dist/esm/icons/mail-plus';
import UserRoundPlus from 'lucide-react/dist/esm/icons/user-round-plus';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { Invitation } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { StatePanel } from '@/components/ui/StatePanel';
import tableStyles from '@/features/shared/Table.module.css';
import styles from './MembersPanel.module.css';

/**
 * Renders the group member directory and one-time invitation flow.
 *
 * @returns A localized member table and invitation dialog.
 */
export function MembersPanel() {
  const { t } = useTranslation();
  const { activeGroupId } = useActiveGroup();
  const membersQuery = useQuery({ queryKey: ['members', activeGroupId], queryFn: () => api.getMembers(activeGroupId) });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const invitationMutation = useMutation({
    mutationFn: () => api.createInvitation(activeGroupId, { email: email.trim() }),
    onSuccess: setInvitation,
  });

  if (membersQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (!membersQuery.data) return <div className={styles.state}><StatePanel kind="error" message={t('members.error')} /></div>;

  const closeDialog = () => {
    setDialogOpen(false);
    setInvitation(null);
    invitationMutation.reset();
  };

  return (
    <div className={styles.content}>
      <header className={styles.header}><div><h2>{t('members.title')}</h2><p>{t('members.activeCount', { count: membersQuery.data.length })}</p></div><Button leadingIcon={<UserRoundPlus size={18} />} onClick={() => setDialogOpen(true)}>{t('members.invite')}</Button></header>
      <div className={tableStyles.tableWrap}>
        <table className={tableStyles.table}>
          <thead><tr><th>{t('common.member')}</th><th>{t('members.email')}</th><th>{t('members.roles')}</th><th>{t('common.status')}</th></tr></thead>
          <tbody>{membersQuery.data.map((member) => <tr key={member.id}><td><span className={styles.member}><Avatar name={member.displayName} /> <strong>{member.displayName}</strong></span></td><td>{member.email}</td><td>{member.roles.filter((role) => role !== 'MEMBER').map((role) => role === 'ADMIN' ? t('roles.admin.label') : role === 'FINANCE_MANAGER' ? t('roles.finance.label') : t('roles.catalog.label')).join(', ') || t('roles.member')}</td><td><span className={`${tableStyles.status} ${!member.active ? tableStyles.statusMuted : ''}`}>{member.active ? t('common.active') : t('common.archived')}</span></td></tr>)}</tbody>
        </table>
      </div>
      <Modal onClose={closeDialog} open={dialogOpen} title={t('members.invite')}>
        {invitation ? (
          <div className={styles.invitationReady}>
            <MailPlus aria-hidden="true" size={38} />
            <h3>{t('members.invitationCreated')}</h3>
            <p>{t('members.invitationExpiry', { date: new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(invitation.expiresAt)) })}</p>
            <div className={styles.copyRow}><TextInput aria-label={t('members.invitationLink')} readOnly value={invitation.acceptUrl} /><Button leadingIcon={<Copy size={17} />} onClick={() => void navigator.clipboard.writeText(invitation.acceptUrl)} variant="secondary">{t('common.copy')}</Button></div>
            <Button fullWidth onClick={closeDialog}>{t('common.done')}</Button>
          </div>
        ) : (
          <form className={styles.form} onSubmit={(event) => { event.preventDefault(); invitationMutation.mutate(); }}>
            <Field hint={t('members.emailHint')} htmlFor="invitation-email" label={t('auth.email')}>
              <TextInput id="invitation-email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
            </Field>
            <p className={styles.expiry}>{t('members.expiry')}</p>
            {invitationMutation.isError ? <p className={styles.error} role="alert">{invitationMutation.error.message}</p> : null}
            <div className={styles.actions}><Button onClick={closeDialog} variant="secondary">{t('common.cancel')}</Button><Button disabled={!email.trim() || invitationMutation.isPending} type="submit">{t('members.createLink')}</Button></div>
          </form>
        )}
      </Modal>
    </div>
  );
}
