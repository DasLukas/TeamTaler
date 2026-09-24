import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import ChartNoAxesCombined from 'lucide-react/dist/esm/icons/chart-no-axes-combined';
import ReceiptText from 'lucide-react/dist/esm/icons/receipt-text';
import Save from 'lucide-react/dist/esm/icons/save';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import WalletCards from 'lucide-react/dist/esm/icons/wallet-cards';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { ExternalAccountCollection, GroupSettings, GroupSettingsUpdateInput, PaymentMethod, PaymentMethodUpdate, ReasonMode, Role, Session, ThemeId } from '@/api/types';
import { can } from '@/app/permissions';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { Field, TextInput } from '@/components/ui/FormField';
import { SelectMenu } from '@/components/ui/SelectMenu';
import { StatePanel } from '@/components/ui/StatePanel';
import { Toggle } from '@/components/ui/Toggle';
import { notificationKeys } from '@/features/notifications/notificationQueryKeys';
import { ThemePicker } from '@/features/appearance/ThemePicker';
import { isPaymentTargetValid } from '@/features/finance/paymentTargets';
import { ExternalAccountConfigurationActions } from '@/features/externalAccounts/ExternalAccountConfigurationActions';
import { externalAccountKeys } from '@/features/externalAccounts/externalAccountQueryKeys';
import { ConfigurableListEditor } from './ConfigurableListEditor';
import { PaymentMethodEditor } from './PaymentMethodEditor';
import { GroupSettingsPanel } from './GroupSettingsPanel';
import { roleDisplayName } from './roleDisplayName';
import styles from './BehaviorSettingsPanel.module.css';
import { PlanningSettingsSection } from './PlanningSettingsSection';
import { KioskSettingsSection } from './KioskSettingsSection';

/** Properties for the editable group behavior settings form. */
interface SettingsFormProps {
  canManageExternalAccounts: boolean;
  canManageDefaultRole: boolean;
  canManageFinancialSettings: boolean;
  canManageGroup: boolean;
  currency: string;
  groupId: string;
  roles?: Role[];
  settings: GroupSettings;
  externalAccounts?: ExternalAccountCollection;
}

interface ExternalAccountSettingsSectionProps {
  accounts: ExternalAccountCollection;
  currency: string;
  groupId: string;
  paymentMethods: PaymentMethod[];
}

interface DefaultRoleSettingProps {
  groupId: string;
  roles: Role[];
  settings: GroupSettings;
}

interface DefaultThemeSettingProps {
  groupId: string;
  settings: GroupSettings;
}

interface StatisticsFeatureSettingProps {
  groupId: string;
  settings: GroupSettings;
}

interface ExternalAccountsFeatureSettingProps {
  groupId: string;
  settings: GroupSettings;
  unsavedChanges: boolean;
}

/**
 * Builds payment-method updates while keeping legacy target edits separate from explicit link updates.
 *
 * @param current - Current draft methods.
 * @param persisted - Last server-confirmed methods used to detect target changes.
 * @param externalAccountsEnabled - Whether account links are managed through the account configuration UI.
 * @returns Methods with the account identifier omitted only for changed legacy targets.
 */
function paymentMethodUpdates(current: PaymentMethod[], persisted: PaymentMethod[], externalAccountsEnabled: boolean): PaymentMethodUpdate[] {
  const persistedById = new Map(persisted.map((method) => [method.id, method]));
  return current.map((method) => {
    const previousTarget = persistedById.get(method.id)?.paymentTarget ?? null;
    if (externalAccountsEnabled || JSON.stringify(previousTarget) === JSON.stringify(method.paymentTarget)) return method;
    return { id: method.id, label: method.label, attachmentMode: method.attachmentMode, paymentTarget: method.paymentTarget };
  });
}

/**
 * Refreshes cached views that depend on group finance configuration.
 *
 * @param queryClient - Shared query cache for the active session.
 * @param groupId - Group whose settings changed.
 * @returns A promise that resolves after dependent queries are invalidated.
 */
async function invalidateFinanceSettingsConsumers(queryClient: QueryClient, groupId: string): Promise<void> {
  queryClient.removeQueries({ queryKey: notificationKeys.preferences(groupId) });
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['booking-context', groupId] }),
    queryClient.invalidateQueries({ queryKey: ['transaction-settings', groupId] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard', groupId] }),
    queryClient.invalidateQueries({ queryKey: ['periods', groupId] }),
    queryClient.invalidateQueries({ queryKey: ['settlements', groupId] }),
    queryClient.invalidateQueries({ queryKey: ['roles', groupId] }),
    queryClient.invalidateQueries({ queryKey: ['members', groupId] }),
    queryClient.invalidateQueries({ queryKey: ['statistics', groupId] }),
    queryClient.invalidateQueries({ queryKey: externalAccountKeys.all(groupId) }),
  ]);
}

