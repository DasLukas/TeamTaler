import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import MailCheck from 'lucide-react/dist/esm/icons/mail-check';
import Plus from 'lucide-react/dist/esm/icons/plus';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import ShieldAlert from 'lucide-react/dist/esm/icons/shield-alert';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import { useDeferredValue, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type {
  ResettableSystemSettingKey,
  SystemGroup,
  SystemSetting,
  SystemSettings,
  SystemSettingsUpdate,
  SystemSmtpSettingsUpdate,
} from '@/api/types';
import { formatMediaUploadLimit } from '@/components/media/imageUpload';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput, TextInput } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { StatePanel } from '@/components/ui/StatePanel';
import { Toggle } from '@/components/ui/Toggle';
import styles from './SystemSettingsPanel.module.css';

const SETTINGS_QUERY_KEY = ['system-settings'] as const;
const GROUPS_QUERY_KEY = ['system-groups'] as const;
const AUDIT_QUERY_KEY = ['system-audit'] as const;
const PURGE_PHRASE = 'ENDGÜLTIG LÖSCHEN' as const;
const MEBIBYTE = 1024 * 1024;

function localizedDate(value: string | null): string {
  return value ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '–';
}

function sourceKey(source: SystemSetting<unknown>['source']): 'code' | 'environment' | 'database' {
  if (source === 'DATABASE') return 'database';
  if (source === 'ENVIRONMENT') return 'environment';
  return 'code';
}

interface SettingMetaProps {
  disabled?: boolean;
  onReset?: () => void;
  setting: Pick<SystemSetting<unknown>, 'source' | 'updatedAt'>;
}

/** Shows one setting's effective source, update time, and reset action. */
function SettingMeta({ disabled = false, onReset, setting }: SettingMetaProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.settingMeta}>
      <span>{t('systemSettings.source', { source: t(`systemSettings.sources.${sourceKey(setting.source)}`) })}</span>
      {setting.updatedAt ? <span>{t('systemSettings.updatedAt', { date: localizedDate(setting.updatedAt) })}</span> : null}
      {setting.source === 'DATABASE' && onReset ? (
        <Button disabled={disabled} leadingIcon={<RotateCcw size={15} />} onClick={onReset} size="small" variant="ghost">{t('systemSettings.reset')}</Button>
      ) : null}
    </div>
  );
}

function useSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ update, revision }: { update: SystemSettingsUpdate; revision: number }) => api.updateSystemSettings(update, revision),
    onSuccess: async (persisted) => {
      queryClient.setQueryData(SETTINGS_QUERY_KEY, persisted);
      await queryClient.invalidateQueries({ queryKey: ['instance-capabilities'] });
    },
    onError: async () => { await queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY }); },
  });
}

function useResetSettingMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, revision }: { key: ResettableSystemSettingKey; revision: number }) => api.resetSystemSetting(key, revision),
    onSuccess: async (persisted) => {
      queryClient.setQueryData(SETTINGS_QUERY_KEY, persisted);
      await queryClient.invalidateQueries({ queryKey: ['instance-capabilities'] });
    },
    onError: async () => { await queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY }); },
  });
}

