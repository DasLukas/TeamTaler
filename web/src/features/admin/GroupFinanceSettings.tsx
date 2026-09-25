import { useMutation, useQueryClient } from '@tanstack/react-query';
import ChartNoAxesCombined from 'lucide-react/dist/esm/icons/chart-no-axes-combined';
import ReceiptText from 'lucide-react/dist/esm/icons/receipt-text';
import Save from 'lucide-react/dist/esm/icons/save';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import WalletCards from 'lucide-react/dist/esm/icons/wallet-cards';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { ExternalAccountCollection, GroupSettings, GroupSettingsUpdateInput, PaymentMethod, PaymentMethodUpdate, ReasonMode, Session } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { Field, TextInput } from '@/components/ui/FormField';
import { Toggle } from '@/components/ui/Toggle';
import { ExternalAccountConfigurationActions } from '@/features/externalAccounts/ExternalAccountConfigurationActions';
import { isPaymentTargetValid } from '@/features/finance/paymentTargets';
import { ConfigurableListEditor } from './ConfigurableListEditor';
import { groupSettingsMutationScope, invalidateGroupSettingsConsumers, useGroupSettingsPatch } from './groupSettingsMutation';
import { PaymentMethodEditor } from './PaymentMethodEditor';
import { useSyncedSettingsDraft } from './useSyncedSettingsDraft';
import styles from './BehaviorSettingsPanel.module.css';

/** Properties of the independently saved finance and booking configuration. */
export interface GroupFinanceSettingsProps {
  canManageExternalAccounts: boolean;
  canManageFinancialSettings: boolean;
  canManageGroup: boolean;
  currency: string;
  externalAccounts?: ExternalAccountCollection;
  groupId: string;
  settings: GroupSettings;
}

type ReasonSettingKey = 'ownBookingReasonMode' | 'foreignBookingReasonMode' | 'ownPaymentReasonMode' | 'otherPaymentReasonMode';
type ReasonListKey = 'bookingReasons' | 'paymentReasons';

/** Keeps legacy payment-target edits separate from explicit external-account links. */
function paymentMethodUpdates(current: PaymentMethod[], persisted: PaymentMethod[], externalAccountsEnabled: boolean): PaymentMethodUpdate[] {
  const persistedById = new Map(persisted.map((method) => [method.id, method]));
  return current.map((method) => {
    const previousTarget = persistedById.get(method.id)?.paymentTarget ?? null;
    if (externalAccountsEnabled || JSON.stringify(previousTarget) === JSON.stringify(method.paymentTarget)) return method;
    return { id: method.id, label: method.label, attachmentMode: method.attachmentMode, paymentTarget: method.paymentTarget };
  });
}

/** Validates labels in an ordered settings collection before saving the complete list. */
function hasInvalidLabels(items: Array<{ label: string }>): boolean {
  const labels = items.map((item) => item.label.trim().toLocaleLowerCase());
  return labels.some((label) => !label) || new Set(labels).size !== labels.length;
}

/** Renders local save feedback without moving it to the bottom of the settings page. */
function SaveFeedback({ error, success }: { error?: string; success: boolean }) {
  const { t } = useTranslation();
  return <>
    {error ? <p className={styles.error} role="alert">{t('behaviorSettings.saveError')} {error}</p> : null}
    {success ? <p className={styles.success} role="status">{t('behaviorSettings.saved')}</p> : null}
  </>;
}

/** Renders a save action whose accessible name identifies its settings card. */
function SectionSaveButton({ disabled, onClick, pending, section }: { disabled: boolean; onClick: () => void; pending: boolean; section: string }) {
  const { t } = useTranslation();
  return <div className={styles.actions}><Button aria-label={t('behaviorSettings.saveSection', { section })} disabled={disabled || pending} leadingIcon={<Save size={17} />} onClick={onClick} type="button">{pending ? t('behaviorSettings.saving') : t('common.save')}</Button></div>;
}