/** Renders the external-account configuration entry points inside finance settings. */
function ExternalAccountSettingsSection({ accounts, currency, groupId, paymentMethods }: ExternalAccountSettingsSectionProps) {
  const { t } = useTranslation();
  return <section aria-labelledby="external-account-settings-title" className={styles.settingsSection}>
    <header><h3 id="external-account-settings-title">{t('behaviorSettings.financeSectionTitle')}</h3></header>
    <section className={styles.card}><ExternalAccountConfigurationActions accounts={accounts} currency={currency} groupId={groupId} paymentMethods={paymentMethods} /></section>
  </section>;
}

/** Properties for the accessible three-state reason-policy control. */
interface ReasonModeControlProps {
  disabled?: boolean;
  id: string;
  label: string;
  onChange: (value: ReasonMode) => void;
  value: ReasonMode;
}

/**
 * Renders a native-radio segmented control for off, optional, and required.
 *
 * @param props - Stable identifier, label, value, disabled state, and change callback.
 * @returns A keyboard-operable three-position reason-policy selector.
 */
function ReasonModeControl({ disabled = false, id, label, onChange, value }: ReasonModeControlProps) {
  const { t } = useTranslation();
  const options: Array<{ label: string; value: ReasonMode }> = [
    { label: t('behaviorSettings.reasonModeOff'), value: 'OFF' },
    { label: t('behaviorSettings.reasonModeOptional'), value: 'OPTIONAL' },
    { label: t('behaviorSettings.reasonModeRequired'), value: 'REQUIRED' },
  ];
  return (
    <fieldset className={styles.reasonModeControl} disabled={disabled}>
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <label key={option.value}>
          <input checked={value === option.value} name={id} onChange={() => onChange(option.value)} type="radio" value={option.value} />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * Renders the default role applied to newly created memberships and invitations.
 *
 * @param props - Active group, assignable roles, and persisted group settings.
 * @returns A role selector with independent save feedback.
 */
function DefaultRoleSetting({ groupId, roles, settings }: DefaultRoleSettingProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [roleId, setRoleId] = useState(settings.defaultRoleId ?? '');
  const candidates = roles.filter((role) => !role.grants.some((grant) => grant.permission === 'GROUP_ADMINISTRATION' || grant.permission === 'MEMBER_MANAGEMENT'));
  const mutation = useMutation({
    mutationFn: () => api.updateGroupSettings(groupId, { defaultRoleId: roleId }),
    onSuccess: async (persisted) => {
      queryClient.setQueryData<GroupSettings>(['group-settings', groupId], persisted);
      await queryClient.invalidateQueries({ queryKey: ['roles', groupId] });
    },
  });

  return (
    <section aria-labelledby="default-role-setting-title" className={`${styles.card} ${styles.defaultRoleCard}`}>
      <div>
        <h4 id="default-role-setting-title">{t('behaviorSettings.defaultRoleTitle')}</h4>
        <Field hint={!settings.defaultRoleId ? t('behaviorSettings.defaultRoleMissing') : undefined} htmlFor="default-membership-role" label={t('behaviorSettings.defaultRoleFieldLabel')}>
          <SelectMenu ariaLabel={t('behaviorSettings.defaultRoleFieldLabel')} id="default-membership-role" onChange={(nextRoleId) => { setRoleId(nextRoleId); mutation.reset(); }} options={[{ disabled: true, label: t('behaviorSettings.defaultRolePlaceholder'), value: '' }, ...candidates.map((role) => ({ label: roleDisplayName(role), value: role.id }))]} value={roleId} />
        </Field>
      </div>
      <div className={styles.defaultRoleActions}>
        {mutation.isError ? <p className={styles.error} role="alert">{t('behaviorSettings.saveError')}</p> : null}
        {mutation.isSuccess ? <p className={styles.success} role="status">{t('behaviorSettings.saved')}</p> : null}
        <Button disabled={!roleId || roleId === settings.defaultRoleId || mutation.isPending} leadingIcon={<Save size={17} />} onClick={() => mutation.mutate()}>{mutation.isPending ? t('behaviorSettings.saving') : t('common.save')}</Button>
      </div>
    </section>
  );
}

/**
 * Renders the group theme inherited by members without a personal override.
 *
 * @param props - Active group identifier and persisted group settings.
 * @returns A reusable theme picker with explicit save feedback.
 */
function DefaultThemeSetting({ groupId, settings }: DefaultThemeSettingProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [defaultTheme, setDefaultTheme] = useState<ThemeId>(settings.defaultTheme);
  const mutation = useMutation({
    mutationFn: () => api.updateGroupSettings(groupId, { defaultTheme }),
    onSuccess: (persisted) => {
      queryClient.setQueryData<GroupSettings>(['group-settings', groupId], persisted);
      queryClient.setQueryData<Session>(['session'], (session) => session ? {
        ...session,
        groups: session.groups.map((group) => group.id === groupId ? { ...group, defaultTheme: persisted.defaultTheme } : group),
      } : session);
    },
  });

  return (
    <section aria-labelledby="default-theme-setting-title" className={`${styles.card} ${styles.themeCard}`}>
      <div>
        <h4 id="default-theme-setting-title">{t('behaviorSettings.defaultThemeTitle')}</h4>
        <p>{t('behaviorSettings.defaultThemeDescription')}</p>
      </div>
      <ThemePicker
        disabled={mutation.isPending}
        label={t('behaviorSettings.defaultThemeFieldLabel')}
        onChange={(theme) => {
          if (theme) setDefaultTheme(theme);
          mutation.reset();
        }}
        value={defaultTheme}
      />
      <div className={styles.defaultRoleActions}>
        {mutation.isError ? <p className={styles.error} role="alert">{t('behaviorSettings.defaultThemeSaveError')}</p> : null}
        {mutation.isSuccess ? <p className={styles.success} role="status">{t('behaviorSettings.defaultThemeSaved')}</p> : null}
        <Button disabled={defaultTheme === settings.defaultTheme || mutation.isPending} leadingIcon={<Save size={17} />} onClick={() => mutation.mutate()}>{mutation.isPending ? t('behaviorSettings.saving') : t('common.save')}</Button>
      </div>
    </section>
  );
}

/**
 * Renders the group-wide master switch for the dedicated statistics workspace.
 *
 * @param props - Active group identifier and persisted group settings.
 * @returns An immediate feature switch with guarded deactivation and session projection updates.
 */
function StatisticsFeatureSetting({ groupId, settings }: StatisticsFeatureSettingProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirmDisable, setConfirmDisable] = useState(false);
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => api.updateGroupSettings(groupId, { statisticsEnabled: enabled }),
    onSuccess: (persisted) => {
      queryClient.setQueryData<GroupSettings>(['group-settings', groupId], persisted);
      queryClient.setQueryData<Session>(['session'], (session) => session ? {
        ...session,
        groups: session.groups.map((group) => group.id === groupId ? { ...group, statisticsEnabled: persisted.statisticsEnabled } : group),
      } : session);
      queryClient.removeQueries({ queryKey: ['statistics', groupId] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard', groupId] });
      setConfirmDisable(false);
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: ['group-settings', groupId] }),
  });

  return (
    <section aria-labelledby="statistics-feature-setting-title" className={styles.card}>
      <div className={styles.settingRow}>
        <div>
          <h4 id="statistics-feature-setting-title">{t('behaviorSettings.statisticsTitle')}</h4>
          <p>{t('behaviorSettings.statisticsDescription')}</p>
        </div>
        <Toggle checked={settings.statisticsEnabled} disabled={mutation.isPending} label={t('behaviorSettings.statisticsToggle')} onChange={(enabled) => {
          mutation.reset();
          if (enabled) mutation.mutate(true);
          else setConfirmDisable(true);
        }} />
      </div>
      <p className={styles.notice}>{t(settings.statisticsEnabled ? 'behaviorSettings.statisticsEnabledNotice' : 'behaviorSettings.statisticsDisabledNotice')}</p>
      {mutation.isError && !confirmDisable ? <p className={styles.error} role="alert">{t('behaviorSettings.statisticsSaveError')}</p> : null}
      <ConfirmationDialog
        confirmIcon={<ChartNoAxesCombined size={17} />}
        confirmLabel={t('behaviorSettings.statisticsDisable')}
        errorMessage={mutation.isError ? t('behaviorSettings.statisticsSaveError') : undefined}
        message={t('behaviorSettings.statisticsDisableImpact')}
        onClose={() => {
          mutation.reset();
          setConfirmDisable(false);
        }}
        onConfirm={() => mutation.mutate(false)}
        open={confirmDisable}
        pending={mutation.isPending}
        title={t('behaviorSettings.statisticsDisableTitle')}
        tone="danger"
      />
    </section>
  );
}