/** General identity, currency, and media-limit settings. */
function GeneralSettingsSection({ settings }: { settings: SystemSettings }) {
  const { t } = useTranslation();
  const mutation = useSettingsMutation();
  const resetMutation = useResetSettingMutation();
  const [instanceName, setInstanceName] = useState(settings.instanceName.value);
  const [defaultCurrency, setDefaultCurrency] = useState(settings.defaultCurrency.value);
  const [mediaLimitMiB, setMediaLimitMiB] = useState(settings.mediaUploadMaxBytes.value / MEBIBYTE);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const mediaUploadMaxBytes = Math.round(mediaLimitMiB * MEBIBYTE);
    mutation.mutate({
      revision: settings.revision,
      update: {
        ...(instanceName.trim() !== settings.instanceName.value ? { instanceName: instanceName.trim() } : {}),
        ...(defaultCurrency !== settings.defaultCurrency.value ? { defaultCurrency } : {}),
        ...(mediaUploadMaxBytes !== settings.mediaUploadMaxBytes.value ? { mediaUploadMaxBytes } : {}),
      },
    });
  };
  const changed = instanceName.trim() !== settings.instanceName.value
    || defaultCurrency !== settings.defaultCurrency.value
    || Math.round(mediaLimitMiB * MEBIBYTE) !== settings.mediaUploadMaxBytes.value;
  const pending = mutation.isPending || resetMutation.isPending;
  const maximumMediaLimitMiB = Math.min(25, settings.mediaUploadHardLimitBytes > 0 ? settings.mediaUploadHardLimitBytes / MEBIBYTE : 25);
  const reset = (key: ResettableSystemSettingKey) => resetMutation.mutate({ key, revision: settings.revision });
  return (
    <section aria-labelledby="system-general-title" className={styles.section}>
      <header><h3 id="system-general-title">{t('systemSettings.general.title')}</h3><p>{t('systemSettings.general.intro')}</p></header>
      <form className={styles.form} onSubmit={submit}>
        <div className={styles.fieldBlock}>
          <Field htmlFor="system-instance-name" label={t('systemSettings.general.instanceName')}><TextInput id="system-instance-name" maxLength={120} onChange={(event) => setInstanceName(event.target.value)} required value={instanceName} /></Field>
          <SettingMeta disabled={pending} onReset={() => reset('instanceName')} setting={settings.instanceName} />
        </div>
        <div className={styles.fieldBlock}>
          <Field htmlFor="system-default-currency" label={t('systemSettings.general.defaultCurrency')}><TextInput id="system-default-currency" maxLength={3} minLength={3} onChange={(event) => setDefaultCurrency(event.target.value.toUpperCase())} pattern="[A-Z]{3}" required value={defaultCurrency} /></Field>
          <SettingMeta disabled={pending} onReset={() => reset('defaultCurrency')} setting={settings.defaultCurrency} />
        </div>
        <div className={styles.fieldBlock}>
          <Field hint={t('systemSettings.general.mediaLimitHint', { hardLimit: settings.mediaUploadHardLimitBytes > 0 ? formatMediaUploadLimit(settings.mediaUploadHardLimitBytes) : t('systemSettings.general.hostLimitUnknown') })} htmlFor="system-media-limit" label={t('systemSettings.general.mediaLimit')}>
            <TextInput id="system-media-limit" max={maximumMediaLimitMiB} min={0.25} onChange={(event) => setMediaLimitMiB(event.target.valueAsNumber)} required step={0.25} type="number" value={mediaLimitMiB} />
          </Field>
          <SettingMeta disabled={pending} onReset={() => reset('mediaUploadMaxBytes')} setting={settings.mediaUploadMaxBytes} />
        </div>
        {mutation.isError || resetMutation.isError ? <p className={styles.error} role="alert">{t('systemSettings.saveError')}</p> : null}
        {mutation.isSuccess || resetMutation.isSuccess ? <p className={styles.success} role="status">{t('systemSettings.saved')}</p> : null}
        <div className={styles.actions}><Button disabled={!changed || pending || !instanceName.trim() || !/^[A-Z]{3}$/.test(defaultCurrency) || !Number.isFinite(mediaLimitMiB) || mediaLimitMiB < 0.25 || mediaLimitMiB > maximumMediaLimitMiB} type="submit">{pending ? t('common.saving') : t('common.save')}</Button></div>
      </form>
    </section>
  );
}

