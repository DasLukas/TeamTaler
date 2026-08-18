import { useMutation, useQueryClient } from '@tanstack/react-query';
import ImageUp from 'lucide-react/dist/esm/icons/image-up';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import X from 'lucide-react/dist/esm/icons/x';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { Membership, Session } from '@/api/types';
import { useInstanceCapabilities, useSession } from '@/app/useSession';
import { ImageCropEditor } from '@/components/media/ImageCropEditor';
import {
  ACCEPTED_IMAGE_TYPES,
  DEFAULT_IMAGE_TRANSFORM,
  formatMediaUploadLimit,
  prepareSquareImage,
  type ImageTransform,
} from '@/components/media/imageUpload';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import styles from './ProfileImagePanel.module.css';

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
  const session = useSession();
  const { mediaUploadMaxBytes } = useInstanceCapabilities();
  const uploadLimit = formatMediaUploadLimit(mediaUploadMaxBytes);
  const queryClient = useQueryClient();
  const [selectedFile, setSelectedFile] = useState<File>();
  const [imageTransform, setImageTransform] = useState<ImageTransform>(DEFAULT_IMAGE_TRANSFORM);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [fileError, setFileError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const mutation = useMutation({
    mutationFn: async (change: AvatarChange) => {
      if (change.kind === 'remove') {
        return api.removeProfileAvatar().then(() => ({ avatarUrl: undefined }));
      }
      const prepared = await prepareSquareImage(change.file, imageTransform);
      if (prepared.size > mediaUploadMaxBytes) throw new Error(t('account.profileImage.tooLarge', { limit: uploadLimit }));
      return api.uploadProfileAvatar(prepared);
    },
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
      setImageTransform(DEFAULT_IMAGE_TRANSFORM);
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
      setImageTransform(DEFAULT_IMAGE_TRANSFORM);
      setFileError('');
      return;
    }
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      setSelectedFile(undefined);
      setFileError(t('account.profileImage.invalidType'));
      return;
    }
    if (file.size > mediaUploadMaxBytes) {
      setSelectedFile(undefined);
      setFileError(t('account.profileImage.tooLarge', { limit: uploadLimit }));
      return;
    }
    setFileError('');
    setSelectedFile(file);
    setImageTransform(DEFAULT_IMAGE_TRANSFORM);
  };

  const clearSelection = () => {
    setSelectedFile(undefined);
    setImageTransform(DEFAULT_IMAGE_TRANSFORM);
    setFileInputKey((current) => current + 1);
    setFileError('');
    setSuccessMessage('');
    mutation.reset();
  };

  return (
    <section aria-labelledby="profile-image-title" className={styles.card}>
      {selectedFile ? (
        <ImageCropEditor
          alt={t('account.profileImage.previewAlt')}
          circular
          file={selectedFile}
          key={`${selectedFile.name}:${selectedFile.size}:${selectedFile.lastModified}`}
          onChange={setImageTransform}
          value={imageTransform}
        />
      ) : (
        <Avatar name={session.user.displayName} size="large" src={session.user.avatarUrl} />
      )}
      <div className={styles.controls}>
        <div>
          <h2 id="profile-image-title">{t('account.profileImage.title')}</h2>
          <p>{t('account.profileImage.description')}</p>
        </div>
        <Field error={fileError || undefined} hint={t('account.profileImage.hint', { limit: uploadLimit })} htmlFor="profile-image" label={t('account.profileImage.label')}>
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