/** Edits payment methods as one validated, independently saved collection. */
function PaymentMethodsSetting({ currency, groupId, onDirtyChange, settings }: { currency: string; groupId: string; onDirtyChange: (dirty: boolean) => void; settings: GroupSettings }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [paymentMethods, setPaymentMethods] = useSyncedSettingsDraft(settings.paymentMethods);
  const [pendingRemovalId, setPendingRemovalId] = useState<string | null>(null);
  const mutation = useGroupSettingsPatch(groupId);
  const changed = JSON.stringify(paymentMethods) !== JSON.stringify(settings.paymentMethods);
  const invalid = paymentMethods.length === 0 || hasInvalidLabels(paymentMethods) || paymentMethods.some((method) => !isPaymentTargetValid(method.paymentTarget, currency));
  const pendingRemoval = paymentMethods.find((method) => method.id === pendingRemovalId);

  useEffect(() => onDirtyChange(changed), [changed, onDirtyChange]);

  const removalMutation = useMutation({
    scope: groupSettingsMutationScope(groupId),
    mutationFn: async (methodId: string) => {
      const latest = await api.getGroupSettings(groupId);
      const remaining = latest.paymentMethods.filter((method) => method.id !== methodId);
      if (remaining.length === latest.paymentMethods.length) return latest;
      if (remaining.length === 0) throw new Error(t('behaviorSettings.paymentMethodRequired'));
      return api.updateGroupSettings(groupId, { paymentMethods: remaining });
    },
    onSuccess: async (persisted) => {
      setPendingRemovalId(null);
      setPaymentMethods(persisted.paymentMethods);
      queryClient.setQueryData<GroupSettings>(['group-settings', groupId], persisted);
      await invalidateGroupSettingsConsumers(queryClient, groupId);
    },
  });
  const requestRemoval = (method: PaymentMethod) => {
    if (!settings.paymentMethods.some((persisted) => persisted.id === method.id)) {
      setPaymentMethods((current) => current.filter((item) => item.id !== method.id));
      mutation.reset();
      return;
    }
    removalMutation.reset();
    setPendingRemovalId(method.id);
  };
  const save = () => {
    const update: GroupSettingsUpdateInput = { paymentMethods: paymentMethodUpdates(paymentMethods, settings.paymentMethods, settings.externalAccountsEnabled === true) };
    mutation.mutate(update, { onSuccess: (persisted) => setPaymentMethods(persisted.paymentMethods) });
  };
  return <section className={styles.card}>
    <PaymentMethodEditor addLabel={t('behaviorSettings.addPaymentMethod')} currency={currency} emptyLabel={t('behaviorSettings.paymentMethodRequired')} externalAccountsEnabled={settings.externalAccountsEnabled} items={paymentMethods} label={t('behaviorSettings.paymentMethods')} onChange={(items) => { setPaymentMethods(items); mutation.reset(); }} onRemove={requestRemoval} />
    <SaveFeedback error={mutation.isError ? mutation.error.message : undefined} success={mutation.isSuccess && !changed} />
    <SectionSaveButton disabled={!changed || invalid || removalMutation.isPending} onClick={save} pending={mutation.isPending} section={t('behaviorSettings.paymentMethods')} />
    <ConfirmationDialog
      confirmIcon={<Trash2 size={17} />}
      confirmLabel={t('behaviorSettings.removePaymentMethodConfirm')}
      errorMessage={removalMutation.isError ? t('behaviorSettings.removePaymentMethodError') : undefined}
      message={<>{t(pendingRemoval?.externalAccountId ? 'behaviorSettings.removePaymentMethodLinkedImpact' : 'behaviorSettings.removePaymentMethodImpact', { name: pendingRemoval?.label })}{changed ? <p className={styles.error}>{t('behaviorSettings.removePaymentMethodUnsavedWarning')}</p> : null}</>}
      onClose={() => { setPendingRemovalId(null); removalMutation.reset(); }}
      onConfirm={() => { if (pendingRemoval) removalMutation.mutate(pendingRemoval.id); }}
      open={Boolean(pendingRemoval)}
      pending={removalMutation.isPending}
      title={t('behaviorSettings.removePaymentMethodTitle')}
      tone="danger"
    />
  </section>;
}

