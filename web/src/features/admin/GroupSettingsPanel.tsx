import { useMutation, useQueryClient } from '@tanstack/react-query';
import ImageUp from 'lucide-react/dist/esm/icons/image-up';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { Session } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import styles from './GroupSettingsPanel.module.css';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type LogoChange = { kind: 'upload'; file: File } | { kind: 'remove' };

/**
 * Renders administrator-only group branding controls.
 *
 * Only server-validated, normalized images are rendered. Successful mutations
 * update the shared session cache so every active brand surface changes without
 * a page reload.
 *
 * @returns A group-logo preview, validated file input, and update actions.
 */
export function GroupSettingsPanel() {
  const { t } = useTranslation();
  const { activeGroup, activeGroupId } = useActiveGroup();
  const queryClient = useQueryClient();
  const [selectedFile, setSelectedFile] = useState<File>();
  const [fileInputKey, setFileInputKey] = useState(0);
  const [fileError, setFileError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const logoMutation = useMutation({
    mutationFn: async (change: LogoChange) => change.kind === 'upload'
      ? api.uploadGroupLogo(activeGroupId, change.file)
      : api.removeGroupLogo(activeGroupId).then(() => ({ logoUrl: undefined })),
    onSuccess: ({ logoUrl }, change) => {
      queryClient.setQueryData<Session>(['session'], (session) => session ? {
        ...session,
        groups: session.groups.map((group) => group.id === activeGroupId ? { ...group, logoUrl } : group),
      } : session);
      setSelectedFile(undefined);
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
  };

  const currentPreview = activeGroup.logoUrl || '/brand/teamtaler-mark.png';

  return (
    <div className={styles.content}>
      <header className={styles.header}>
        <h2>{t('groupSettings.title')}</h2>
        <p>{t('groupSettings.intro')}</p>
      </header>
      <section className={styles.card}>
        <div className={styles.preview}>
          <img alt={t('groupSettings.previewAlt', { group: activeGroup.name })} src={currentPreview} />
        </div>
        <div className={styles.controls}>
          <div>
            <h3>{t('groupSettings.logoTitle')}</h3>
            <p>{t('groupSettings.logoDescription')}</p>
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
  );
}