/** SMTP configuration, verification, activation, and reset controls. */
function SmtpSettingsSection({ settings }: { settings: SystemSettings }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const smtp = settings.smtp;
  type SMTPForm = Required<Omit<SystemSmtpSettingsUpdate, 'password'>>;
  const [form, setForm] = useState<SMTPForm>({
    enabled: smtp.enabled.value,
    host: smtp.host.value,
    port: smtp.port.value,
    tlsMode: smtp.tlsMode.value,
    username: smtp.username.value,
    fromAddress: smtp.fromAddress.value,
    fromName: smtp.fromName.value,
  });
  const [password, setPassword] = useState('');
  const synchronize = async (persisted?: SystemSettings) => {
    if (persisted) queryClient.setQueryData(SETTINGS_QUERY_KEY, persisted);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ['instance-capabilities'] }),
    ]);
  };
  const saveMutation = useMutation({
    mutationFn: () => api.updateSystemSmtp({
      ...(form.enabled !== smtp.enabled.value ? { enabled: form.enabled } : {}),
      ...(form.host !== smtp.host.value ? { host: form.host } : {}),
      ...(form.port !== smtp.port.value ? { port: form.port } : {}),
      ...(form.tlsMode !== smtp.tlsMode.value ? { tlsMode: form.tlsMode } : {}),
      ...(form.username !== smtp.username.value ? { username: form.username } : {}),
      ...(form.fromAddress !== smtp.fromAddress.value ? { fromAddress: form.fromAddress } : {}),
      ...(form.fromName !== smtp.fromName.value ? { fromName: form.fromName } : {}),
      ...(password ? { password } : {}),
    }, settings.revision),
    onSuccess: async (persisted) => { setPassword(''); await synchronize(persisted); },
    onError: async () => { await synchronize(); },
  });
  const testMutation = useMutation({
    mutationFn: () => api.testSystemSmtp(settings.revision),
    onSuccess: async (persisted) => { await synchronize(persisted); },
    onError: async () => { await synchronize(); },
  });
  const resetMutation = useMutation({
    mutationFn: () => api.resetSystemSmtp(settings.revision),
    onSuccess: async (persisted) => { setPassword(''); await synchronize(persisted); },
    onError: async () => { await synchronize(); },
  });
  const pending = saveMutation.isPending || testMutation.isPending || resetMutation.isPending;
  const configurationChanged = form.enabled !== smtp.enabled.value
    || form.host !== smtp.host.value
    || form.port !== smtp.port.value
    || form.tlsMode !== smtp.tlsMode.value
    || form.username !== smtp.username.value
    || form.fromAddress !== smtp.fromAddress.value
    || form.fromName !== smtp.fromName.value
    || password.length > 0;
  const setValue = <K extends keyof SMTPForm>(key: K, value: SMTPForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  return (
    <section aria-labelledby="system-smtp-title" className={styles.section}>
      <header><h3 id="system-smtp-title">{t('systemSettings.smtp.title')}</h3><p>{t('systemSettings.smtp.intro')}</p></header>
      <form className={styles.form} onSubmit={(event) => { event.preventDefault(); saveMutation.mutate(); }}>
        <div className={styles.fieldBlock}><div className={styles.toggleRow}><div><strong>{t('systemSettings.smtp.enabled')}</strong><span>{t('systemSettings.smtp.enabledHint')}</span></div><Toggle checked={form.enabled} disabled={pending || !smtp.enabled.value && smtp.testStatus !== 'VERIFIED'} label={t('systemSettings.smtp.enabled')} onChange={(value) => setValue('enabled', value)} /></div><SettingMeta setting={smtp.enabled} /></div>
        <div className={styles.gridTwo}>
          <div className={styles.fieldBlock}><Field htmlFor="system-smtp-host" label={t('systemSettings.smtp.host')}><TextInput id="system-smtp-host" onChange={(event) => setValue('host', event.target.value)} required value={form.host} /></Field><SettingMeta setting={smtp.host} /></div>
          <div className={styles.fieldBlock}><Field htmlFor="system-smtp-port" label={t('systemSettings.smtp.port')}><TextInput id="system-smtp-port" max={65535} min={1} onChange={(event) => setValue('port', event.target.valueAsNumber)} required type="number" value={form.port} /></Field><SettingMeta setting={smtp.port} /></div>
          <div className={styles.fieldBlock}><Field htmlFor="system-smtp-tls" label={t('systemSettings.smtp.tlsMode')}><SelectInput id="system-smtp-tls" onChange={(event) => setValue('tlsMode', event.target.value as SMTPForm['tlsMode'])} value={form.tlsMode}><option value="starttls">STARTTLS</option><option value="tls">TLS</option></SelectInput></Field><SettingMeta setting={smtp.tlsMode} /></div>
          <div className={styles.fieldBlock}><Field htmlFor="system-smtp-username" label={t('systemSettings.smtp.username')}><TextInput autoComplete="username" id="system-smtp-username" onChange={(event) => setValue('username', event.target.value)} value={form.username} /></Field><SettingMeta setting={smtp.username} /></div>
          <div className={styles.fieldBlock}><Field hint={smtp.passwordConfigured ? t('systemSettings.smtp.passwordPreserved') : t('systemSettings.smtp.passwordMissing')} htmlFor="system-smtp-password" label={t('systemSettings.smtp.password')}><TextInput autoComplete="new-password" id="system-smtp-password" onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></Field><SettingMeta setting={{ source: smtp.passwordSource, updatedAt: smtp.passwordUpdatedAt }} /></div>
          <div className={styles.fieldBlock}><Field htmlFor="system-smtp-from-address" label={t('systemSettings.smtp.fromAddress')}><TextInput id="system-smtp-from-address" onChange={(event) => setValue('fromAddress', event.target.value)} required type="email" value={form.fromAddress} /></Field><SettingMeta setting={smtp.fromAddress} /></div>
          <div className={styles.fieldBlock}><Field htmlFor="system-smtp-from-name" label={t('systemSettings.smtp.fromName')}><TextInput id="system-smtp-from-name" onChange={(event) => setValue('fromName', event.target.value)} value={form.fromName} /></Field><SettingMeta setting={smtp.fromName} /></div>
        </div>
        <div className={styles.smtpStatus} data-status={smtp.testStatus.toLowerCase()}><strong>{t(`systemSettings.smtp.status.${smtp.testStatus.toLowerCase()}`)}</strong><span>{smtp.testedAt ? t('systemSettings.smtp.testedAt', { date: localizedDate(smtp.testedAt) }) : t('systemSettings.smtp.notTested')}</span></div>
        {saveMutation.isError || testMutation.isError || resetMutation.isError ? <p className={styles.error} role="alert">{t('systemSettings.smtp.error')}</p> : null}
        <div className={styles.actions}>
          <Button disabled={pending} onClick={() => resetMutation.mutate()} variant="ghost">{t('systemSettings.smtp.reset')}</Button>
          <Button disabled={pending || configurationChanged || !smtp.configurationValid} leadingIcon={<MailCheck size={17} />} onClick={() => testMutation.mutate()} variant="secondary">{testMutation.isPending ? t('systemSettings.smtp.testing') : t('systemSettings.smtp.test')}</Button>
          <Button disabled={pending || !configurationChanged || !form.host || !form.username || !form.fromAddress || !Number.isFinite(form.port)} type="submit">{saveMutation.isPending ? t('common.saving') : t('common.save')}</Button>
        </div>
      </form>
    </section>
  );
}

