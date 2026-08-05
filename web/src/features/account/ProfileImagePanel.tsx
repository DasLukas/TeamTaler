import { useMutation, useQueryClient } from '@tanstack/react-query';
import ImageUp from 'lucide-react/dist/esm/icons/image-up';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import X from 'lucide-react/dist/esm/icons/x';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { Membership, Session } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import styles from './ProfileImagePanel.module.css';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type AvatarChange = { kind: 'upload'; file: File } | { kind: 'remove' };

/**
 * Renders self-service profile-image controls for the authenticated account.
 * Successful mutations synchronize session and membership query caches so all
 * avatar surfaces update immediately without a page reload.
 *
 * @returns A validated profile-image upload and removal panel.
 */
export function ProfileImagePanel() {
  const { t } = useTranslation();
  const { session } = useActiveGroup();
  const queryClient = useQueryClient();
  const [selectedFile, setSelectedFile] = useState<File>();
  const [fileInputKey, setFileInputKey] = useState(0);
  const [fileError, setFileError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const mutation = useMutation({
    mutationFn: async (change: AvatarChange) => change.kind === 'upload'
      ? api.uploadProfileAvatar(change.file)
      : api.removeProfileAvatar().then(() => ({ avatarUrl: undefined })),
    onSuccess: ({ avatarUrl }, change) => {
      queryClient.setQueryData<Session>(['session'], (current) => current ? {
        ...current,
        user: { ...current.user, avatarUrl },
      } : current);
      queryClient.setQueriesData<Membership[]>({ queryKey: ['members'] }, (members) => members?.map((member) => (
        member.userId === session.user.id ? { ...member, avatarUrl } : member
      )));
      void queryClient.invalidateQueries({ queryKey: ['bookings'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setSelectedFile(undefined);
      setFileInputKey((current) => current + 1);
      setFileError('');
      setSuccessMessage(t(change.kind === 'upload' ? 'account.profileImage.saved' : 'account.profileImage.removed'));
    },
  });

  const selectFile = (file?: File) => {
    mutation.reset();
    setSuccessMessage('');
    if (!file) {
      setSelectedFile(undefined);
      setFileError('');
      return;
    }
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      setSelectedFile(undefined);
      setFileError(t('account.profileImage.invalidType'));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setSelectedFile(undefined);
      setFileError(t('account.profileImage.tooLarge'));
      return;
    }
    setFileError('');
    setSelectedFile(file);
  };

  const clearSelection = () => {
    setSelectedFile(undefined);
    setFileInputKey((current) => current + 1);
    setFileError('');
    setSuccessMessage('');
    mutation.reset();
  };

  return (
    <section aria-labelledby="profile-image-title" className={styles.card}>
      <Avatar name={session.user.displayName} size="large" src={session.user.avatarUrl} />
      <div className={styles.controls}>
        <div>
          <h2 id="profile-image-title">{t('account.profileImage.title')}</h2>
          <p>{t('account.profileImage.description')}</p>
        </div>
        <Field error={fileError || undefined} hint={t('account.profileImage.hint')} htmlFor="profile-image" label={t('account.profileImage.label')}>
          <TextInput accept="image/jpeg,image/png,image/webp" id="profile-image" key={fileInputKey} onChange={(event) => selectFile(event.target.files?.[0])} type="file" />
        </Field>
        {selectedFile ? (
          <div className={styles.selection}>
            <span>{selectedFile.name}</span>
            <Button aria-label={t('account.profileImage.clearSelection')} leadingIcon={<X size={16} />} onClick={clearSelection} size="small" variant="ghost">
              {t('account.profileImage.clearSelection')}
            </Button>
          </div>
        ) : null}
        {mutation.isError ? <p className={styles.error} role="alert">{t('account.profileImage.error')} {mutation.error.message}</p> : null}
        {successMessage ? <p className={styles.success} role="status">{successMessage}</p> : null}
        <div className={styles.actions}>
          {session.user.avatarUrl ? (
            <Button disabled={mutation.isPending} leadingIcon={<Trash2 size={18} />} onClick={() => mutation.mutate({ kind: 'remove' })} variant="secondary">
              {t('account.profileImage.remove')}
            </Button>
          ) : null}
          <Button disabled={!selectedFile || mutation.isPending} leadingIcon={<ImageUp size={18} />} onClick={() => selectedFile && mutation.mutate({ kind: 'upload', file: selectedFile })}>
            {mutation.isPending ? t('account.profileImage.saving') : t('account.profileImage.save')}
          </Button>
        </div>
      </div>
    </section>
  );
}
