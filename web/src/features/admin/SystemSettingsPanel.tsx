import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Archive from 'lucide-react/dist/esm/icons/archive';
import ArchiveRestore from 'lucide-react/dist/esm/icons/archive-restore';
import CircleCheckBig from 'lucide-react/dist/esm/icons/circle-check-big';
import MailCheck from 'lucide-react/dist/esm/icons/mail-check';
import Plus from 'lucide-react/dist/esm/icons/plus';
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import Save from 'lucide-react/dist/esm/icons/save';
import ShieldAlert from 'lucide-react/dist/esm/icons/shield-alert';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import X from 'lucide-react/dist/esm/icons/x';
import { useDeferredValue, useId, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney } from '@/api/money';
import type {
  CollectionPage,
  ResettableSystemSettingKey,
  SystemAuditCollectionQuery,
  SystemAuditEntry,
  SystemGroup,
  SystemGroupInvitationResult,
  SystemSettings,
  SystemSettingsUpdate,
  SystemSmtpSettingsUpdate,
} from '@/api/types';
import { Button } from '@/components/ui/Button';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { Field, SelectInput, TextInput } from '@/components/ui/FormField';
import { GroupMark } from '@/components/ui/GroupMark';
import { InvitationReady, InvitationReadyFooter } from '@/components/ui/InvitationReady';
import { ItemAction } from '@/components/ui/ItemAction';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { StatePanel } from '@/components/ui/StatePanel';
import { Toggle } from '@/components/ui/Toggle';
import { AuditEventTable } from '@/features/shared/AuditEventTable';
import { createAuditFilterDefinitions, mergeAuditFilterOptions, type AuditEventFilterId } from '@/features/shared/auditFilters';
import type { DataTableDateRange } from '@/features/shared/DataTable';
import { useDataTableUrlState } from '@/features/shared/useDataTableUrlState';
import styles from './SystemSettingsPanel.module.css';
import { SystemWebPushSettingsSection } from './SystemWebPushSettingsSection';

const SETTINGS_QUERY_KEY = ['system-settings'] as const;
const GROUPS_QUERY_KEY = ['system-groups'] as const;
const AUDIT_QUERY_KEY = ['system-audit'] as const;
const SYSTEM_AUDIT_PAGE_SIZE = 50;
const MEBIBYTE = 1024 * 1024;
const SMTP_PASSWORD_MASK = '••••••••••••';
const COMMON_CURRENCIES = ['EUR', 'CHF', 'USD', 'GBP', 'PLN', 'CZK', 'DKK', 'NOK', 'SEK'] as const;
type SmtpForm = Omit<Required<SystemSmtpSettingsUpdate>, 'password' | 'port'> & { port: number | '' };

/** Converts persisted SMTP settings into editable, non-secret form values. */
function smtpFormFromSettings(smtp: SystemSettings['smtp']): SmtpForm {
  return {
    enabled: smtp.enabled.value,
    host: smtp.host.value,
    port: smtp.port.value,
    tlsMode: smtp.tlsMode.value,
    username: smtp.username.value,
    fromAddress: smtp.fromAddress.value,
    fromName: smtp.fromName.value,
  };
}