/** Global public-join and maintenance controls plus CLI-managed administrators. */
function AccessSettingsSection({ settings }: { settings: SystemSettings }) {
  const { t } = useTranslation();
  const mutation = useSettingsMutation();
  const resetMutation = useResetSettingMutation();
  const [publicJoinEnabled, setPublicJoinEnabled] = useState(settings.publicJoinEnabled.value);
  const [maintenanceMode, setMaintenanceMode] = useState(settings.maintenanceMode.value);
  const [maintenanceMessage, setMaintenanceMessage] = useState(settings.maintenanceMessage.value);
  const administrators = useQuery({ queryKey: ['system-administrators'], queryFn: api.getSystemAdministrators });
  const pending = mutation.isPending || resetMutation.isPending;
  const reset = (key: ResettableSystemSettingKey) => resetMutation.mutate({ key, revision: settings.revision });
  return (
    <section aria-labelledby="system-access-title" className={styles.section}>
      <header><h3 id="system-access-title">{t('systemSettings.access.title')}</h3><p>{t('systemSettings.access.intro')}</p></header>
      <div className={styles.form}>
        <div className={styles.fieldBlock}><div className={styles.toggleRow}><div><strong>{t('systemSettings.access.publicJoin')}</strong><span>{t('systemSettings.access.publicJoinHint')}</span></div><Toggle checked={publicJoinEnabled} disabled={pending} label={t('systemSettings.access.publicJoin')} onChange={setPublicJoinEnabled} /></div><SettingMeta disabled={pending} onReset={() => reset('publicJoinEnabled')} setting={settings.publicJoinEnabled} /></div>
        <div className={styles.fieldBlock}><div className={styles.toggleRow}><div><strong>{t('systemSettings.access.maintenance')}</strong><span>{t('systemSettings.access.maintenanceHint')}</span></div><Toggle checked={maintenanceMode} disabled={pending} label={t('systemSettings.access.maintenance')} onChange={setMaintenanceMode} /></div><SettingMeta disabled={pending} onReset={() => reset('maintenanceMode')} setting={settings.maintenanceMode} /></div>
        <div className={styles.fieldBlock}><Field htmlFor="system-maintenance-message" label={t('systemSettings.access.maintenanceMessage')}><TextInput id="system-maintenance-message" maxLength={240} onChange={(event) => setMaintenanceMessage(event.target.value)} value={maintenanceMessage} /></Field><SettingMeta disabled={pending} onReset={() => reset('maintenanceMessage')} setting={settings.maintenanceMessage} /></div>
        {mutation.isError || resetMutation.isError ? <p className={styles.error} role="alert">{t('systemSettings.saveError')}</p> : null}
        <div className={styles.actions}><Button disabled={pending || publicJoinEnabled === settings.publicJoinEnabled.value && maintenanceMode === settings.maintenanceMode.value && maintenanceMessage === settings.maintenanceMessage.value} onClick={() => mutation.mutate({ revision: settings.revision, update: {
          ...(publicJoinEnabled !== settings.publicJoinEnabled.value ? { publicJoinEnabled } : {}),
          ...(maintenanceMode !== settings.maintenanceMode.value ? { maintenanceMode } : {}),
          ...(maintenanceMessage !== settings.maintenanceMessage.value ? { maintenanceMessage } : {}),
        } })}>{mutation.isPending ? t('common.saving') : t('common.save')}</Button></div>
      </div>
      <div className={styles.subsection}><h4>{t('systemSettings.access.administrators')}</h4><p>{t('systemSettings.access.cliOnly')}</p>{administrators.data ? <ul className={styles.adminList}>{administrators.data.map((account) => <li key={account.id}><strong>{account.displayName}</strong><span>{account.email}</span></li>)}</ul> : <p>{t(administrators.isError ? 'systemSettings.access.administratorsError' : 'common.loading')}</p>}</div>
    </section>
  );
}

