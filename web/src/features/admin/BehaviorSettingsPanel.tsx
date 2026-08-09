import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { GroupSettings, GroupSettingsUpdateInput, Role } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput } from '@/components/ui/FormField';
import { StatePanel } from '@/components/ui/StatePanel';
import { Toggle } from '@/components/ui/Toggle';
import { roleDisplayName } from './roleDisplayName';
import styles from './BehaviorSettingsPanel.module.css';

/** Properties for the editable group behavior settings form. */
interface SettingsFormProps {
  groupId: string;
  settings: GroupSettings;
  roles: Role[];
}

/**
 * Renders notification and default-role settings for one group.
 *
 * @param props - Group identifier, persisted settings, and available roles.
 * @returns An accessible settings form with explicit save feedback.
 */
function SettingsForm({ groupId, settings, roles }: SettingsFormProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const defaultRoleCandidates = roles.filter((role) => !role.grants.some((grant) => grant.permission === 'GROUP_ADMINISTRATION'));
  const [notificationEmailsEnabled, setNotificationEmailsEnabled] = useState(settings.notificationEmailsEnabled);
  const [defaultRoleId, setDefaultRoleId] = useState(settings.defaultRoleId ?? '');
  const changed = notificationEmailsEnabled !== settings.notificationEmailsEnabled
    || Boolean(defaultRoleId && defaultRoleId !== settings.defaultRoleId);

  const mutation = useMutation({
    mutationFn: () => {
      const update: GroupSettingsUpdateInput = {
        ...(notificationEmailsEnabled !== settings.notificationEmailsEnabled ? { notificationEmailsEnabled } : {}),
        ...(defaultRoleId && defaultRoleId !== settings.defaultRoleId ? { defaultRoleId } : {}),
      };
      return api.updateGroupSettings(groupId, update);
    },
    onSuccess: async (persisted) => {
      queryClient.setQueryData<GroupSettings>(['group-settings', groupId], persisted);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['roles', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['members', groupId] }),
      ]);
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: ['group-settings', groupId] });
    },
  });

  return (
    <form className={styles.form} onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
      <section aria-labelledby="notification-email-setting-title" className={styles.card}>
        <div className={styles.settingRow}>
          <div>
            <h3 id="notification-email-setting-title">{t('behaviorSettings.notificationEmailTitle')}</h3>
            <p>{t('behaviorSettings.notificationEmailDescription')}</p>
          </div>
          <Toggle checked={notificationEmailsEnabled} disabled={mutation.isPending || !settings.notificationEmailDeliveryAvailable} label={t('behaviorSettings.notificationEmailToggle')} onChange={(checked) => { setNotificationEmailsEnabled(checked); mutation.reset(); }} />
        </div>
        <p className={styles.notice}>{settings.notificationEmailDeliveryAvailable ? t('behaviorSettings.notificationEmailNotice') : settings.notificationEmailsEnabled ? t('behaviorSettings.notificationEmailTemporarilyUnavailable') : t('behaviorSettings.notificationEmailUnavailable')}</p>
      </section>

      <section aria-labelledby="default-role-setting-title" className={styles.card}>
        <h3 className={styles.cardTitle} id="default-role-setting-title">{t('behaviorSettings.defaultRoleTitle')}</h3>
        <Field hint={settings.defaultRoleId ? t('behaviorSettings.defaultRoleHint') : t('behaviorSettings.defaultRoleMissing')} htmlFor="default-membership-role" label={t('behaviorSettings.defaultRoleFieldLabel')}>
          <SelectInput id="default-membership-role" onChange={(event) => { setDefaultRoleId(event.target.value); mutation.reset(); }} value={defaultRoleId}>
            <option disabled value="">{t('behaviorSettings.defaultRolePlaceholder')}</option>
            {defaultRoleCandidates.map((role) => <option key={role.id} value={role.id}>{roleDisplayName(role)}</option>)}
          </SelectInput>
        </Field>
      </section>

      <div className={styles.formFooter}>
        <div className={styles.feedback}>
          {mutation.isError ? <p className={styles.error} role="alert">{t('behaviorSettings.saveError')} {mutation.error.message}</p> : null}
          {mutation.isSuccess ? <p className={styles.success} role="status">{t('behaviorSettings.saved')}</p> : null}
        </div>
        <div className={styles.actions}><Button disabled={!changed || mutation.isPending} type="submit">{mutation.isPending ? t('behaviorSettings.saving') : t('behaviorSettings.save')}</Button></div>
      </div>
    </form>
  );
}

/**
 * Loads and renders administrator-only group behavior settings.
 *
 * @returns Group settings content or a localized query state.
 */
export function BehaviorSettingsPanel() {
  const { t } = useTranslation();
  const { activeGroupId } = useActiveGroup();
  const settingsQuery = useQuery({ queryKey: ['group-settings', activeGroupId], queryFn: () => api.getGroupSettings(activeGroupId) });
  const rolesQuery = useQuery({ queryKey: ['roles', activeGroupId], queryFn: () => api.getRoles(activeGroupId) });

  if (settingsQuery.isLoading || rolesQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (settingsQuery.isError || rolesQuery.isError || !settingsQuery.data || !rolesQuery.data) return <div className={styles.state}><StatePanel kind="error" message={t('behaviorSettings.loadError')} /></div>;

  return <div className={styles.content}>
    <header className={styles.header}><h2>{t('behaviorSettings.title')}</h2></header>
    <SettingsForm groupId={activeGroupId} key={`${activeGroupId}:${settingsQuery.data.defaultRoleId ?? 'none'}`} roles={rolesQuery.data} settings={settingsQuery.data} />
  </div>;
}