function currencyOptionLabel(currency: string): string {
  const symbol = new Intl.NumberFormat('de-DE', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
    .formatToParts(0)
    .find((part) => part.type === 'currency')?.value ?? currency;
  return `${currency} - ${symbol}`;
}

interface ResetConfirmationDialogProps {
  errorMessage?: string;
  onClose: () => void;
  onConfirm: () => void;
  open: boolean;
  pending: boolean;
  sectionName: string;
}

/** Confirms restoring every persisted setting in one system-settings section. */
function ResetConfirmationDialog({ errorMessage, onClose, onConfirm, open, pending, sectionName }: ResetConfirmationDialogProps) {
  const { t } = useTranslation();
  return (
    <ConfirmationDialog
      confirmIcon={<RotateCcw size={17} />}
      confirmLabel={pending ? t('systemSettings.resetting') : t('systemSettings.reset')}
      errorMessage={errorMessage}
      message={t('systemSettings.resetDialog.message')}
      onClose={onClose}
      onConfirm={onConfirm}
      open={open}
      pending={pending}
      title={t('systemSettings.resetDialog.title', { section: sectionName })}
    />
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

function useResetSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ keys, revision }: { keys: ResettableSystemSettingKey[]; revision: number }) => api.resetSystemSettings(keys, revision),
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
  const resetMutation = useResetSettingsMutation();
  const [resetOpen, setResetOpen] = useState(false);
  const [instanceName, setInstanceName] = useState(settings.instanceName.value);
  const [defaultCurrency, setDefaultCurrency] = useState(settings.defaultCurrency.value);
  const [mediaLimitMiB, setMediaLimitMiB] = useState(settings.mediaUploadMaxBytes.value / MEBIBYTE);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const mediaUploadMaxBytes = mediaLimitMiB * MEBIBYTE;
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
    || mediaLimitMiB * MEBIBYTE !== settings.mediaUploadMaxBytes.value;
  const pending = mutation.isPending || resetMutation.isPending;
  const maximumMediaLimitMiB = 25;
  const resetKeys: ResettableSystemSettingKey[] = [
    ...(settings.instanceName.source === 'DATABASE' ? ['instanceName' as const] : []),
    ...(settings.defaultCurrency.source === 'DATABASE' ? ['defaultCurrency' as const] : []),
    ...(settings.mediaUploadMaxBytes.source === 'DATABASE' ? ['mediaUploadMaxBytes' as const] : []),
  ];
  const reset = () => resetMutation.mutate({ keys: resetKeys, revision: settings.revision }, {
    onSuccess: (persisted) => {
      setInstanceName(persisted.instanceName.value);
      setDefaultCurrency(persisted.defaultCurrency.value);
      setMediaLimitMiB(persisted.mediaUploadMaxBytes.value / MEBIBYTE);
      setResetOpen(false);
    },
  });
  return (
    <section aria-labelledby="system-general-title" className={styles.section}>
      <header><h3 id="system-general-title">{t('systemSettings.general.title')}</h3></header>
      <form className={styles.form} onSubmit={submit}>
        <div className={styles.fieldBlock}>
          <Field htmlFor="system-instance-name" label={t('systemSettings.general.instanceName')}><TextInput id="system-instance-name" maxLength={120} onChange={(event) => setInstanceName(event.target.value)} required value={instanceName} /></Field>
        </div>
        <div className={styles.fieldBlock}>
          <Field htmlFor="system-default-currency" label={t('systemSettings.general.defaultCurrency')}>
            <SelectInput id="system-default-currency" onChange={(event) => setDefaultCurrency(event.target.value)} required value={defaultCurrency}>
              {!COMMON_CURRENCIES.some((currency) => currency === defaultCurrency) ? <option value={defaultCurrency}>{currencyOptionLabel(defaultCurrency)}</option> : null}
              {COMMON_CURRENCIES.map((currency) => <option key={currency} value={currency}>{currencyOptionLabel(currency)}</option>)}
            </SelectInput>
          </Field>
        </div>
        <div className={styles.fieldBlock}>
          <Field hint={t('systemSettings.general.mediaLimitHint')} htmlFor="system-media-limit" label={t('systemSettings.general.mediaLimit')}>
            <TextInput id="system-media-limit" max={maximumMediaLimitMiB} min={1} onChange={(event) => setMediaLimitMiB(event.target.valueAsNumber)} required step={1} type="number" value={mediaLimitMiB} />
          </Field>
        </div>
        {mutation.isError || resetMutation.isError ? <p className={styles.error} role="alert">{t('systemSettings.saveError')}</p> : null}
        {mutation.isSuccess || resetMutation.isSuccess ? <p className={styles.success} role="status">{t('systemSettings.saved')}</p> : null}
        <div className={styles.actions}>
          <Button disabled={pending || resetKeys.length === 0} leadingIcon={<RotateCcw size={17} />} onClick={() => setResetOpen(true)} variant="secondary">{t('systemSettings.reset')}</Button>
          <Button disabled={!changed || pending || !instanceName.trim() || !/^[A-Z]{3}$/.test(defaultCurrency) || !Number.isInteger(mediaLimitMiB) || mediaLimitMiB < 1 || mediaLimitMiB > maximumMediaLimitMiB} leadingIcon={<Save size={17} />} type="submit">{pending ? t('common.saving') : t('common.save')}</Button>
        </div>
      </form>
      <ResetConfirmationDialog errorMessage={resetMutation.isError ? t('systemSettings.saveError') : undefined} onClose={() => setResetOpen(false)} onConfirm={reset} open={resetOpen} pending={resetMutation.isPending} sectionName={t('systemSettings.general.title')} />
    </section>
  );
}

