import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Save from 'lucide-react/dist/esm/icons/save';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { ExternalAccountCollection, GroupSettings, PaymentMethod, Role, Session, ThemeId } from '@/api/types';
import { can } from '@/app/permissions';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/FormField';
import { SelectMenu } from '@/components/ui/SelectMenu';
import { StatePanel } from '@/components/ui/StatePanel';
import { ThemePicker } from '@/features/appearance/ThemePicker';
import { ExternalAccountConfigurationActions } from '@/features/externalAccounts/ExternalAccountConfigurationActions';
import { externalAccountKeys } from '@/features/externalAccounts/externalAccountQueryKeys';
import { GroupFinanceSettings } from './GroupFinanceSettings';
import { groupSettingsMutationScope } from './groupSettingsMutation';
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

/** Renders the external-account configuration entry points inside finance settings. */
function ExternalAccountSettingsSection({ accounts, currency, groupId, paymentMethods }: ExternalAccountSettingsSectionProps) {
  const { t } = useTranslation();
  return <section aria-labelledby="external-account-settings-title" className={styles.settingsSection}>
    <header><h3 id="external-account-settings-title">{t('behaviorSettings.financeSectionTitle')}</h3></header>
    <section className={styles.card}><ExternalAccountConfigurationActions accounts={accounts} currency={currency} groupId={groupId} paymentMethods={paymentMethods} /></section>
  </section>;
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
    scope: groupSettingsMutationScope(groupId),
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
    scope: groupSettingsMutationScope(groupId),
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

/** Renders independently saved group, finance, and booking settings. */
function SettingsForm({ canManageDefaultRole, canManageExternalAccounts, canManageFinancialSettings, canManageGroup, currency, externalAccounts, groupId, roles, settings }: SettingsFormProps) {
  const { t } = useTranslation();
  return <div className={styles.form}>
      {canManageGroup || canManageDefaultRole ? <section aria-labelledby="group-settings-section-title" className={styles.settingsSection}>
      <header><h3 id="group-settings-section-title">{t('behaviorSettings.groupSectionTitle')}</h3></header>
      {canManageGroup ? <GroupSettingsPanel embedded /> : null}
      {canManageGroup ? <DefaultThemeSetting groupId={groupId} key={`${groupId}:${settings.defaultTheme}`} settings={settings} /> : null}
      {canManageDefaultRole && roles ? <DefaultRoleSetting groupId={groupId} key={`${groupId}:${settings.defaultRoleId ?? ''}`} roles={roles} settings={settings} /> : null}
      {canManageGroup ? <PlanningSettingsSection groupId={groupId} /> : null}
      </section> : null}
    <GroupFinanceSettings canManageExternalAccounts={canManageExternalAccounts} canManageFinancialSettings={canManageFinancialSettings} canManageGroup={canManageGroup} currency={currency} externalAccounts={externalAccounts} groupId={groupId} settings={settings} />
  </div>;
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
  const externalAccountsRequired = canManageExternalAccounts && !canReadGroupSettings;
  const settingsQuery = useQuery({ queryKey: ['group-settings', activeGroupId], queryFn: () => api.getGroupSettings(activeGroupId), enabled: canReadGroupSettings });
  const transactionSettingsQuery = useQuery({ queryKey: ['transaction-settings', activeGroupId], queryFn: () => api.getTransactionSettings(activeGroupId), enabled: canManageExternalAccounts && !canReadGroupSettings });
  const rolesQuery = useQuery({ queryKey: ['roles', activeGroupId], queryFn: () => api.getRoles(activeGroupId), enabled: canManageDefaultRole });
  const externalAccountsQuery = useQuery({ queryKey: externalAccountKeys.list(activeGroupId), queryFn: () => api.getExternalAccounts(activeGroupId), enabled: canViewExternalAccounts });

  if (canReadGroupSettings && settingsQuery.isLoading || externalAccountsRequired && (transactionSettingsQuery.isLoading || externalAccountsQuery.isLoading) || canManageDefaultRole && rolesQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (canReadGroupSettings && (settingsQuery.isError || !settingsQuery.data) || externalAccountsRequired && (transactionSettingsQuery.isError || !transactionSettingsQuery.data || externalAccountsQuery.isError || !externalAccountsQuery.data) || canManageDefaultRole && (rolesQuery.isError || !rolesQuery.data)) return <div className={styles.state}><StatePanel kind="error" message={t('behaviorSettings.loadError')} /></div>;

  if (!canReadGroupSettings && canManageExternalAccounts && transactionSettingsQuery.data && externalAccountsQuery.data) return <div className={styles.content}>
    <ExternalAccountSettingsSection accounts={externalAccountsQuery.data} currency={activeGroup.currency} groupId={activeGroupId} paymentMethods={transactionSettingsQuery.data.paymentMethods} />
  </div>;
  if (!settingsQuery.data) return <div className={styles.state}><StatePanel kind="error" message={t('behaviorSettings.loadError')} /></div>;

  return <div className={styles.content}>
    <SettingsForm canManageDefaultRole={canManageDefaultRole} canManageExternalAccounts={canManageExternalAccounts} canManageFinancialSettings={canManageFinancialSettings} canManageGroup={canManageGroup} currency={activeGroup.currency} externalAccounts={externalAccountsQuery.data} groupId={activeGroupId} key={activeGroupId} roles={rolesQuery.data} settings={settingsQuery.data} />
    {canManageGroup ? <KioskSettingsSection groupId={activeGroupId} key={`kiosk-${activeGroupId}`} settings={settingsQuery.data} /> : null}
  </div>;
}