/** Renders the administrator-owned switch for group external accounts. */
function ExternalAccountsFeatureSetting({ groupId, settings, unsavedChanges }: ExternalAccountsFeatureSettingProps) {
  const { t } = useTranslation();
  const unsavedChangesId = useId();
  const queryClient = useQueryClient();
  const [confirmDisable, setConfirmDisable] = useState(false);
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => api.updateGroupSettings(groupId, { externalAccountsEnabled: enabled }),
    onSuccess: (persisted) => {
      queryClient.setQueryData<GroupSettings>(['group-settings', groupId], persisted);
      queryClient.setQueryData<Session>(['session'], (session) => session ? {
        ...session,
        groups: session.groups.map((group) => group.id === groupId ? { ...group, externalAccountsEnabled: persisted.externalAccountsEnabled } : group),
      } : session);
      queryClient.removeQueries({ queryKey: ['external-accounts', groupId] });
      setConfirmDisable(false);
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: ['group-settings', groupId] }),
  });
  return <div className={styles.externalAccountsFeature}>
    <div className={styles.settingRow}>
      <div><h4 id="external-accounts-feature-title">{t('behaviorSettings.externalAccountsTitle')}</h4><p>{t('behaviorSettings.externalAccountsDescription')}</p></div>
      <Toggle checked={settings.externalAccountsEnabled === true} descriptionId={unsavedChanges ? unsavedChangesId : undefined} disabled={mutation.isPending || unsavedChanges} label={t('behaviorSettings.externalAccountsToggle')} onChange={(enabled) => {
        mutation.reset();
        if (enabled) mutation.mutate(true);
        else setConfirmDisable(true);
      }} />
    </div>
    {unsavedChanges ? <p className={styles.notice} id={unsavedChangesId}>{t('behaviorSettings.saveBeforeSwitchingExternalAccounts')}</p> : null}
    <p className={styles.notice}>{t(settings.externalAccountsEnabled ? 'behaviorSettings.externalAccountsEnabledNotice' : 'behaviorSettings.externalAccountsDisabledNotice')}</p>
    {mutation.isError && !confirmDisable ? <p className={styles.error} role="alert">{t('behaviorSettings.externalAccountsSaveError')}</p> : null}
    <ConfirmationDialog
      confirmIcon={<WalletCards size={17} />}
      confirmLabel={t('behaviorSettings.externalAccountsDisable')}
      errorMessage={mutation.isError ? t('behaviorSettings.externalAccountsSaveError') : undefined}
      message={t('behaviorSettings.externalAccountsDisableImpact')}
      onClose={() => { mutation.reset(); setConfirmDisable(false); }}
      onConfirm={() => mutation.mutate(false)}
      open={confirmDisable}
      pending={mutation.isPending}
      title={t('behaviorSettings.externalAccountsDisableTitle')}
      tone="danger"
    />
  </div>;
}