/** SMTP configuration, verification, activation, and reset controls. */
function SmtpSettingsSection({ settings }: { settings: SystemSettings }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const smtp = settings.smtp;
  const [form, setForm] = useState<SmtpForm>(() => smtpFormFromSettings(smtp));
  const [password, setPassword] = useState('');
  const [resetOpen, setResetOpen] = useState(false);
  const connectionChanged = form.host !== smtp.host.value
    || form.port !== smtp.port.value
    || form.tlsMode !== smtp.tlsMode.value
    || form.username !== smtp.username.value
    || form.fromAddress !== smtp.fromAddress.value
    || form.fromName !== smtp.fromName.value
    || password.length > 0;
  const synchronize = async (persisted?: SystemSettings) => {
    if (persisted) queryClient.setQueryData(SETTINGS_QUERY_KEY, persisted);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ['instance-capabilities'] }),
    ]);
  };
  const saveMutation = useMutation({
    mutationFn: () => {
      const port = form.port;
      return api.updateSystemSmtp({
        ...(!connectionChanged && form.enabled !== smtp.enabled.value ? { enabled: form.enabled } : {}),
        ...(form.host !== smtp.host.value ? { host: form.host } : {}),
        ...(port !== '' && port !== smtp.port.value ? { port } : {}),
        ...(form.tlsMode !== smtp.tlsMode.value ? { tlsMode: form.tlsMode } : {}),
        ...(form.username !== smtp.username.value ? { username: form.username } : {}),
        ...(form.fromAddress !== smtp.fromAddress.value ? { fromAddress: form.fromAddress } : {}),
        ...(form.fromName !== smtp.fromName.value ? { fromName: form.fromName } : {}),
        ...(password ? { password } : {}),
      }, settings.revision);
    },
    onSuccess: async (persisted) => {
      setPassword('');
      setForm(smtpFormFromSettings(persisted.smtp));
      await synchronize(persisted);
    },
    onError: async () => { await synchronize(); },
  });
  const testMutation = useMutation({
    mutationFn: () => api.testSystemSmtp(settings.revision),
    onSuccess: async (persisted) => { await synchronize(persisted); },
    onError: async () => { await synchronize(); },
  });
  const resetMutation = useMutation({
    mutationFn: () => api.resetSystemSmtp(settings.revision),
    onSuccess: async (persisted) => {
      setPassword('');
      setForm(smtpFormFromSettings(persisted.smtp));
      setResetOpen(false);
      await synchronize(persisted);
    },
    onError: async () => { await synchronize(); },
  });
  const pending = saveMutation.isPending || testMutation.isPending || resetMutation.isPending;
  const configurationChanged = form.enabled !== smtp.enabled.value || connectionChanged;
  const validPort = Number.isInteger(form.port) && Number(form.port) >= 1 && Number(form.port) <= 65535;
  const visibleTestStatus = testMutation.isError ? 'FAILED' : connectionChanged ? 'UNTESTED' : smtp.testStatus;
  const hasOverrides = smtp.passwordSource === 'DATABASE' || [smtp.enabled, smtp.host, smtp.port, smtp.tlsMode, smtp.username, smtp.fromAddress, smtp.fromName]
    .some((setting) => setting.source === 'DATABASE');
  const setValue = <K extends keyof SmtpForm>(key: K, value: SmtpForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  return (
    <section aria-labelledby="system-smtp-title" className={styles.section}>
      <header><h3 id="system-smtp-title">{t('systemSettings.smtp.title')}</h3><p>{t('systemSettings.smtp.intro')}</p></header>
      <form className={styles.form} onSubmit={(event) => { event.preventDefault(); saveMutation.mutate(); }}>
        <div className={styles.fieldBlock}><div className={styles.toggleRow}><div><strong>{t('systemSettings.smtp.enabled')}</strong><span>{t('systemSettings.smtp.enabledHint')}</span></div><Toggle checked={form.enabled} disabled={pending} label={t('systemSettings.smtp.enabled')} onChange={(value) => setValue('enabled', value)} /></div></div>
        <fieldset className={`${styles.gridTwo} ${styles.smtpFields}`} disabled={pending || !form.enabled}>
          <div className={styles.fieldBlock}><Field htmlFor="system-smtp-host" label={t('systemSettings.smtp.host')}><TextInput id="system-smtp-host" onChange={(event) => setValue('host', event.target.value)} required value={form.host} /></Field></div>
          <div className={styles.fieldBlock}><Field htmlFor="system-smtp-port" label={t('systemSettings.smtp.port')}><TextInput id="system-smtp-port" max={65535} min={1} onChange={(event) => setValue('port', event.target.value === '' ? '' : event.target.valueAsNumber)} required type="number" value={form.port} /></Field></div>
          <div className={styles.fieldBlock}><Field htmlFor="system-smtp-tls" label={t('systemSettings.smtp.tlsMode')}><SelectInput id="system-smtp-tls" onChange={(event) => setValue('tlsMode', event.target.value as SmtpForm['tlsMode'])} value={form.tlsMode}><option value="starttls">STARTTLS</option><option value="tls">TLS</option></SelectInput></Field></div>
          <div className={styles.fieldBlock}><Field htmlFor="system-smtp-username" label={t('systemSettings.smtp.username')}><TextInput autoComplete="username" id="system-smtp-username" onChange={(event) => setValue('username', event.target.value)} value={form.username} /></Field></div>
          <div className={styles.fieldBlock}><Field htmlFor="system-smtp-password" label={t('systemSettings.smtp.password')}><TextInput autoComplete="new-password" id="system-smtp-password" onChange={(event) => setPassword(event.target.value)} placeholder={smtp.passwordConfigured ? SMTP_PASSWORD_MASK : undefined} type="password" value={password} /></Field></div>
          <div className={styles.fieldBlock}><Field htmlFor="system-smtp-from-address" label={t('systemSettings.smtp.fromAddress')}><TextInput id="system-smtp-from-address" onChange={(event) => setValue('fromAddress', event.target.value)} required type="email" value={form.fromAddress} /></Field></div>
          <div className={styles.fieldBlock}><Field htmlFor="system-smtp-from-name" label={t('systemSettings.smtp.fromName')}><TextInput id="system-smtp-from-name" onChange={(event) => setValue('fromName', event.target.value)} value={form.fromName} /></Field></div>
        </fieldset>
        {saveMutation.isError || resetMutation.isError ? <p className={styles.error} role="alert">{t('systemSettings.smtp.error')}</p> : null}
        <dl className={styles.compactImpact}>
          <div><dt>{t('common.status')}:</dt><dd className={styles.smtpStatus} data-status={smtp.active ? 'active' : visibleTestStatus.toLowerCase()} role={!smtp.active && visibleTestStatus === 'FAILED' ? 'alert' : 'status'}>{smtp.active ? <CircleCheckBig aria-label={t('systemSettings.smtp.active')} className={styles.activeStatus} role="img" size={20} /> : t(`systemSettings.smtp.status.${visibleTestStatus.toLowerCase()}`)}</dd></div>
        </dl>
        <div className={styles.actions}>
          <Button disabled={pending || configurationChanged || !smtp.configurationValid} leadingIcon={<MailCheck size={17} />} onClick={() => testMutation.mutate()} variant="secondary">{testMutation.isPending ? t('systemSettings.smtp.testing') : t('systemSettings.smtp.test')}</Button>
          <Button disabled={pending || !hasOverrides} leadingIcon={<RotateCcw size={17} />} onClick={() => setResetOpen(true)} variant="secondary">{t('systemSettings.reset')}</Button>
          <Button disabled={pending || !configurationChanged || !form.host || !form.username || !form.fromAddress || !validPort} leadingIcon={<Save size={17} />} type="submit">{saveMutation.isPending ? t('common.saving') : t('common.save')}</Button>
        </div>
      </form>
      <ResetConfirmationDialog errorMessage={resetMutation.isError ? t('systemSettings.smtp.error') : undefined} onClose={() => setResetOpen(false)} onConfirm={() => resetMutation.mutate()} open={resetOpen} pending={resetMutation.isPending} sectionName={t('systemSettings.smtp.title')} />
    </section>
  );
}