interface PurgeDialogProps {
  group: SystemGroup | null;
  onClose: () => void;
  onPurged: () => Promise<void>;
}

/** Password step-up and typed destructive confirmation for permanent group deletion. */
function PurgeDialog({ group, onClose, onPurged }: PurgeDialogProps) {
  const { t } = useTranslation();
  const impact = useQuery({
    queryKey: ['system-group-deletion-impact', group?.id],
    queryFn: () => api.getSystemGroupDeletionImpact(group?.id ?? ''),
    enabled: group !== null,
  });
  const [password, setPassword] = useState('');
  const [groupName, setGroupName] = useState('');
  const [phrase, setPhrase] = useState('');
  const clearConfirmation = () => {
    setPassword('');
    setGroupName('');
    setPhrase('');
  };
  const close = () => {
    clearConfirmation();
    onClose();
  };
  const mutation = useMutation({
    mutationFn: async () => {
      if (!group) return;
      const submittedGroupName = groupName;
      const challenge = await api.createSystemStepUp(password).finally(clearConfirmation);
      await api.purgeSystemGroup(group.id, impact.data?.version ?? group.version, { stepUpToken: challenge.stepUpToken, groupName: submittedGroupName, confirmationPhrase: PURGE_PHRASE });
    },
    onSuccess: async () => { await onPurged(); close(); },
  });
  const currentGroupName = impact.data?.groupName ?? group?.name;
  const impactCounts = impact.data ? {
    members: impact.data.members,
    invitations: impact.data.invitations,
    bookings: impact.data.bookings,
    financialRecords: impact.data.financialRecords,
    auditEntries: impact.data.auditEntries,
    mediaFiles: impact.data.mediaFiles,
  } : group?.impact;
  const valid = Boolean(group) && password.length > 0 && groupName === currentGroupName && phrase === PURGE_PHRASE;
  return (
    <Modal onClose={() => { if (!mutation.isPending) close(); }} open={group !== null} title={t('systemSettings.groups.purgeTitle')} variant="sheet">
      {group ? <form className={styles.purgeForm} onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
        <div className={styles.dangerNotice}><ShieldAlert aria-hidden="true" size={25} /><div><strong>{t('systemSettings.groups.purgeWarning')}</strong><p>{t('systemSettings.groups.purgeDescription')}</p></div></div>
        {impact.isError ? <p className={styles.error} role="alert">{t('systemSettings.groups.impactError')}</p> : null}
        <dl className={styles.impact}>{Object.entries(impactCounts ?? {}).map(([key, value]) => <div key={key}><dt>{t(`systemSettings.groups.impact.${key as keyof SystemGroup['impact']}`)}</dt><dd>{value}</dd></div>)}</dl>
        <Field htmlFor="system-purge-password" label={t('systemSettings.groups.currentPassword')}><TextInput autoComplete="current-password" id="system-purge-password" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></Field>
        <Field hint={currentGroupName} htmlFor="system-purge-name" label={t('systemSettings.groups.confirmName')}><TextInput autoComplete="off" id="system-purge-name" onChange={(event) => setGroupName(event.target.value)} required value={groupName} /></Field>
        <Field hint={PURGE_PHRASE} htmlFor="system-purge-phrase" label={t('systemSettings.groups.confirmPhrase')}><TextInput autoComplete="off" id="system-purge-phrase" onChange={(event) => setPhrase(event.target.value)} required value={phrase} /></Field>
        {mutation.isError ? <p className={styles.error} role="alert">{t('systemSettings.groups.purgeError')}</p> : null}
        <div className={styles.actions}><Button disabled={mutation.isPending} onClick={close} variant="secondary">{t('common.cancel')}</Button><Button disabled={!valid || mutation.isPending || impact.isLoading || impact.isError} leadingIcon={<Trash2 size={17} />} type="submit" variant="danger">{mutation.isPending ? t('systemSettings.groups.purging') : t('systemSettings.groups.purge')}</Button></div>
      </form> : null}
    </Modal>
  );
}

