import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { GroupSettings, GroupSettingsUpdateInput, ReasonMode } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { StatePanel } from '@/components/ui/StatePanel';
import { Toggle } from '@/components/ui/Toggle';
import { ConfigurableListEditor } from './ConfigurableListEditor';
import { GroupSettingsPanel } from './GroupSettingsPanel';
import styles from './BehaviorSettingsPanel.module.css';

/** Properties for the editable group behavior settings form. */
interface SettingsFormProps {
  groupId: string;
  settings: GroupSettings;
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
 * Renders grouped identity, notification, finance, and transaction settings for one group.
 *
 * @param props - Group identifier and persisted settings.
 * @returns An accessible settings form with explicit save feedback.
 */
function SettingsForm({ groupId, settings }: SettingsFormProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [settlementsEnabled, setSettlementsEnabled] = useState(settings.settlementsEnabled);
  const [notificationEmailsEnabled, setNotificationEmailsEnabled] = useState(settings.notificationEmailsEnabled);
  const [ownBookingReasonMode, setOwnBookingReasonMode] = useState(settings.ownBookingReasonMode);
  const [foreignBookingReasonMode, setForeignBookingReasonMode] = useState(settings.foreignBookingReasonMode);
  const [ownPaymentReasonMode, setOwnPaymentReasonMode] = useState(settings.ownPaymentReasonMode);
  const [otherPaymentReasonMode, setOtherPaymentReasonMode] = useState(settings.otherPaymentReasonMode);
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
        ...(notificationEmailsEnabled !== settings.notificationEmailsEnabled ? { notificationEmailsEnabled } : {}),
        ...(ownBookingReasonMode !== settings.ownBookingReasonMode ? { ownBookingReasonMode } : {}),
        ...(foreignBookingReasonMode !== settings.foreignBookingReasonMode ? { foreignBookingReasonMode } : {}),
        ...(ownPaymentReasonMode !== settings.ownPaymentReasonMode ? { ownPaymentReasonMode } : {}),
        ...(otherPaymentReasonMode !== settings.otherPaymentReasonMode ? { otherPaymentReasonMode } : {}),
        ...(JSON.stringify(paymentMethods) !== JSON.stringify(settings.paymentMethods) ? { paymentMethods } : {}),
        ...(JSON.stringify(bookingReasons) !== JSON.stringify(settings.bookingReasons) ? { bookingReasons } : {}),
        ...(JSON.stringify(paymentReasons) !== JSON.stringify(settings.paymentReasons) ? { paymentReasons } : {}),
      };
      return api.updateGroupSettings(groupId, update);
    },
    onSuccess: async (persisted) => {
      queryClient.setQueryData<GroupSettings>(['group-settings', groupId], persisted);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['booking-context', groupId] }),
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
          <p className={styles.cardDescription}>{t('behaviorSettings.reasonRulesDescription')}</p>
          <div className={styles.ruleList}>
            <div className={`${styles.settingRow} ${styles.reasonRule}`}><span>{t('behaviorSettings.ownBookingReason')}</span><ReasonModeControl disabled={mutation.isPending} id="own-booking-reason-mode" label={t('behaviorSettings.ownBookingReason')} onChange={(value) => { setOwnBookingReasonMode(value); mutation.reset(); }} value={ownBookingReasonMode} /></div>
            <div className={`${styles.settingRow} ${styles.reasonRule}`}><span>{t('behaviorSettings.foreignBookingReason')}</span><ReasonModeControl disabled={mutation.isPending} id="foreign-booking-reason-mode" label={t('behaviorSettings.foreignBookingReason')} onChange={(value) => { setForeignBookingReasonMode(value); mutation.reset(); }} value={foreignBookingReasonMode} /></div>
            <div className={`${styles.settingRow} ${styles.reasonRule}`}><span>{t('behaviorSettings.ownPaymentReason')}</span><ReasonModeControl disabled={mutation.isPending} id="own-payment-reason-mode" label={t('behaviorSettings.ownPaymentReason')} onChange={(value) => { setOwnPaymentReasonMode(value); mutation.reset(); }} value={ownPaymentReasonMode} /></div>
            <div className={`${styles.settingRow} ${styles.reasonRule}`}><span>{t('behaviorSettings.otherPaymentReason')}</span><ReasonModeControl disabled={mutation.isPending} id="other-payment-reason-mode" label={t('behaviorSettings.otherPaymentReason')} onChange={(value) => { setOtherPaymentReasonMode(value); mutation.reset(); }} value={otherPaymentReasonMode} /></div>
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

  if (settingsQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (settingsQuery.isError || !settingsQuery.data) return <div className={styles.state}><StatePanel kind="error" message={t('behaviorSettings.loadError')} /></div>;

  return <div className={styles.content}>
    <SettingsForm groupId={activeGroupId} key={`${activeGroupId}:${JSON.stringify(settingsQuery.data)}`} settings={settingsQuery.data} />
  </div>;
}