/** Global public-join and maintenance controls plus CLI-managed administrators. */
function AccessSettingsSection({ settings }: { settings: SystemSettings }) {
  const { t } = useTranslation();
  const mutation = useSettingsMutation();
  const resetMutation = useResetSettingsMutation();
  const [resetOpen, setResetOpen] = useState(false);
  const [publicJoinEnabled, setPublicJoinEnabled] = useState(settings.publicJoinEnabled.value);
  const [maintenanceMode, setMaintenanceMode] = useState(settings.maintenanceMode.value);
  const [maintenanceMessage, setMaintenanceMessage] = useState(settings.maintenanceMessage.value);
  const administrators = useQuery({ queryKey: ['system-administrators'], queryFn: api.getSystemAdministrators });
  const pending = mutation.isPending || resetMutation.isPending;
  const resetKeys: ResettableSystemSettingKey[] = [
    ...(settings.publicJoinEnabled.source === 'DATABASE' ? ['publicJoinEnabled' as const] : []),
    ...(settings.maintenanceMode.source === 'DATABASE' ? ['maintenanceMode' as const] : []),
    ...(settings.maintenanceMessage.source === 'DATABASE' ? ['maintenanceMessage' as const] : []),
  ];
  const reset = () => resetMutation.mutate({ keys: resetKeys, revision: settings.revision }, {
    onSuccess: (persisted) => {
      setPublicJoinEnabled(persisted.publicJoinEnabled.value);
      setMaintenanceMode(persisted.maintenanceMode.value);
      setMaintenanceMessage(persisted.maintenanceMessage.value);
      setResetOpen(false);
    },
  });
  return (
    <section aria-labelledby="system-access-title" className={styles.section}>
      <header><h3 id="system-access-title">{t('systemSettings.access.title')}</h3><p>{t('systemSettings.access.intro')}</p></header>
      <div className={styles.form}>
        <div className={styles.fieldBlock}><div className={styles.toggleRow}><div><strong>{t('systemSettings.access.publicJoin')}</strong><span>{t('systemSettings.access.publicJoinHint')}</span></div><Toggle checked={publicJoinEnabled} disabled={pending} label={t('systemSettings.access.publicJoin')} onChange={setPublicJoinEnabled} /></div></div>
        <div className={styles.fieldBlock}><div className={styles.toggleRow}><div><strong>{t('systemSettings.access.maintenance')}</strong><span>{t('systemSettings.access.maintenanceHint')}</span></div><Toggle checked={maintenanceMode} disabled={pending} label={t('systemSettings.access.maintenance')} onChange={setMaintenanceMode} /></div></div>
        <div className={styles.fieldBlock}><Field htmlFor="system-maintenance-message" label={t('systemSettings.access.maintenanceMessage')}><TextInput id="system-maintenance-message" maxLength={240} onChange={(event) => setMaintenanceMessage(event.target.value)} value={maintenanceMessage} /></Field></div>
        {mutation.isError || resetMutation.isError ? <p className={styles.error} role="alert">{t('systemSettings.saveError')}</p> : null}
        <div className={styles.actions}>
          <Button disabled={pending || resetKeys.length === 0} leadingIcon={<RotateCcw size={17} />} onClick={() => setResetOpen(true)} variant="secondary">{t('systemSettings.reset')}</Button>
          <Button disabled={pending || publicJoinEnabled === settings.publicJoinEnabled.value && maintenanceMode === settings.maintenanceMode.value && maintenanceMessage === settings.maintenanceMessage.value} onClick={() => mutation.mutate({ revision: settings.revision, update: {
            ...(publicJoinEnabled !== settings.publicJoinEnabled.value ? { publicJoinEnabled } : {}),
            ...(maintenanceMode !== settings.maintenanceMode.value ? { maintenanceMode } : {}),
            ...(maintenanceMessage !== settings.maintenanceMessage.value ? { maintenanceMessage } : {}),
          } })} leadingIcon={<Save size={17} />}>{mutation.isPending ? t('common.saving') : t('common.save')}</Button>
        </div>
      </div>
      <ResetConfirmationDialog errorMessage={resetMutation.isError ? t('systemSettings.saveError') : undefined} onClose={() => setResetOpen(false)} onConfirm={reset} open={resetOpen} pending={resetMutation.isPending} sectionName={t('systemSettings.access.title')} />
      <div className={styles.subsection}><h4>{t('systemSettings.access.administrators')}</h4><p>{t('systemSettings.access.cliOnly')}</p>{administrators.data ? <ul className={styles.adminList}>{administrators.data.map((account) => <li key={account.id}><strong>{account.displayName}</strong><span>{account.email}</span></li>)}</ul> : <p>{t(administrators.isError ? 'systemSettings.access.administratorsError' : 'common.loading')}</p>}</div>
    </section>
  );
}

