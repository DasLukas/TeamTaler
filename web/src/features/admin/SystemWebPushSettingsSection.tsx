import { useMutation, useQueryClient } from '@tanstack/react-query';
import BellRing from 'lucide-react/dist/esm/icons/bell-ring';
import CircleCheck from 'lucide-react/dist/esm/icons/circle-check';
import KeyRound from 'lucide-react/dist/esm/icons/key-round';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import Save from 'lucide-react/dist/esm/icons/save';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { SystemSettings } from '@/api/types';
import { useSession } from '@/app/useSession';
import { Button } from '@/components/ui/Button';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { Field, TextInput } from '@/components/ui/FormField';
import { Toggle } from '@/components/ui/Toggle';
import { currentWebPushDeviceId } from '@/features/push/webPush';
import styles from './SystemSettingsPanel.module.css';

const SETTINGS_QUERY_KEY = ['system-settings'] as const;
const VAPID_SUBJECT_PATTERN = /^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/i;

/**
 * Renders redacted Web Push configuration, key rotation, test, and reset controls.
 *
 * @param props - Current versioned system-settings document.
 * @returns An accessible system-administration section.
 */
export function SystemWebPushSettingsSection({ settings }: { settings: SystemSettings }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const session = useSession();
  const webPush = settings.webPush;
  const currentDeviceId = currentWebPushDeviceId(session.user.id);
  const [enabled, setEnabled] = useState(webPush.enabled.value);
  const [subject, setSubject] = useState(webPush.subject.value);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const synchronize = async (persisted?: SystemSettings) => {
    if (persisted) queryClient.setQueryData(SETTINGS_QUERY_KEY, persisted);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ['instance-capabilities'] }),
      queryClient.invalidateQueries({ queryKey: ['push-subscriptions'] }),
    ]);
  };
  const save = useMutation({
    mutationFn: () => api.updateSystemWebPush({
      ...(enabled !== webPush.enabled.value ? { enabled } : {}),
      ...(subject.trim() !== webPush.subject.value ? { subject: subject.trim() } : {}),
    }, settings.revision),
    onSuccess: synchronize,
    onError: () => synchronize(),
  });
  const generate = useMutation({
    mutationFn: () => api.generateSystemWebPushKey(settings.revision),
    onSuccess: async (persisted) => { setGenerateOpen(false); await synchronize(persisted); },
    onError: () => synchronize(),
  });
  const reset = useMutation({
    mutationFn: () => api.resetSystemWebPush(settings.revision),
    onSuccess: async (persisted) => { setResetOpen(false); await synchronize(persisted); },
    onError: () => synchronize(),
  });
  const test = useMutation({
    mutationFn: () => api.testSystemWebPush(settings.revision, currentDeviceId ?? undefined),
    onSuccess: synchronize,
    onError: () => synchronize(),
  });
  const changed = enabled !== webPush.enabled.value || subject.trim() !== webPush.subject.value;
  const subjectChanged = subject.trim() !== webPush.subject.value;
  const pending = save.isPending || generate.isPending || reset.isPending || test.isPending;
  const validSubject = VAPID_SUBJECT_PATTERN.test(subject.trim());
  const canEnable = webPush.privateKeyConfigured && webPush.storageKeyConfigured;
  const canTest = webPush.configurationValid && webPush.active && Boolean(currentDeviceId);
  const submit = (event: FormEvent) => { event.preventDefault(); save.mutate(); };
  return <section aria-labelledby="system-web-push-title" className={styles.section}>
    <header><h3 id="system-web-push-title">{t('systemSettings.webPush.title')}</h3><p>{t('systemSettings.webPush.intro')}</p></header>
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.fieldBlock}><div className={styles.toggleRow}><div><strong>{t('systemSettings.webPush.enabled')}</strong><span>{t('systemSettings.webPush.enabledHint')}</span></div><Toggle checked={enabled} disabled={pending || !enabled && !canEnable} label={t('systemSettings.webPush.enabled')} onChange={setEnabled} /></div></div>
      <div className={styles.fieldBlock}><Field hint={t('systemSettings.webPush.subjectHint')} htmlFor="system-web-push-subject" label={t('systemSettings.webPush.subject')}><TextInput id="system-web-push-subject" onChange={(event) => setSubject(event.target.value)} placeholder="mailto:admin@example.com" required value={subject} /></Field></div>
      <dl className={styles.compactImpact}>
        <div><dt>{t('systemSettings.webPush.key')}:</dt><dd>{webPush.privateKeyConfigured ? t('systemSettings.webPush.configured') : t('systemSettings.webPush.missing')}</dd></div>
        <div><dt>{t('systemSettings.webPush.keyId')}:</dt><dd>{webPush.keyId ?? '–'}</dd></div>
        <div><dt>{t('common.status')}:</dt><dd>{webPush.active ? <CircleCheck aria-label={t('systemSettings.webPush.active')} className={styles.activeStatus} role="img" size={20} /> : webPush.configurationValid ? t('systemSettings.webPush.ready') : t('systemSettings.webPush.incomplete')}</dd></div>
      </dl>
      {save.isError || generate.isError || reset.isError || test.isError ? <p className={styles.error} role="alert">{t('systemSettings.webPush.error')}</p> : null}
      {save.isSuccess || generate.isSuccess || reset.isSuccess || test.isSuccess ? <p className={styles.success} role="status">{test.isSuccess ? t('systemSettings.webPush.testQueued') : t('systemSettings.saved')}</p> : null}
      <div className={styles.actions}>
        <Button disabled={pending || !canTest} leadingIcon={<BellRing size={17} />} onClick={() => test.mutate()} variant="secondary">{test.isPending ? t('systemSettings.webPush.testing') : t('systemSettings.webPush.test')}</Button>
        <Button disabled={pending || !webPush.storageKeyConfigured} leadingIcon={<KeyRound size={17} />} onClick={() => setGenerateOpen(true)} variant="secondary">{webPush.privateKeyConfigured ? t('systemSettings.webPush.rotateKey') : t('systemSettings.webPush.generateKey')}</Button>
        <Button disabled={pending || !webPush.privateKeyConfigured && webPush.enabled.source !== 'DATABASE' && webPush.subject.source !== 'DATABASE'} leadingIcon={<RotateCcw size={17} />} onClick={() => setResetOpen(true)} variant="secondary">{t('systemSettings.reset')}</Button>
        <Button disabled={pending || !changed || !validSubject && (subjectChanged || enabled) || enabled && !canEnable} leadingIcon={<Save size={17} />} type="submit">{save.isPending ? t('common.saving') : t('common.save')}</Button>
      </div>
    </form>
    <ConfirmationDialog confirmIcon={<KeyRound size={17} />} confirmLabel={generate.isPending ? t('systemSettings.webPush.generatingKey') : webPush.privateKeyConfigured ? t('systemSettings.webPush.rotateKey') : t('systemSettings.webPush.generateKey')} errorMessage={generate.isError ? t('systemSettings.webPush.error') : undefined} message={t(webPush.privateKeyConfigured ? 'systemSettings.webPush.rotateWarning' : 'systemSettings.webPush.generateWarning')} onClose={() => setGenerateOpen(false)} onConfirm={() => generate.mutate()} open={generateOpen} pending={generate.isPending} title={t(webPush.privateKeyConfigured ? 'systemSettings.webPush.rotateTitle' : 'systemSettings.webPush.generateTitle')} />
    <ConfirmationDialog confirmIcon={<RotateCcw size={17} />} confirmLabel={reset.isPending ? t('systemSettings.resetting') : t('systemSettings.reset')} errorMessage={reset.isError ? t('systemSettings.webPush.error') : undefined} message={t('systemSettings.webPush.resetWarning')} onClose={() => setResetOpen(false)} onConfirm={() => reset.mutate()} open={resetOpen} pending={reset.isPending} title={t('systemSettings.webPush.resetTitle')} />
  </section>;
}