/** Renders the administrator-owned, immediately persisted external-account switch. */
function StatisticsFeatureSetting({ groupId, settings }: { groupId: string; settings: GroupSettings }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirmDisable, setConfirmDisable] = useState(false);
  const mutation = useMutation({
    scope: groupSettingsMutationScope(groupId),
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
  return <section aria-labelledby="statistics-feature-setting-title" className={styles.card}>
    <div className={styles.settingRow}><div><h4 id="statistics-feature-setting-title">{t('behaviorSettings.statisticsTitle')}</h4><p>{t('behaviorSettings.statisticsDescription')}</p></div><Toggle checked={settings.statisticsEnabled} disabled={mutation.isPending} label={t('behaviorSettings.statisticsToggle')} onChange={(enabled) => { mutation.reset(); if (enabled) mutation.mutate(true); else setConfirmDisable(true); }} /></div>
    <p className={styles.notice}>{t(settings.statisticsEnabled ? 'behaviorSettings.statisticsEnabledNotice' : 'behaviorSettings.statisticsDisabledNotice')}</p>
    {mutation.isError && !confirmDisable ? <p className={styles.error} role="alert">{t('behaviorSettings.statisticsSaveError')}</p> : null}
    <ConfirmationDialog confirmIcon={<ChartNoAxesCombined size={17} />} confirmLabel={t('behaviorSettings.statisticsDisable')} errorMessage={mutation.isError ? t('behaviorSettings.statisticsSaveError') : undefined} message={t('behaviorSettings.statisticsDisableImpact')} onClose={() => { mutation.reset(); setConfirmDisable(false); }} onConfirm={() => mutation.mutate(false)} open={confirmDisable} pending={mutation.isPending} title={t('behaviorSettings.statisticsDisableTitle')} tone="danger" />
  </section>;
}

/** Renders the administrator-owned, immediately persisted external-account switch. */
function ExternalAccountsFeatureSetting({ groupId, settings, unsavedChanges }: { groupId: string; settings: GroupSettings; unsavedChanges: boolean }) {
  const { t } = useTranslation();
  const unsavedChangesId = useId();
  const queryClient = useQueryClient();
  const [confirmDisable, setConfirmDisable] = useState(false);
  const mutation = useMutation({
    scope: groupSettingsMutationScope(groupId),
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
    <ConfirmationDialog confirmIcon={<WalletCards size={17} />} confirmLabel={t('behaviorSettings.externalAccountsDisable')} errorMessage={mutation.isError ? t('behaviorSettings.externalAccountsSaveError') : undefined} message={t('behaviorSettings.externalAccountsDisableImpact')} onClose={() => { mutation.reset(); setConfirmDisable(false); }} onConfirm={() => mutation.mutate(false)} open={confirmDisable} pending={mutation.isPending} title={t('behaviorSettings.externalAccountsDisableTitle')} tone="danger" />
  </div>;
}

interface SettlementDraft {
  settlementsEnabled: boolean;
  settlementDueSoonDays: number;
  settlementOverdueRepeatDays: number;
}

/** Saves settlement availability and reminder cadence together within their card. */
function SettlementsSetting({ groupId, settings }: { groupId: string; settings: GroupSettings }) {
  const { t } = useTranslation();
  const persisted: SettlementDraft = { settlementsEnabled: settings.settlementsEnabled, settlementDueSoonDays: settings.settlementDueSoonDays, settlementOverdueRepeatDays: settings.settlementOverdueRepeatDays };
  const [draft, setDraft] = useSyncedSettingsDraft(persisted);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const mutation = useGroupSettingsPatch(groupId);
  const changed = JSON.stringify(draft) !== JSON.stringify(persisted);
  const invalid = !Number.isInteger(draft.settlementDueSoonDays) || draft.settlementDueSoonDays < 1 || draft.settlementDueSoonDays > 30
    || !Number.isInteger(draft.settlementOverdueRepeatDays) || draft.settlementOverdueRepeatDays < 0 || draft.settlementOverdueRepeatDays > 90;
  const save = () => {
    const update: GroupSettingsUpdateInput = {
      ...(draft.settlementsEnabled !== settings.settlementsEnabled ? { settlementsEnabled: draft.settlementsEnabled } : {}),
      ...(draft.settlementDueSoonDays !== settings.settlementDueSoonDays ? { settlementDueSoonDays: draft.settlementDueSoonDays } : {}),
      ...(draft.settlementOverdueRepeatDays !== settings.settlementOverdueRepeatDays ? { settlementOverdueRepeatDays: draft.settlementOverdueRepeatDays } : {}),
    };
    mutation.mutate(update, { onSuccess: (saved) => {
      setDraft({ settlementsEnabled: saved.settlementsEnabled, settlementDueSoonDays: saved.settlementDueSoonDays, settlementOverdueRepeatDays: saved.settlementOverdueRepeatDays });
      setConfirmDisable(false);
    } });
  };
  return <section aria-labelledby="settlements-setting-title" className={styles.card}>
    <div className={styles.settingRow}>
      <div><h4 id="settlements-setting-title">{t('behaviorSettings.settlementsTitle')}</h4><p>{t('behaviorSettings.settlementsDescription')}</p></div>
      <Toggle checked={draft.settlementsEnabled} disabled={mutation.isPending} label={t('behaviorSettings.settlementsToggle')} onChange={(enabled) => { setDraft((current) => ({ ...current, settlementsEnabled: enabled })); mutation.reset(); }} />
    </div>
    <p className={styles.notice}>{t(draft.settlementsEnabled ? 'behaviorSettings.settlementsEnabledNotice' : 'behaviorSettings.settlementsDisabledNotice')}</p>
    <div className={styles.settlementReminderGrid}>
      <Field hint={t('behaviorSettings.settlementDueSoonDaysHint')} htmlFor="settlement-due-soon-days" label={t('behaviorSettings.settlementDueSoonDays')}>
        <TextInput disabled={!draft.settlementsEnabled || mutation.isPending} id="settlement-due-soon-days" max={30} min={1} onChange={(event) => { setDraft((current) => ({ ...current, settlementDueSoonDays: event.target.valueAsNumber })); mutation.reset(); }} required step={1} type="number" value={Number.isNaN(draft.settlementDueSoonDays) ? '' : draft.settlementDueSoonDays} />
      </Field>
      <Field hint={t('behaviorSettings.settlementOverdueRepeatDaysHint')} htmlFor="settlement-overdue-repeat-days" label={t('behaviorSettings.settlementOverdueRepeatDays')}>
        <TextInput disabled={!draft.settlementsEnabled || mutation.isPending} id="settlement-overdue-repeat-days" max={90} min={0} onChange={(event) => { setDraft((current) => ({ ...current, settlementOverdueRepeatDays: event.target.valueAsNumber })); mutation.reset(); }} required step={1} type="number" value={Number.isNaN(draft.settlementOverdueRepeatDays) ? '' : draft.settlementOverdueRepeatDays} />
      </Field>
    </div>
    <SaveFeedback error={mutation.isError ? mutation.error.message : undefined} success={mutation.isSuccess && !changed} />
    <SectionSaveButton disabled={!changed || invalid} onClick={() => { if (settings.settlementsEnabled && !draft.settlementsEnabled) setConfirmDisable(true); else save(); }} pending={mutation.isPending} section={t('behaviorSettings.settlementsTitle')} />
    <ConfirmationDialog confirmIcon={<ReceiptText size={17} />} confirmLabel={t('behaviorSettings.settlementsDisable')} errorMessage={mutation.isError ? t('behaviorSettings.saveError') : undefined} message={t('behaviorSettings.settlementsDisableImpact')} onClose={() => setConfirmDisable(false)} onConfirm={save} open={confirmDisable} pending={mutation.isPending} title={t('behaviorSettings.settlementsDisableTitle')} tone="danger" />
  </section>;
}

/** Renders one keyboard-operable three-state reason policy selector. */
function ReasonModeControl({ disabled, id, label, onChange, value }: { disabled: boolean; id: string; label: string; onChange: (value: ReasonMode) => void; value: ReasonMode }) {
  const { t } = useTranslation();
  const options: Array<{ label: string; value: ReasonMode }> = [
    { label: t('behaviorSettings.reasonModeOff'), value: 'OFF' },
    { label: t('behaviorSettings.reasonModeOptional'), value: 'OPTIONAL' },
    { label: t('behaviorSettings.reasonModeRequired'), value: 'REQUIRED' },
  ];
  return <fieldset className={styles.reasonModeControl} disabled={disabled}>
    <legend className="sr-only">{label}</legend>
    {options.map((option) => <label key={option.value}><input checked={value === option.value} name={id} onChange={() => onChange(option.value)} type="radio" value={option.value} /><span>{option.label}</span></label>)}
  </fieldset>;
}

/** Persists each independent reason rule immediately and reverts failed edits. */
function ReasonRulesSetting({ groupId, settings }: { groupId: string; settings: GroupSettings }) {
  const { t } = useTranslation();
  const [pendingChoice, setPendingChoice] = useState<{ key: ReasonSettingKey; value: ReasonMode } | null>(null);
  const mutation = useGroupSettingsPatch(groupId);
  const rules: Array<{ key: ReasonSettingKey; label: string; id: string }> = [
    { key: 'ownBookingReasonMode', label: t('behaviorSettings.ownBookingReason'), id: 'own-booking-reason-mode' },
    { key: 'foreignBookingReasonMode', label: t('behaviorSettings.foreignBookingReason'), id: 'foreign-booking-reason-mode' },
    { key: 'ownPaymentReasonMode', label: t('behaviorSettings.ownPaymentReason'), id: 'own-payment-reason-mode' },
    { key: 'otherPaymentReasonMode', label: t('behaviorSettings.otherPaymentReason'), id: 'other-payment-reason-mode' },
  ];
  const change = (key: ReasonSettingKey, value: ReasonMode) => {
    setPendingChoice({ key, value });
    mutation.reset();
    mutation.mutate({ [key]: value }, { onSettled: () => setPendingChoice(null) });
  };
  return <section aria-labelledby="reason-rules-title" className={styles.card}>
    <h4 className={styles.cardTitle} id="reason-rules-title">{t('behaviorSettings.reasonRulesTitle')}</h4>
    <p className={styles.cardDescription}>{t('behaviorSettings.reasonRulesDescription')}</p>
    <div className={styles.ruleList}>{rules.map(({ id, key, label }) => <div className={`${styles.settingRow} ${styles.reasonRule}`} key={key}><span>{label}</span><ReasonModeControl disabled={mutation.isPending} id={id} label={label} onChange={(value) => change(key, value)} value={pendingChoice?.key === key ? pendingChoice.value : settings[key]} /></div>)}</div>
    <SaveFeedback error={mutation.isError ? mutation.error.message : undefined} success={mutation.isSuccess} />
  </section>;
}

/** Saves an ordered reason suggestion list without changing the other list. */
function ReasonSuggestionsSetting({ groupId, kind, settings }: { groupId: string; kind: ReasonListKey; settings: GroupSettings }) {
  const { t } = useTranslation();
  const [items, setItems] = useSyncedSettingsDraft(settings[kind]);
  const mutation = useGroupSettingsPatch(groupId);
  const changed = JSON.stringify(items) !== JSON.stringify(settings[kind]);
  const invalid = hasInvalidLabels(items);
  const label = t(`behaviorSettings.${kind}`);
  return <section className={styles.card}>
    <ConfigurableListEditor addLabel={t(kind === 'bookingReasons' ? 'behaviorSettings.addBookingReason' : 'behaviorSettings.addPaymentReason')} emptyLabel={t('behaviorSettings.noReasonSuggestions')} items={items} label={label} onChange={(next) => { setItems(next); mutation.reset(); }} />
    <SaveFeedback error={mutation.isError ? mutation.error.message : undefined} success={mutation.isSuccess && !changed} />
    <SectionSaveButton disabled={!changed || invalid} onClick={() => mutation.mutate({ [kind]: items }, { onSuccess: (saved) => setItems(saved[kind]) })} pending={mutation.isPending} section={label} />
  </section>;
}

/**
 * Arranges scoped finance and booking controls without a page-level save action.
 *
 * @param props - Group permissions, currency, linked accounts, and persisted settings.
 * @returns Cards with local save actions or immediately persisted controls.
 * @throws Mutation failures are rendered beside the affected card.
 */
export function GroupFinanceSettings({ canManageExternalAccounts, canManageFinancialSettings, canManageGroup, currency, externalAccounts, groupId, settings }: GroupFinanceSettingsProps) {
  const { t } = useTranslation();
  const [paymentMethodsDirty, setPaymentMethodsDirty] = useState(false);
  return <>
    {canManageFinancialSettings || canManageExternalAccounts ? <section aria-labelledby="finance-settings-title" className={styles.settingsSection}>
      <header><h3 id="finance-settings-title">{t('behaviorSettings.financeSectionTitle')}</h3></header>
      {canManageFinancialSettings ? <PaymentMethodsSetting currency={currency} groupId={groupId} onDirtyChange={setPaymentMethodsDirty} settings={settings} /> : null}
      {canManageGroup ? <section aria-labelledby="external-accounts-feature-title" className={`${styles.card} ${styles.externalAccountsCard}`}>
        <ExternalAccountsFeatureSetting groupId={groupId} settings={settings} unsavedChanges={paymentMethodsDirty} />
        {canManageExternalAccounts && externalAccounts ? <ExternalAccountConfigurationActions accounts={externalAccounts} currency={currency} groupId={groupId} paymentMethods={settings.paymentMethods} /> : null}
      </section> : canManageExternalAccounts && externalAccounts ? <section className={styles.card}><ExternalAccountConfigurationActions accounts={externalAccounts} currency={currency} groupId={groupId} paymentMethods={settings.paymentMethods} /></section> : null}
      {canManageFinancialSettings ? <SettlementsSetting groupId={groupId} settings={settings} /> : null}
      {canManageGroup ? <StatisticsFeatureSetting groupId={groupId} settings={settings} /> : null}
    </section> : null}
    {canManageFinancialSettings ? <section aria-labelledby="booking-settings-title" className={styles.bookingSection}>
      <header><h3 id="booking-settings-title">{t('behaviorSettings.bookingTitle')}</h3></header>
      <ReasonRulesSetting groupId={groupId} settings={settings} />
      <ReasonSuggestionsSetting groupId={groupId} kind="bookingReasons" settings={settings} />
      <ReasonSuggestionsSetting groupId={groupId} kind="paymentReasons" settings={settings} />
    </section> : null}
  </>;
}