interface PurgeDialogProps {
  group: SystemGroup | null;
  onClose: () => void;
  onPurged: () => Promise<void>;
}

/** Exact-name confirmation and impact review for permanent group deletion. */
function PurgeDialog({ group, onClose, onPurged }: PurgeDialogProps) {
  const { t } = useTranslation();
  const formId = useId();
  const impact = useQuery({
    queryKey: ['system-group-deletion-impact', group?.id],
    queryFn: () => api.getSystemGroupDeletionImpact(group?.id ?? ''),
    enabled: group !== null,
  });
  const [groupName, setGroupName] = useState('');
  const clearConfirmation = () => setGroupName('');
  const close = () => {
    clearConfirmation();
    onClose();
  };
  const mutation = useMutation({
    mutationFn: async () => {
      if (!group) return;
      await api.purgeSystemGroup(group.id, impact.data?.version ?? group.version, { groupName });
    },
    onSuccess: async () => { await onPurged(); close(); },
  });
  const currentGroupName = impact.data?.groupName ?? group?.name;
  const valid = Boolean(group) && groupName === currentGroupName;
  return (
    <Modal onClose={() => { if (!mutation.isPending) close(); }} open={group !== null} size="wide" title={t('systemSettings.groups.purgeTitle', { name: currentGroupName ?? '' })} variant="sheet">
      {group ? <form className={styles.purgeForm} id={formId} onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
        <div className={styles.dangerNotice}><span className={styles.dangerIcon}><ShieldAlert aria-hidden="true" size={26} /></span><div><strong>{t('systemSettings.groups.purgeWarning')}</strong><p>{t('systemSettings.groups.purgeDescription')}</p></div></div>
        {impact.isError ? <p className={styles.error} role="alert">{t('systemSettings.groups.impactError')}</p> : null}
        <section aria-labelledby="system-purge-impact-title" className={styles.impactPanel}>
          <h3 id="system-purge-impact-title">{t('systemSettings.groups.impactTitle')}</h3>
          <dl className={styles.impact}>
            <div><dt>{t('systemSettings.groups.impact.members')}</dt><dd>{impact.data?.members ?? group.impact.members}</dd></div>
            <div><dt>{t('systemSettings.groups.impact.openBalance')}</dt><dd>{impact.data ? formatMoney(impact.data.openBalance) : '–'}</dd></div>
          </dl>
        </section>
        <div className={styles.confirmationPanel}>
          <p>{t('systemSettings.groups.confirmInstructionBefore')} <strong>„{currentGroupName}“</strong> {t('systemSettings.groups.confirmInstructionAfter')}</p>
          <Field htmlFor="system-purge-name" label={t('systemSettings.groups.confirmName')}><TextInput autoComplete="off" id="system-purge-name" onChange={(event) => setGroupName(event.target.value)} required value={groupName} /></Field>
        </div>
        {mutation.isError ? <p className={styles.error} role="alert">{t('systemSettings.groups.purgeError')}</p> : null}
        <ModalFooter><div className={`${styles.actions} ${styles.purgeActions}`}><Button disabled={mutation.isPending} leadingIcon={<X size={17} />} onClick={close} variant="secondary">{t('common.cancel')}</Button><Button disabled={!valid || mutation.isPending || impact.isLoading || impact.isError} form={formId} leadingIcon={<Trash2 size={17} />} type="submit" variant="danger">{mutation.isPending ? t('systemSettings.groups.purging') : t('systemSettings.groups.purge')}</Button></div></ModalFooter>
      </form> : null}
    </Modal>
  );
}