/**
 * Renders grouped identity, statistics, finance, planning, and transaction settings for one group.
 *
 * @param props - Group identifier and persisted settings.
 * @returns An accessible settings form with explicit save feedback.
 */
function SettingsForm({ canManageDefaultRole, canManageExternalAccounts, canManageFinancialSettings, canManageGroup, currency, externalAccounts, groupId, roles, settings }: SettingsFormProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [settlementsEnabled, setSettlementsEnabled] = useState(settings.settlementsEnabled);
  const [settlementDueSoonDays, setSettlementDueSoonDays] = useState(settings.settlementDueSoonDays);
  const [settlementOverdueRepeatDays, setSettlementOverdueRepeatDays] = useState(settings.settlementOverdueRepeatDays);
  const [confirmDisableSettlements, setConfirmDisableSettlements] = useState(false);
  const [ownBookingReasonMode, setOwnBookingReasonMode] = useState(settings.ownBookingReasonMode);
  const [foreignBookingReasonMode, setForeignBookingReasonMode] = useState(settings.foreignBookingReasonMode);
  const [ownPaymentReasonMode, setOwnPaymentReasonMode] = useState(settings.ownPaymentReasonMode);
  const [otherPaymentReasonMode, setOtherPaymentReasonMode] = useState(settings.otherPaymentReasonMode);
  const [paymentMethods, setPaymentMethods] = useState(settings.paymentMethods);
  const [pendingRemovalId, setPendingRemovalId] = useState<string | null>(null);
  const [bookingReasons, setBookingReasons] = useState(settings.bookingReasons);
  const [paymentReasons, setPaymentReasons] = useState(settings.paymentReasons);
  const pendingRemoval = paymentMethods.find((method) => method.id === pendingRemovalId);
  const configurableCollections = [paymentMethods, bookingReasons, paymentReasons];
  const reminderConfigurationInvalid = !Number.isInteger(settlementDueSoonDays) || settlementDueSoonDays < 1 || settlementDueSoonDays > 30
    || !Number.isInteger(settlementOverdueRepeatDays) || settlementOverdueRepeatDays < 0 || settlementOverdueRepeatDays > 90;
  const configurationInvalid = reminderConfigurationInvalid || paymentMethods.length === 0 || configurableCollections.some((items) => {
    const labels = items.map((item) => item.label.trim().toLocaleLowerCase());
    return labels.some((label) => !label) || new Set(labels).size !== labels.length;
  }) || paymentMethods.some((method) => !isPaymentTargetValid(method.paymentTarget, currency));
  const changed = settlementsEnabled !== settings.settlementsEnabled
    || settlementDueSoonDays !== settings.settlementDueSoonDays
    || settlementOverdueRepeatDays !== settings.settlementOverdueRepeatDays
    || ownBookingReasonMode !== settings.ownBookingReasonMode
    || foreignBookingReasonMode !== settings.foreignBookingReasonMode
    || ownPaymentReasonMode !== settings.ownPaymentReasonMode
    || otherPaymentReasonMode !== settings.otherPaymentReasonMode
    || JSON.stringify(paymentMethods) !== JSON.stringify(settings.paymentMethods)
    || JSON.stringify(bookingReasons) !== JSON.stringify(settings.bookingReasons)
    || JSON.stringify(paymentReasons) !== JSON.stringify(settings.paymentReasons);

  const mutation = useMutation({
    mutationFn: () => {
      const update: GroupSettingsUpdateInput = {
        ...(settlementsEnabled !== settings.settlementsEnabled ? { settlementsEnabled } : {}),
        ...(settlementDueSoonDays !== settings.settlementDueSoonDays ? { settlementDueSoonDays } : {}),
        ...(settlementOverdueRepeatDays !== settings.settlementOverdueRepeatDays ? { settlementOverdueRepeatDays } : {}),
        ...(ownBookingReasonMode !== settings.ownBookingReasonMode ? { ownBookingReasonMode } : {}),
        ...(foreignBookingReasonMode !== settings.foreignBookingReasonMode ? { foreignBookingReasonMode } : {}),
        ...(ownPaymentReasonMode !== settings.ownPaymentReasonMode ? { ownPaymentReasonMode } : {}),
        ...(otherPaymentReasonMode !== settings.otherPaymentReasonMode ? { otherPaymentReasonMode } : {}),
        ...(JSON.stringify(paymentMethods) !== JSON.stringify(settings.paymentMethods) ? { paymentMethods: paymentMethodUpdates(paymentMethods, settings.paymentMethods, settings.externalAccountsEnabled === true) } : {}),
        ...(JSON.stringify(bookingReasons) !== JSON.stringify(settings.bookingReasons) ? { bookingReasons } : {}),
        ...(JSON.stringify(paymentReasons) !== JSON.stringify(settings.paymentReasons) ? { paymentReasons } : {}),
      };
      return api.updateGroupSettings(groupId, update);
    },
    onSuccess: async (persisted) => {
      queryClient.setQueryData<GroupSettings>(['group-settings', groupId], persisted);
      await invalidateFinanceSettingsConsumers(queryClient, groupId);
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: ['group-settings', groupId] });
    },
  });

  const removalMutation = useMutation({
    mutationFn: async (methodId: string) => {
      const latest = await api.getGroupSettings(groupId);
      const remaining = latest.paymentMethods.filter((method) => method.id !== methodId);
      if (remaining.length === latest.paymentMethods.length) return latest;
      if (remaining.length === 0) throw new Error(t('behaviorSettings.paymentMethodRequired'));
      return api.updateGroupSettings(groupId, { paymentMethods: remaining });
    },
    onSuccess: async (persisted) => {
      setPendingRemovalId(null);
      queryClient.setQueryData<GroupSettings>(['group-settings', groupId], persisted);
      await invalidateFinanceSettingsConsumers(queryClient, groupId);
    },
  });

  const requestPaymentMethodRemoval = (method: PaymentMethod) => {
    if (!settings.paymentMethods.some((persisted) => persisted.id === method.id)) {
      setPaymentMethods((current) => current.filter((item) => item.id !== method.id));
      mutation.reset();
      return;
    }
    removalMutation.reset();
    setPendingRemovalId(method.id);
  };

  return (
    <div className={styles.form}>
      <section aria-labelledby="group-settings-section-title" className={styles.settingsSection}>
        <header><h3 id="group-settings-section-title">{t('behaviorSettings.groupSectionTitle')}</h3></header>
        {canManageGroup ? <GroupSettingsPanel embedded /> : null}
        {canManageGroup ? <DefaultThemeSetting groupId={groupId} key={`${groupId}:${settings.defaultTheme}`} settings={settings} /> : null}
        {canManageDefaultRole && roles ? <DefaultRoleSetting groupId={groupId} key={`${groupId}:${settings.defaultRoleId ?? ''}`} roles={roles} settings={settings} /> : null}
        {canManageGroup ? <PlanningSettingsSection groupId={groupId} /> : null}
      </section>

      {canManageFinancialSettings || canManageExternalAccounts ? <section aria-labelledby="finance-settings-title" className={styles.settingsSection}>
        <header><h3 id="finance-settings-title">{t('behaviorSettings.financeSectionTitle')}</h3></header>
        {canManageFinancialSettings ? <section className={styles.card}>
          <PaymentMethodEditor addLabel={t('behaviorSettings.addPaymentMethod')} currency={currency} emptyLabel={t('behaviorSettings.paymentMethodRequired')} externalAccountsEnabled={settings.externalAccountsEnabled} items={paymentMethods} label={t('behaviorSettings.paymentMethods')} onChange={(items) => { setPaymentMethods(items); mutation.reset(); }} onRemove={requestPaymentMethodRemoval} />
          <ConfirmationDialog
            confirmIcon={<Trash2 size={17} />}
            confirmLabel={t('behaviorSettings.removePaymentMethodConfirm')}
            errorMessage={removalMutation.isError ? t('behaviorSettings.removePaymentMethodError') : undefined}
            message={<>
              {t(pendingRemoval?.externalAccountId ? 'behaviorSettings.removePaymentMethodLinkedImpact' : 'behaviorSettings.removePaymentMethodImpact', { name: pendingRemoval?.label })}
              {changed ? <p className={styles.error}>{t('behaviorSettings.removePaymentMethodUnsavedWarning')}</p> : null}
            </>}
            onClose={() => { setPendingRemovalId(null); removalMutation.reset(); }}
            onConfirm={() => { if (pendingRemoval) removalMutation.mutate(pendingRemoval.id); }}
            open={Boolean(pendingRemoval)}
            pending={removalMutation.isPending}
            title={t('behaviorSettings.removePaymentMethodTitle')}
            tone="danger"
          />
        </section> : null}
        {canManageGroup ? <section aria-labelledby="external-accounts-feature-title" className={`${styles.card} ${styles.externalAccountsCard}`}>
          <ExternalAccountsFeatureSetting groupId={groupId} key={`external-accounts:${groupId}:${settings.externalAccountsEnabled}`} settings={settings} unsavedChanges={changed} />
          {canManageExternalAccounts && externalAccounts ? <ExternalAccountConfigurationActions accounts={externalAccounts} currency={currency} groupId={groupId} paymentMethods={settings.paymentMethods} /> : null}
        </section> : canManageExternalAccounts && externalAccounts ? <section className={styles.card}><ExternalAccountConfigurationActions accounts={externalAccounts} currency={currency} groupId={groupId} paymentMethods={settings.paymentMethods} /></section> : null}
        {canManageFinancialSettings ? <section aria-labelledby="settlements-setting-title" className={styles.card}>
          <div className={styles.settingRow}>
            <div>
              <h4 id="settlements-setting-title">{t('behaviorSettings.settlementsTitle')}</h4>
              <p>{t('behaviorSettings.settlementsDescription')}</p>
            </div>
            <Toggle checked={settlementsEnabled} disabled={mutation.isPending} label={t('behaviorSettings.settlementsToggle')} onChange={(checked) => {
              mutation.reset();
              if (checked) setSettlementsEnabled(true);
              else setConfirmDisableSettlements(true);
            }} />
          </div>
          <p className={styles.notice}>{t(settlementsEnabled ? 'behaviorSettings.settlementsEnabledNotice' : 'behaviorSettings.settlementsDisabledNotice')}</p>
          <div className={styles.settlementReminderGrid}>
            <Field hint={t('behaviorSettings.settlementDueSoonDaysHint')} htmlFor="settlement-due-soon-days" label={t('behaviorSettings.settlementDueSoonDays')}>
              <TextInput disabled={!settlementsEnabled || mutation.isPending} id="settlement-due-soon-days" max={30} min={1} onChange={(event) => { setSettlementDueSoonDays(event.target.valueAsNumber); mutation.reset(); }} required step={1} type="number" value={settlementDueSoonDays} />
            </Field>
            <Field hint={t('behaviorSettings.settlementOverdueRepeatDaysHint')} htmlFor="settlement-overdue-repeat-days" label={t('behaviorSettings.settlementOverdueRepeatDays')}>
              <TextInput disabled={!settlementsEnabled || mutation.isPending} id="settlement-overdue-repeat-days" max={90} min={0} onChange={(event) => { setSettlementOverdueRepeatDays(event.target.valueAsNumber); mutation.reset(); }} required step={1} type="number" value={settlementOverdueRepeatDays} />
            </Field>
          </div>
          <ConfirmationDialog
            confirmIcon={<ReceiptText size={17} />}
            confirmLabel={t('behaviorSettings.settlementsDisable')}
            message={t('behaviorSettings.settlementsDisableImpact')}
            onClose={() => setConfirmDisableSettlements(false)}
            onConfirm={() => {
              setSettlementsEnabled(false);
              setConfirmDisableSettlements(false);
            }}
            open={confirmDisableSettlements}
            pending={mutation.isPending}
            title={t('behaviorSettings.settlementsDisableTitle')}
            tone="danger"
          />
        </section> : null}
        {canManageGroup ? <StatisticsFeatureSetting groupId={groupId} key={`statistics:${groupId}:${settings.statisticsEnabled}`} settings={settings} /> : null}
      </section> : null}

      {canManageFinancialSettings ? <section aria-labelledby="booking-settings-title" className={styles.bookingSection}>
        <header><h3 id="booking-settings-title">{t('behaviorSettings.bookingTitle')}</h3></header>
        <section className={styles.card}>
          <h4 className={styles.cardTitle}>{t('behaviorSettings.reasonRulesTitle')}</h4>
          <p className={styles.cardDescription}>{t('behaviorSettings.reasonRulesDescription')}</p>
          <div className={styles.ruleList}>
            <div className={`${styles.settingRow} ${styles.reasonRule}`}><span>{t('behaviorSettings.ownBookingReason')}</span><ReasonModeControl disabled={mutation.isPending} id="own-booking-reason-mode" label={t('behaviorSettings.ownBookingReason')} onChange={(value) => { setOwnBookingReasonMode(value); mutation.reset(); }} value={ownBookingReasonMode} /></div>
            <div className={`${styles.settingRow} ${styles.reasonRule}`}><span>{t('behaviorSettings.foreignBookingReason')}</span><ReasonModeControl disabled={mutation.isPending} id="foreign-booking-reason-mode" label={t('behaviorSettings.foreignBookingReason')} onChange={(value) => { setForeignBookingReasonMode(value); mutation.reset(); }} value={foreignBookingReasonMode} /></div>
            <div className={`${styles.settingRow} ${styles.reasonRule}`}><span>{t('behaviorSettings.ownPaymentReason')}</span><ReasonModeControl disabled={mutation.isPending} id="own-payment-reason-mode" label={t('behaviorSettings.ownPaymentReason')} onChange={(value) => { setOwnPaymentReasonMode(value); mutation.reset(); }} value={ownPaymentReasonMode} /></div>
            <div className={`${styles.settingRow} ${styles.reasonRule}`}><span>{t('behaviorSettings.otherPaymentReason')}</span><ReasonModeControl disabled={mutation.isPending} id="other-payment-reason-mode" label={t('behaviorSettings.otherPaymentReason')} onChange={(value) => { setOtherPaymentReasonMode(value); mutation.reset(); }} value={otherPaymentReasonMode} /></div>
          </div>
        </section>
        <section className={styles.card}>
          <ConfigurableListEditor addLabel={t('behaviorSettings.addBookingReason')} emptyLabel={t('behaviorSettings.noReasonSuggestions')} items={bookingReasons} label={t('behaviorSettings.bookingReasons')} onChange={(items) => { setBookingReasons(items); mutation.reset(); }} />
        </section>
        <section className={styles.card}>
          <ConfigurableListEditor addLabel={t('behaviorSettings.addPaymentReason')} emptyLabel={t('behaviorSettings.noReasonSuggestions')} items={paymentReasons} label={t('behaviorSettings.paymentReasons')} onChange={(items) => { setPaymentReasons(items); mutation.reset(); }} />
        </section>
      </section> : null}

      {canManageFinancialSettings ? <div className={styles.formFooter}>
        <div className={styles.feedback}>
          {mutation.isError ? <p className={styles.error} role="alert">{t('behaviorSettings.saveError')} {mutation.error.message}</p> : null}
          {mutation.isSuccess ? <p className={styles.success} role="status">{t('behaviorSettings.saved')}</p> : null}
        </div>
        <div className={styles.actions}><Button disabled={!changed || configurationInvalid || mutation.isPending} leadingIcon={<Save size={17} />} onClick={() => mutation.mutate()} type="button">{mutation.isPending ? t('behaviorSettings.saving') : t('behaviorSettings.save')}</Button></div>
      </div> : null}
    </div>
  );
}