/** Group creation, provisioning, archival, restoration, and purge management. */
function GroupsSettingsSection({ defaultCurrency }: { defaultCurrency: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const groups = useQuery({ queryKey: GROUPS_QUERY_KEY, queryFn: api.getSystemGroups });
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [administratorEmail, setAdministratorEmail] = useState('');
  const deferredEmail = useDeferredValue(administratorEmail.trim());
  const accounts = useQuery({ queryKey: ['system-accounts', deferredEmail], queryFn: () => api.searchSystemAccounts(deferredEmail), enabled: deferredEmail.length >= 2 });
  const [purgeGroup, setPurgeGroup] = useState<SystemGroup | null>(null);
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: GROUPS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: AUDIT_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ['session'] }),
    ]);
  };
  const createMutation = useMutation({ mutationFn: api.createSystemGroup, onSuccess: async () => { setName(''); setAdministratorEmail(''); await refresh(); } });
  const lifecycleMutation = useMutation({
    mutationFn: ({ action, group }: { action: 'archive' | 'restore'; group: SystemGroup }) => {
      if (action === 'restore') return api.restoreSystemGroup(group.id, group.version);
      return api.archiveSystemGroup(group.id, group.version);
    },
    onSuccess: refresh,
    onError: refresh,
  });
  const resendMutation = useMutation({
    mutationFn: (group: SystemGroup) => api.resendSystemGroupInvitation(group.id, group.version),
    onSuccess: async (persisted) => {
      queryClient.setQueryData<SystemGroup[]>(GROUPS_QUERY_KEY, (current) => current?.map((group) => group.id === persisted.id ? persisted : group));
      await refresh();
    },
    onError: refresh,
  });
  if (groups.isLoading) return <section aria-labelledby="system-groups-title" className={styles.section}><header><h3 id="system-groups-title">{t('systemSettings.groups.title')}</h3></header><StatePanel kind="loading" /></section>;
  return (
    <section aria-labelledby="system-groups-title" className={styles.section}>
      <header><h3 id="system-groups-title">{t('systemSettings.groups.title')}</h3><p>{t('systemSettings.groups.intro')}</p></header>
      <form className={styles.createGroup} onSubmit={(event) => { event.preventDefault(); createMutation.mutate({ name: name.trim(), currency, administratorEmail: administratorEmail.trim() }); }}>
        <Field htmlFor="system-group-name" label={t('systemSettings.groups.name')}><TextInput id="system-group-name" maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} /></Field>
        <Field htmlFor="system-group-currency" label={t('systemSettings.groups.currency')}><TextInput id="system-group-currency" maxLength={3} minLength={3} onChange={(event) => setCurrency(event.target.value.toUpperCase())} pattern="[A-Z]{3}" required value={currency} /></Field>
        <Field hint={t('systemSettings.groups.administratorHint')} htmlFor="system-group-administrator" label={t('systemSettings.groups.administratorEmail')}><TextInput autoComplete="email" id="system-group-administrator" list="system-account-suggestions" onChange={(event) => setAdministratorEmail(event.target.value)} required type="email" value={administratorEmail} /><datalist id="system-account-suggestions">{accounts.data?.map((account) => <option key={account.id} value={account.email}>{account.displayName}</option>)}</datalist></Field>
        <Button disabled={createMutation.isPending || !name.trim() || !administratorEmail.trim() || !/^[A-Z]{3}$/.test(currency)} leadingIcon={<Plus size={17} />} type="submit">{createMutation.isPending ? t('systemSettings.groups.creating') : t('systemSettings.groups.create')}</Button>
      </form>
      {createMutation.isError || lifecycleMutation.isError || groups.isError ? <p className={styles.error} role="alert">{t('systemSettings.groups.error')}</p> : null}
      {resendMutation.isError ? <p className={styles.error} role="alert">{t('systemSettings.groups.resendError')}</p> : null}
      <div className={styles.groupList}>
        {groups.data?.map((group) => (
          <article className={styles.groupCard} key={group.id}>
            <div><h4>{group.name}</h4><p>{group.currency} · {t(`systemSettings.groups.status.${group.status.toLowerCase()}`)}{group.administratorEmail ? ` · ${group.administratorEmail}` : ''}</p></div>
            <dl className={styles.compactImpact}><div><dt>{t('systemSettings.groups.impact.members')}</dt><dd>{group.impact.members}</dd></div><div><dt>{t('systemSettings.groups.impact.bookings')}</dt><dd>{group.impact.bookings}</dd></div><div><dt>{t('systemSettings.groups.impact.mediaFiles')}</dt><dd>{group.impact.mediaFiles}</dd></div></dl>
            <div className={styles.groupActions}>
              {group.status === 'PROVISIONING' ? <Button disabled={resendMutation.isPending || lifecycleMutation.isPending} onClick={() => resendMutation.mutate(group)} size="small" variant="secondary">{resendMutation.isPending && resendMutation.variables?.id === group.id ? t('systemSettings.groups.resending') : t('systemSettings.groups.resend')}</Button> : null}
              {group.status === 'ARCHIVED' ? <Button disabled={lifecycleMutation.isPending} onClick={() => lifecycleMutation.mutate({ action: 'restore', group })} size="small" variant="secondary">{t('systemSettings.groups.restore')}</Button> : <Button disabled={lifecycleMutation.isPending} onClick={() => { if (window.confirm(t('systemSettings.groups.archiveConfirm', { name: group.name }))) lifecycleMutation.mutate({ action: 'archive', group }); }} size="small" variant="secondary">{t('systemSettings.groups.archive')}</Button>}
              {group.status === 'ARCHIVED' ? <Button leadingIcon={<Trash2 size={15} />} onClick={() => setPurgeGroup(group)} size="small" variant="danger">{t('systemSettings.groups.deletePermanently')}</Button> : null}
            </div>
          </article>
        ))}
        {groups.data?.length === 0 ? <StatePanel kind="empty" message={t('systemSettings.groups.empty')} /> : null}
      </div>
      <PurgeDialog group={purgeGroup} key={purgeGroup?.id ?? 'closed'} onClose={() => setPurgeGroup(null)} onPurged={refresh} />
    </section>
  );
}