/** Shows the one-time first-administrator link returned immediately after creation or replacement. */
function SystemGroupInvitationDialog({ invitation, onClose }: { invitation: SystemGroupInvitationResult | null; onClose: () => void }) {
  const { t } = useTranslation();
  if (!invitation?.acceptUrl || !invitation.expiresAt) return null;
  const emailQueued = invitation.emailDeliveryStatus === 'PENDING';
  return (
    <Modal footer={<InvitationReadyFooter onDone={onClose} />} onClose={onClose} open size="workspace" title={t('systemSettings.groups.invitationReadyTitle', { group: invitation.group.name })}>
      <InvitationReady
        acceptUrl={invitation.acceptUrl}
        deliveryStatus={{
          title: t(emailQueued ? 'members.invitationStatus.pendingTitle' : 'members.invitationStatus.notRequestedTitle'),
          description: t(emailQueued ? 'members.invitationStatus.pendingDescription' : 'members.invitationStatus.notRequestedDescription', { email: invitation.group.administratorEmail ?? '' }),
        }}
        expiresAt={invitation.expiresAt}
        fallbackHint={emailQueued ? t('members.fallbackHint') : undefined}
        linkLabel={t('members.invitationLink')}
      />
    </Modal>
  );
}

/** Group creation, provisioning, archival, restoration, and purge management. */
function GroupsSettingsSection({ defaultCurrency }: { defaultCurrency: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const groups = useQuery({ queryKey: GROUPS_QUERY_KEY, queryFn: api.getSystemGroups });
  const [name, setName] = useState('');
  const [administratorEmail, setAdministratorEmail] = useState('');
  const [createdInvitation, setCreatedInvitation] = useState<SystemGroupInvitationResult | null>(null);
  const [archiveGroup, setArchiveGroup] = useState<SystemGroup | null>(null);
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
  const createMutation = useMutation({
    mutationFn: (input: Parameters<typeof api.createSystemGroup>[0]) => api.createSystemGroup(input),
    onSuccess: async (result) => {
      setName('');
      setAdministratorEmail('');
      setCreatedInvitation(result.acceptUrl ? result : null);
      await refresh();
    },
  });
  const lifecycleMutation = useMutation({
    mutationFn: ({ action, group }: { action: 'archive' | 'restore'; group: SystemGroup }) => {
      if (action === 'restore') return api.restoreSystemGroup(group.id, group.version);
      return api.archiveSystemGroup(group.id, group.version);
    },
    onSuccess: async (_group, variables) => {
      if (variables.action === 'archive') setArchiveGroup(null);
      await refresh();
    },
    onError: refresh,
  });
  const resendMutation = useMutation({
    mutationFn: (group: SystemGroup) => api.resendSystemGroupInvitation(group.id, group.version),
    onSuccess: async (result) => {
      queryClient.setQueryData<SystemGroup[]>(GROUPS_QUERY_KEY, (current) => current?.map((group) => group.id === result.group.id ? result.group : group));
      setCreatedInvitation(result);
      await refresh();
    },
    onError: refresh,
  });
  const lifecycleErrorKey = lifecycleMutation.variables?.action === 'restore'
    ? 'systemSettings.groups.restoreError'
    : 'systemSettings.groups.archiveError';
  if (groups.isLoading) return <section aria-labelledby="system-groups-title" className={styles.section}><header><h3 id="system-groups-title">{t('systemSettings.groups.title')}</h3></header><StatePanel kind="loading" /></section>;
  return (
    <section aria-labelledby="system-groups-title" className={styles.section}>
      <header><h3 id="system-groups-title">{t('systemSettings.groups.title')}</h3><p>{t('systemSettings.groups.intro')}</p></header>
      <form className={styles.createGroup} onSubmit={(event) => { event.preventDefault(); createMutation.mutate({ name: name.trim(), currency: defaultCurrency, administratorEmail: administratorEmail.trim() }); }}>
        <Field htmlFor="system-group-name" label={t('systemSettings.groups.name')}><TextInput disabled={createMutation.isPending} id="system-group-name" maxLength={120} onChange={(event) => { if (createMutation.isError) createMutation.reset(); setName(event.target.value); }} required value={name} /></Field>
        <Field htmlFor="system-group-administrator" label={t('systemSettings.groups.administratorEmail')}><TextInput autoComplete="email" disabled={createMutation.isPending} id="system-group-administrator" list="system-account-suggestions" onChange={(event) => { if (createMutation.isError) createMutation.reset(); setAdministratorEmail(event.target.value); }} required type="email" value={administratorEmail} /><datalist id="system-account-suggestions">{accounts.data?.map((account) => <option key={account.id} value={account.email}>{account.displayName}</option>)}</datalist></Field>
        <Button disabled={createMutation.isPending || !name.trim() || !administratorEmail.trim()} leadingIcon={<Plus size={17} />} type="submit">{createMutation.isPending ? t('systemSettings.groups.creating') : t('systemSettings.groups.create')}</Button>
      </form>
      {groups.isError ? <p className={styles.error} role="alert">{t('systemSettings.groups.loadError')}</p> : null}
      {createMutation.isError ? <p className={styles.error} role="alert">{t('systemSettings.groups.createError')}</p> : null}
      {lifecycleMutation.isError ? <p className={styles.error} role="alert">{t(lifecycleErrorKey)}</p> : null}
      {resendMutation.isError ? <p className={styles.error} role="alert">{t('systemSettings.groups.resendError')}</p> : null}
      <div className={styles.groupList}>
        {groups.data?.map((group) => (
          <article className={styles.groupCard} key={group.id}>
            <div className={styles.groupIdentity}><GroupMark className={styles.groupMark} data-testid={`system-group-mark-${group.id}`} decorative imageUrl={group.logoUrl} name={group.name} /><div><h4>{group.name}</h4><p>{t(`systemSettings.groups.status.${group.status.toLowerCase()}`)}{group.administratorEmail ? ` · ${group.administratorEmail}` : ''}</p></div></div>
            <dl className={styles.compactImpact}><div><dt>{t('systemSettings.groups.impact.members')}</dt><dd>{group.impact.members}</dd></div><div><dt>{t('systemSettings.groups.impact.bookings')}</dt><dd>{group.impact.bookings}</dd></div><div><dt>{t('systemSettings.groups.impact.mediaFiles')}</dt><dd>{group.impact.mediaFiles}</dd></div></dl>
            <div className={styles.groupActions}>
              {group.status === 'PROVISIONING' ? <ItemAction aria-label={t('systemSettings.groups.resendFor', { name: group.name })} disabled={resendMutation.isPending || lifecycleMutation.isPending} leadingIcon={<RefreshCw size={15} />} onClick={() => resendMutation.mutate(group)} title={t('systemSettings.groups.resend')}>{resendMutation.isPending && resendMutation.variables?.id === group.id ? t('systemSettings.groups.resending') : t('systemSettings.groups.resend')}</ItemAction> : null}
              {group.status === 'ARCHIVED' ? <ItemAction aria-label={t('systemSettings.groups.restoreFor', { name: group.name })} disabled={lifecycleMutation.isPending} leadingIcon={<ArchiveRestore size={15} />} onClick={() => lifecycleMutation.mutate({ action: 'restore', group })} title={t('systemSettings.groups.restore')}>{t('systemSettings.groups.restore')}</ItemAction> : <ItemAction aria-label={t('systemSettings.groups.archiveFor', { name: group.name })} disabled={lifecycleMutation.isPending} leadingIcon={<Archive size={15} />} onClick={() => { lifecycleMutation.reset(); setArchiveGroup(group); }} title={t('systemSettings.groups.archive')}>{t('systemSettings.groups.archive')}</ItemAction>}
              {group.status === 'ARCHIVED' ? <ItemAction aria-label={t('systemSettings.groups.deletePermanentlyFor', { name: group.name })} leadingIcon={<Trash2 size={15} />} onClick={() => setPurgeGroup(group)} title={t('systemSettings.groups.deletePermanently')}>{t('systemSettings.groups.deletePermanently')}</ItemAction> : null}
            </div>
          </article>
        ))}
        {groups.data?.length === 0 ? <StatePanel kind="empty" message={t('systemSettings.groups.empty')} /> : null}
      </div>
      <ConfirmationDialog
        confirmIcon={<Archive size={17} />}
        confirmLabel={lifecycleMutation.isPending ? t('systemSettings.groups.archiving') : t('systemSettings.groups.archive')}
        errorMessage={archiveGroup && lifecycleMutation.isError && lifecycleMutation.variables?.action === 'archive' ? t('systemSettings.groups.archiveError') : undefined}
        message={t('systemSettings.groups.archiveConfirm', { name: archiveGroup?.name ?? '' })}
        onClose={() => { lifecycleMutation.reset(); setArchiveGroup(null); }}
        onConfirm={() => { if (archiveGroup) lifecycleMutation.mutate({ action: 'archive', group: archiveGroup }); }}
        open={archiveGroup !== null}
        pending={lifecycleMutation.isPending}
        title={t('systemSettings.groups.archiveTitle')}
        tone="danger"
      />
      <SystemGroupInvitationDialog invitation={createdInvitation} key={`invitation-${createdInvitation?.acceptUrl ?? 'closed'}`} onClose={() => setCreatedInvitation(null)} />
      <PurgeDialog group={purgeGroup} key={`purge-${purgeGroup?.id ?? 'closed'}`} onClose={() => setPurgeGroup(null)} onPurged={refresh} />
    </section>
  );
}

/** Immutable global activity feed including retained purge receipts. */
function SystemAuditSection() {
  const { t } = useTranslation();
  const filterOptionsQuery = useQuery({ queryFn: api.getSystemAuditFilterOptions, queryKey: [...AUDIT_QUERY_KEY, 'filter-options'] });
  const queryFilterDefinitions = useMemo(() => createAuditFilterDefinitions(t, filterOptionsQuery.data), [filterOptionsQuery.data, t]);
  const tableState = useDataTableUrlState<AuditEventFilterId>({
    filterDefinitions: queryFilterDefinitions,
    initialSorting: [{ id: 'occurredAt', desc: true }],
    namespace: 'system-audit',
    sortableColumnIds: ['occurredAt', 'actorName', 'action', 'resourceType'],
  });
  const deferredSearch = useDeferredValue(tableState.searchValue.trim());
  const collectionQuery = useMemo<SystemAuditCollectionQuery>(() => {
    const dateRange = tableState.filters.occurredAt as DataTableDateRange | undefined;
    const sorting = tableState.sorting[0];
    return {
      action: tableState.filters.action as string[] | undefined,
      direction: sorting?.desc === false ? 'asc' : 'desc',
      limit: SYSTEM_AUDIT_PAGE_SIZE,
      occurredFrom: dateRange?.from,
      occurredTo: dateRange?.to,
      q: deferredSearch || undefined,
      resourceType: tableState.filters.resourceType as string[] | undefined,
      sort: (sorting?.id ?? 'occurredAt') as SystemAuditCollectionQuery['sort'],
    };
  }, [deferredSearch, tableState.filters, tableState.sorting]);
  const audit = useInfiniteQuery({
    getNextPageParam: (lastPage: CollectionPage<SystemAuditEntry>) => lastPage.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }): Promise<CollectionPage<SystemAuditEntry>> => api.getSystemAuditPage({ ...collectionQuery, cursor: pageParam }),
    queryKey: [...AUDIT_QUERY_KEY, 'collection', collectionQuery],
  });
  const entries = useMemo(() => audit.data?.pages.flatMap((page) => page.items).map((entry) => ({
    action: entry.action,
    actor: entry.actorDisplayName,
    details: entry.summary,
    id: entry.id,
    occurredAt: entry.createdAt,
    subject: [entry.targetType, entry.targetId].filter(Boolean).join(' · ') || '–',
  })) ?? [], [audit.data]);
  const visibleFilterOptions = useMemo(() => {
    const loadedEntries = audit.data?.pages.flatMap((page) => page.items) ?? [];
    return mergeAuditFilterOptions(
      filterOptionsQuery.data,
      loadedEntries.map((entry) => ({ action: entry.action, resourceType: entry.targetType })),
    );
  }, [audit.data, filterOptionsQuery.data]);
  const filterDefinitions = useMemo(() => createAuditFilterDefinitions(t, visibleFilterOptions), [t, visibleFilterOptions]);
  return (
    <section aria-labelledby="system-audit-title" className={styles.section}>
      <header><h3 id="system-audit-title">{t('systemSettings.audit.title')}</h3><p>{t('systemSettings.audit.intro')}</p></header>
      <AuditEventTable
        emptyMessage={audit.isError ? t('systemSettings.audit.error') : t('systemSettings.audit.empty')}
        entries={entries}
        filterDefinitions={filterDefinitions}
        hasMore={audit.hasNextPage}
        isLoading={audit.isLoading}
        isLoadingMore={audit.isFetchingNextPage}
        onLoadMore={() => void audit.fetchNextPage()}
        tableState={tableState}
        title={t('systemSettings.audit.title')}
      />
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
      <SystemWebPushSettingsSection key={`web-push-${settings.data.revision}`} settings={settings.data} />
      <AccessSettingsSection key={`access-${settings.data.revision}`} settings={settings.data} />
      <GroupsSettingsSection defaultCurrency={settings.data.defaultCurrency.value} key={`groups-${settings.data.revision}`} />
      <SystemAuditSection />
    </div>
  );
}