/**
 * Loads and renders administrator-only group behavior settings.
 *
 * @returns Group settings content or a localized query state.
 */
export function BehaviorSettingsPanel() {
  const { t } = useTranslation();
  const { activeGroup, activeGroupId } = useActiveGroup();
  const canManageGroup = can(activeGroup.membership?.effectiveGrants, 'GROUP_ADMINISTRATION');
  const canManageDefaultRole = canManageGroup || can(activeGroup.membership?.effectiveGrants, 'ROLE_MANAGEMENT');
  const canManageFinancialSettings = canManageGroup || can(activeGroup.membership?.effectiveGrants, 'FINANCE_MANAGEMENT');
  const canManageExternalAccounts = activeGroup.externalAccountsEnabled === true && can(activeGroup.membership?.effectiveGrants, 'MANAGE_EXTERNAL_ACCOUNTS');
  const canViewExternalAccounts = activeGroup.externalAccountsEnabled === true && can(activeGroup.membership?.effectiveGrants, 'VIEW_EXTERNAL_ACCOUNTS');
  const canReadGroupSettings = canManageGroup || canManageDefaultRole || canManageFinancialSettings || can(activeGroup.membership?.effectiveGrants, 'MEMBER_MANAGEMENT');
  const settingsQuery = useQuery({ queryKey: ['group-settings', activeGroupId], queryFn: () => api.getGroupSettings(activeGroupId), enabled: canReadGroupSettings });
  const transactionSettingsQuery = useQuery({ queryKey: ['transaction-settings', activeGroupId], queryFn: () => api.getTransactionSettings(activeGroupId), enabled: canManageExternalAccounts && !canReadGroupSettings });
  const rolesQuery = useQuery({ queryKey: ['roles', activeGroupId], queryFn: () => api.getRoles(activeGroupId), enabled: canManageDefaultRole });
  const externalAccountsQuery = useQuery({ queryKey: externalAccountKeys.list(activeGroupId), queryFn: () => api.getExternalAccounts(activeGroupId), enabled: canViewExternalAccounts });

  if (canReadGroupSettings && settingsQuery.isLoading || canManageExternalAccounts && !canReadGroupSettings && transactionSettingsQuery.isLoading || canManageDefaultRole && rolesQuery.isLoading || canViewExternalAccounts && externalAccountsQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (canReadGroupSettings && (settingsQuery.isError || !settingsQuery.data) || canManageExternalAccounts && !canReadGroupSettings && (transactionSettingsQuery.isError || !transactionSettingsQuery.data) || canManageDefaultRole && (rolesQuery.isError || !rolesQuery.data) || canViewExternalAccounts && (externalAccountsQuery.isError || !externalAccountsQuery.data)) return <div className={styles.state}><StatePanel kind="error" message={t('behaviorSettings.loadError')} /></div>;

  if (!canReadGroupSettings && canManageExternalAccounts && transactionSettingsQuery.data && externalAccountsQuery.data) return <div className={styles.content}>
    <ExternalAccountSettingsSection accounts={externalAccountsQuery.data} currency={activeGroup.currency} groupId={activeGroupId} paymentMethods={transactionSettingsQuery.data.paymentMethods} />
  </div>;
  if (!settingsQuery.data) return <div className={styles.state}><StatePanel kind="error" message={t('behaviorSettings.loadError')} /></div>;

  return <div className={styles.content}>
    <SettingsForm canManageDefaultRole={canManageDefaultRole} canManageExternalAccounts={canManageExternalAccounts} canManageFinancialSettings={canManageFinancialSettings} canManageGroup={canManageGroup} currency={activeGroup.currency} externalAccounts={externalAccountsQuery.data} groupId={activeGroupId} key={`${activeGroupId}:${JSON.stringify(settingsQuery.data)}`} roles={rolesQuery.data} settings={settingsQuery.data} />
    {canManageGroup ? <KioskSettingsSection groupId={activeGroupId} key={activeGroupId} settings={settingsQuery.data} /> : null}
  </div>;
}
