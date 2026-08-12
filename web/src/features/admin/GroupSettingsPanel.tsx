import { useMutation, useQueryClient } from '@tanstack/react-query';
import ImageUp from 'lucide-react/dist/esm/icons/image-up';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { Session } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { ImageCropEditor } from '@/components/media/ImageCropEditor';
import {
  ACCEPTED_IMAGE_TYPES,
  DEFAULT_IMAGE_TRANSFORM,
  MAX_IMAGE_BYTES,
  prepareSquareImage,
  type ImageTransform,
} from '@/components/media/imageUpload';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import styles from './GroupSettingsPanel.module.css';

type LogoChange = { kind: 'upload'; file: File } | { kind: 'remove' };

/** Properties for group identity controls embedded in another settings surface. */
interface GroupSettingsPanelProps {
  /** Removes the standalone title and uses nested heading levels. */
  embedded?: boolean;
}

/**
 * Renders the administrator-only group-name form and synchronizes successful
 * updates into the shared session cache.
 *
 * @param props - Stable group identity and the currently persisted name.
 * @returns A validated group-name form with mutation feedback.
 */
function GroupNameForm({ groupId, currentName, embedded }: { groupId: string; currentName: string; embedded: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(currentName);
  const [savedName, setSavedName] = useState(currentName);
  const normalizedName = name.trim();
  const nameMutation = useMutation({
    mutationFn: () => api.updateGroupName(groupId, normalizedName),
    onSuccess: ({ name: persistedName }) => {
      queryClient.setQueryData<Session>(['session'], (session) => session ? {
        ...session,
        groups: session.groups.map((group) => group.id === groupId ? { ...group, name: persistedName } : group),
      } : session);
      setName(persistedName);
      setSavedName(persistedName);
    },
  });

  return (
    <form className={`${styles.card} ${styles.nameCard}`} onSubmit={(event) => { event.preventDefault(); nameMutation.mutate(); }}>
      <div className={styles.controls}>
        <div>
          {embedded ? <h4>{t('groupSettings.nameTitle')}</h4> : <h3>{t('groupSettings.nameTitle')}</h3>}
        </div>
        <Field htmlFor="group-name" label={t('groupSettings.nameLabel')}>
          <TextInput autoComplete="organization" id="group-name" maxLength={120} onChange={(event) => { setName(event.target.value); nameMutation.reset(); }} required value={name} />
        </Field>
        {nameMutation.isError ? <p className={styles.error} role="alert">{t('groupSettings.nameUpdateError')} {nameMutation.error.message}</p> : null}
        {nameMutation.isSuccess ? <p className={styles.success} role="status">{t('groupSettings.nameSaved')}</p> : null}
        <div className={styles.actions}>
          <Button disabled={!normalizedName || normalizedName === savedName || nameMutation.isPending} type="submit">
            {nameMutation.isPending ? t('groupSettings.nameSaving') : t('groupSettings.nameSave')}
          </Button>
        </div>
      </div>
    </form>
  );
}

/**
 * Renders administrator-only group identity and branding controls.
 *
 * Only server-validated, normalized images are rendered. Successful mutations
 * update the shared session cache so every active brand surface changes without
 * a page reload.
 *
 * @param props - Optional embedding behavior for the combined settings workspace.
 * @returns Group-name settings, a group-logo preview, and update actions.
 */
export function GroupSettingsPanel({ embedded = false }: GroupSettingsPanelProps) {
  const { t } = useTranslation();
  const { activeGroup, activeGroupId } = useActiveGroup();
  const queryClient = useQueryClient();
  const [selectedFile, setSelectedFile] = useState<File>();
  const [imageTransform, setImageTransform] = useState<ImageTransform>(DEFAULT_IMAGE_TRANSFORM);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [fileError, setFileError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const logoMutation = useMutation({
    mutationFn: async (change: LogoChange) => {
      if (change.kind === 'remove') {
        return api.removeGroupLogo(activeGroupId).then(() => ({ logoUrl: undefined }));
      }
      return api.uploadGroupLogo(activeGroupId, await prepareSquareImage(change.file, imageTransform));
    },
    onSuccess: ({ logoUrl }, change) => {
      queryClient.setQueryData<Session>(['session'], (session) => session ? {
        ...session,
        groups: session.groups.map((group) => group.id === activeGroupId ? { ...group, logoUrl } : group),
      } : session);
      setSelectedFile(undefined);
      setImageTransform(DEFAULT_IMAGE_TRANSFORM);
      setFileInputKey((current) => current + 1);
      setFileError('');
      setSuccessMessage(t(change.kind === 'upload' ? 'groupSettings.saved' : 'groupSettings.removed'));
    },
  });

  const selectFile = (file?: File) => {
    logoMutation.reset();
    setSuccessMessage('');
    if (!file) {
      setSelectedFile(undefined);
      setImageTransform(DEFAULT_IMAGE_TRANSFORM);
      setFileError('');
      return;
    }
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      setSelectedFile(undefined);
      setFileError(t('groupSettings.invalidType'));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setSelectedFile(undefined);
      setFileError(t('groupSettings.tooLarge'));
      return;
    }
    setFileError('');
    setSelectedFile(file);
    setImageTransform(DEFAULT_IMAGE_TRANSFORM);
  };

  const currentPreview = activeGroup.logoUrl || '/brand/teamtaler-mark.png';

  return (
    <div className={embedded ? styles.embedded : styles.content}>
      {!embedded ? <header className={styles.header}>
        <h2>{t('groupSettings.title')}</h2>
        <p>{t('groupSettings.intro')}</p>
      </header> : null}
      <div className={styles.cards}>
        <GroupNameForm currentName={activeGroup.name} embedded={embedded} groupId={activeGroupId} key={activeGroupId} />
        <section className={`${styles.card} ${styles.brandingCard}`}>
          {selectedFile ? (
            <ImageCropEditor
              alt={t('groupSettings.previewAlt', { group: activeGroup.name })}
              file={selectedFile}
              key={`${selectedFile.name}:${selectedFile.size}:${selectedFile.lastModified}`}
              onChange={setImageTransform}
              value={imageTransform}
            />
          ) : (
            <div className={styles.preview}>
              <img alt={t('groupSettings.previewAlt', { group: activeGroup.name })} src={currentPreview} />
            </div>
          )}
          <div className={styles.controls}>
            <div>
              {embedded ? <h4>{t('groupSettings.logoTitle')}</h4> : <h3>{t('groupSettings.logoTitle')}</h3>}
            </div>
            <Field error={fileError || undefined} hint={t('groupSettings.imageHint')} htmlFor="group-logo" label={t('groupSettings.imageLabel')}>
              <TextInput accept="image/jpeg,image/png,image/webp" id="group-logo" key={fileInputKey} onChange={(event) => selectFile(event.target.files?.[0])} type="file" />
            </Field>
            {logoMutation.isError ? <p className={styles.error} role="alert">{t('groupSettings.uploadError')} {logoMutation.error.message}</p> : null}
            {successMessage ? <p className={styles.success} role="status">{successMessage}</p> : null}
            <div className={styles.actions}>
              {activeGroup.logoUrl ? (
                <Button disabled={logoMutation.isPending} leadingIcon={<RotateCcw size={18} />} onClick={() => logoMutation.mutate({ kind: 'remove' })} variant="secondary">
                  {t('groupSettings.restoreDefault')}
                </Button>
              ) : null}
              <Button disabled={!selectedFile || logoMutation.isPending} leadingIcon={<ImageUp size={18} />} onClick={() => selectedFile && logoMutation.mutate({ kind: 'upload', file: selectedFile })}>
                {logoMutation.isPending ? t('groupSettings.saving') : t('groupSettings.save')}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