/** Immutable global activity feed including retained purge receipts. */
function SystemAuditSection() {
  const { t } = useTranslation();
  const audit = useQuery({ queryKey: AUDIT_QUERY_KEY, queryFn: api.getSystemAudit });
  return (
    <section aria-labelledby="system-audit-title" className={styles.section}>
      <header><h3 id="system-audit-title">{t('systemSettings.audit.title')}</h3><p>{t('systemSettings.audit.intro')}</p></header>
      {audit.isLoading ? <StatePanel kind="loading" /> : audit.isError ? <StatePanel kind="error" message={t('systemSettings.audit.error')} /> : audit.data?.length === 0 ? <StatePanel kind="empty" message={t('systemSettings.audit.empty')} /> : (
        <div className={styles.auditList}>{audit.data?.map((entry) => <article key={entry.id}><time dateTime={entry.createdAt}>{localizedDate(entry.createdAt)}</time><div><strong>{entry.action}</strong><p>{entry.summary}</p><small>{entry.actorDisplayName}</small></div></article>)}</div>
      )}
    </section>
  );
}

/**
 * Loads and renders all global instance-administration settings.
 *
 * @returns General, SMTP, access, group lifecycle, and audit sections.
 */
export function SystemSettingsPanel() {
  const { t } = useTranslation();
  const settings = useQuery({ queryKey: SETTINGS_QUERY_KEY, queryFn: api.getSystemSettings });
  if (settings.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (settings.isError || !settings.data) return <div className={styles.state}><StatePanel actionLabel={t('common.retry')} kind="error" message={t('systemSettings.loadError')} onAction={() => void settings.refetch()} /></div>;
  return (
    <div className={styles.content}>
      <GeneralSettingsSection key={`general-${settings.data.revision}`} settings={settings.data} />
      <SmtpSettingsSection key={`smtp-${settings.data.revision}`} settings={settings.data} />
      <AccessSettingsSection key={`access-${settings.data.revision}`} settings={settings.data} />
      <GroupsSettingsSection defaultCurrency={settings.data.defaultCurrency.value} key={`groups-${settings.data.revision}`} />
      <SystemAuditSection />
    </div>
  );
}
