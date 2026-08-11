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
import { ConfigurableListEditor } from './ConfigurableListEditor';
import { GroupSettingsPanel } from './GroupSettingsPanel';
import { roleDisplayName } from './roleDisplayName';
import styles from './BehaviorSettingsPanel.module.css';

/** Properties for the editable group behavior settings form. */
interface SettingsFormProps {
  groupId: string;
  settings: GroupSettings;
  roles: Role[];
}

/**
 * Renders grouped identity, notification, role-policy, and transaction settings for one group.
 *
 * @param props - Group identifier, persisted settings, and available roles.
 * @returns An accessible settings form with explicit save feedback.
 */
function SettingsForm({ groupId, settings, roles }: SettingsFormProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const defaultRoleCandidates = roles.filter((role) => !role.grants.some((grant) => grant.permission === 'GROUP_ADMINISTRATION'));
  const [settlementsEnabled, setSettlementsEnabled] = useState(settings.settlementsEnabled);
  const [notificationEmailsEnabled, setNotificationEmailsEnabled] = useState(settings.notificationEmailsEnabled);
  const [defaultRoleId, setDefaultRoleId] = useState(settings.defaultRoleId ?? '');
  const [foreignBookingReasonRequired, setForeignBookingReasonRequired] = useState(settings.foreignBookingReasonRequired);
  const [ownPaymentReasonRequired, setOwnPaymentReasonRequired] = useState(settings.ownPaymentReasonRequired);
  const [otherPaymentReasonRequired, setOtherPaymentReasonRequired] = useState(settings.otherPaymentReasonRequired);
  const [paymentMethods, setPaymentMethods] = useState(settings.paymentMethods);
  const [bookingReasons, setBookingReasons] = useState(settings.bookingReasons);
  const [paymentReasons, setPaymentReasons] = useState(settings.paymentReasons);
  const configurableCollections = [paymentMethods, bookingReasons, paymentReasons];
  const configurationInvalid = paymentMethods.length === 0 || configurableCollections.some((items) => {
    const labels = items.map((item) => item.label.trim().toLocaleLowerCase());
    return labels.some((label) => !label) || new Set(labels).size !== labels.length;
  });
  const changed = settlementsEnabled !== settings.settlementsEnabled
    || notificationEmailsEnabled !== settings.notificationEmailsEnabled
    || Boolean(defaultRoleId && defaultRoleId !== settings.defaultRoleId)
    || foreignBookingReasonRequired !== settings.foreignBookingReasonRequired
    || ownPaymentReasonRequired !== settings.ownPaymentReasonRequired
    || otherPaymentReasonRequired !== settings.otherPaymentReasonRequired
    || JSON.stringify(paymentMethods) !== JSON.stringify(settings.paymentMethods)
    || JSON.stringify(bookingReasons) !== JSON.stringify(settings.bookingReasons)
    || JSON.stringify(paymentReasons) !== JSON.stringify(settings.paymentReasons);

  const mutation = useMutation({
    mutationFn: () => {
      const update: GroupSettingsUpdateInput = {
        ...(settlementsEnabled !== settings.settlementsEnabled ? { settlementsEnabled } : {}),
        ...(notificationEmailsEnabled !== settings.notificationEmailsEnabled ? { notificationEmailsEnabled } : {}),
        ...(defaultRoleId && defaultRoleId !== settings.defaultRoleId ? { defaultRoleId } : {}),
        ...(foreignBookingReasonRequired !== settings.foreignBookingReasonRequired ? { foreignBookingReasonRequired } : {}),
        ...(ownPaymentReasonRequired !== settings.ownPaymentReasonRequired ? { ownPaymentReasonRequired } : {}),
        ...(otherPaymentReasonRequired !== settings.otherPaymentReasonRequired ? { otherPaymentReasonRequired } : {}),
        ...(JSON.stringify(paymentMethods) !== JSON.stringify(settings.paymentMethods) ? { paymentMethods } : {}),
        ...(JSON.stringify(bookingReasons) !== JSON.stringify(settings.bookingReasons) ? { bookingReasons } : {}),
        ...(JSON.stringify(paymentReasons) !== JSON.stringify(settings.paymentReasons) ? { paymentReasons } : {}),
      };
      return api.updateGroupSettings(groupId, update);
    },
    onSuccess: async (persisted) => {
      queryClient.setQueryData<GroupSettings>(['group-settings', groupId], persisted);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['transaction-settings', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['periods', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['settlements', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['roles', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['members', groupId] }),
      ]);
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: ['group-settings', groupId] });
    },
  });

  return (
    <div className={styles.form}>
      <section aria-labelledby="group-settings-section-title" className={styles.settingsSection}>
        <header><h3 id="group-settings-section-title">{t('behaviorSettings.groupSectionTitle')}</h3></header>
        <GroupSettingsPanel embedded />
        <section aria-labelledby="notification-email-setting-title" className={styles.card}>
          <div className={styles.settingRow}>
            <div>
              <h4 id="notification-email-setting-title">{t('behaviorSettings.notificationEmailTitle')}</h4>
              <p>{t('behaviorSettings.notificationEmailDescription')}</p>
            </div>
            <Toggle checked={notificationEmailsEnabled} disabled={mutation.isPending || !settings.notificationEmailDeliveryAvailable} label={t('behaviorSettings.notificationEmailToggle')} onChange={(checked) => { setNotificationEmailsEnabled(checked); mutation.reset(); }} />
          </div>
          <p className={styles.notice}>{settings.notificationEmailDeliveryAvailable ? t('behaviorSettings.notificationEmailNotice') : settings.notificationEmailsEnabled ? t('behaviorSettings.notificationEmailTemporarilyUnavailable') : t('behaviorSettings.notificationEmailUnavailable')}</p>
        </section>
      </section>

      <section aria-labelledby="roles-members-settings-title" className={styles.settingsSection}>
        <header><h3 id="roles-members-settings-title">{t('behaviorSettings.rolesMembersSectionTitle')}</h3></header>
        <section aria-labelledby="default-role-setting-title" className={styles.card}>
          <h4 className={styles.cardTitle} id="default-role-setting-title">{t('behaviorSettings.defaultRoleTitle')}</h4>
          <Field hint={!settings.defaultRoleId ? t('behaviorSettings.defaultRoleMissing') : undefined} htmlFor="default-membership-role" label={t('behaviorSettings.defaultRoleFieldLabel')}>
            <SelectInput id="default-membership-role" onChange={(event) => { setDefaultRoleId(event.target.value); mutation.reset(); }} value={defaultRoleId}>
              <option disabled value="">{t('behaviorSettings.defaultRolePlaceholder')}</option>
              {defaultRoleCandidates.map((role) => <option key={role.id} value={role.id}>{roleDisplayName(role)}</option>)}
            </SelectInput>
          </Field>
        </section>
      </section>

      <section aria-labelledby="finance-settings-title" className={styles.settingsSection}>
        <header><h3 id="finance-settings-title">{t('behaviorSettings.financeSectionTitle')}</h3></header>
        <section aria-labelledby="settlements-setting-title" className={styles.card}>
          <div className={styles.settingRow}>
            <div>
              <h4 id="settlements-setting-title">{t('behaviorSettings.settlementsTitle')}</h4>
              <p>{t('behaviorSettings.settlementsDescription')}</p>
            </div>
            <Toggle checked={settlementsEnabled} disabled={mutation.isPending} label={t('behaviorSettings.settlementsToggle')} onChange={(checked) => { setSettlementsEnabled(checked); mutation.reset(); }} />
          </div>
          <p className={styles.notice}>{t(settlementsEnabled ? 'behaviorSettings.settlementsEnabledNotice' : 'behaviorSettings.settlementsDisabledNotice')}</p>
        </section>
      </section>

      <section aria-labelledby="booking-settings-title" className={styles.bookingSection}>
        <header><h3 id="booking-settings-title">{t('behaviorSettings.bookingTitle')}</h3></header>
        <section className={styles.card}>
          <h4 className={styles.cardTitle}>{t('behaviorSettings.reasonRulesTitle')}</h4>
          <div className={styles.ruleList}>
            <div className={styles.settingRow}><span>{t('behaviorSettings.foreignBookingReason')}</span><Toggle checked={foreignBookingReasonRequired} label={t('behaviorSettings.foreignBookingReason')} onChange={(value) => { setForeignBookingReasonRequired(value); mutation.reset(); }} /></div>
            <div className={styles.settingRow}><span>{t('behaviorSettings.ownPaymentReason')}</span><Toggle checked={ownPaymentReasonRequired} label={t('behaviorSettings.ownPaymentReason')} onChange={(value) => { setOwnPaymentReasonRequired(value); mutation.reset(); }} /></div>
            <div className={styles.settingRow}><span>{t('behaviorSettings.otherPaymentReason')}</span><Toggle checked={otherPaymentReasonRequired} label={t('behaviorSettings.otherPaymentReason')} onChange={(value) => { setOtherPaymentReasonRequired(value); mutation.reset(); }} /></div>
          </div>
        </section>
        <section className={styles.card}>
          <ConfigurableListEditor addLabel={t('behaviorSettings.addPaymentMethod')} emptyLabel={t('behaviorSettings.paymentMethodRequired')} items={paymentMethods} label={t('behaviorSettings.paymentMethods')} minimumItems={1} onChange={(items) => { setPaymentMethods(items); mutation.reset(); }} />
        </section>
        <section className={styles.card}>
          <ConfigurableListEditor addLabel={t('behaviorSettings.addBookingReason')} emptyLabel={t('behaviorSettings.noReasonSuggestions')} items={bookingReasons} label={t('behaviorSettings.bookingReasons')} onChange={(items) => { setBookingReasons(items); mutation.reset(); }} />
        </section>
        <section className={styles.card}>
          <ConfigurableListEditor addLabel={t('behaviorSettings.addPaymentReason')} emptyLabel={t('behaviorSettings.noReasonSuggestions')} items={paymentReasons} label={t('behaviorSettings.paymentReasons')} onChange={(items) => { setPaymentReasons(items); mutation.reset(); }} />
        </section>
      </section>

      <div className={styles.formFooter}>
        <div className={styles.feedback}>
          {mutation.isError ? <p className={styles.error} role="alert">{t('behaviorSettings.saveError')} {mutation.error.message}</p> : null}
          {mutation.isSuccess ? <p className={styles.success} role="status">{t('behaviorSettings.saved')}</p> : null}
        </div>
        <div className={styles.actions}><Button disabled={!changed || configurationInvalid || mutation.isPending} onClick={() => mutation.mutate()} type="button">{mutation.isPending ? t('behaviorSettings.saving') : t('behaviorSettings.save')}</Button></div>
      </div>
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
  const { activeGroupId } = useActiveGroup();
  const settingsQuery = useQuery({ queryKey: ['group-settings', activeGroupId], queryFn: () => api.getGroupSettings(activeGroupId) });
  const rolesQuery = useQuery({ queryKey: ['roles', activeGroupId], queryFn: () => api.getRoles(activeGroupId) });

  if (settingsQuery.isLoading || rolesQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (settingsQuery.isError || rolesQuery.isError || !settingsQuery.data || !rolesQuery.data) return <div className={styles.state}><StatePanel kind="error" message={t('behaviorSettings.loadError')} /></div>;

  return <div className={styles.content}>
    <header className={styles.header}><h2>{t('behaviorSettings.title')}</h2></header>
    <SettingsForm groupId={activeGroupId} key={`${activeGroupId}:${JSON.stringify(settingsQuery.data)}`} roles={rolesQuery.data} settings={settingsQuery.data} />
  </div>;
}
