import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import TriangleAlert from 'lucide-react/dist/esm/icons/triangle-alert';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { GroupSettings, GroupSettingsUpdateInput, GuestSettingsUpdateInput, Role } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput } from '@/components/ui/FormField';
import { StatePanel } from '@/components/ui/StatePanel';
import { Toggle } from '@/components/ui/Toggle';
import { roleDisplayName } from './roleDisplayName';
import styles from './BehaviorSettingsPanel.module.css';

const NO_GUEST_ROLE = '__no_guest_role__';
const CREATE_GUEST_ROLE = '__create_guest_role__';

/** Properties for the editable group behavior settings form. */
interface SettingsFormProps {
  groupId: string;
  settings: GroupSettings;
  roles: Role[];
}

/**
 * Determines whether an existing role is safe to designate as the guest role.
 *
 * @param role - Group-owned role offered by the settings API.
 * @returns Whether the role grants exactly own-booking access and nothing else.
 */
function isGuestRoleCandidate(role: Role): boolean {
  const grant = role.grants[0];
  const scope = grant?.scope as (Role['grants'][number]['scope'] & { categoryId?: unknown; productId?: unknown }) | undefined;
  return role.grants.length === 1
    && grant?.permission === 'CREATE_OWN_BOOKING'
    && scope?.type === 'GROUP'
    && scope.categoryId === undefined
    && scope.productId === undefined;
}

/**
 * Renders the controlled form for administrator-managed group behavior.
 *
 * Selecting or creating a guest role also makes it the group default atomically.
 * The regular default-role control remains locked until that guest-role binding is
 * removed or the feature is disabled with an explicit replacement.
 *
 * @param props - Group identifier and the last persisted settings snapshot.
 * @returns Accessible, visually separated settings cards with explicit feedback.
 */
function SettingsForm({ groupId, settings, roles }: SettingsFormProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const defaultRoleCandidates = roles.filter((role) => !role.grants.some((grant) => grant.permission === 'GROUP_ADMINISTRATION'));
  const guestRoleCandidates = defaultRoleCandidates.filter((role) => role.id === settings.guestRoleId || isGuestRoleCandidate(role));
  const ineligibleGuestRoles = defaultRoleCandidates.filter((role) => role.id !== settings.guestRoleId && !isGuestRoleCandidate(role));
  const [notificationEmailsEnabled, setNotificationEmailsEnabled] = useState(settings.notificationEmailsEnabled);
  const [defaultRoleId, setDefaultRoleId] = useState(settings.defaultRoleId ?? '');
  const [guestsEnabled, setGuestsEnabled] = useState(settings.guestsEnabled);
  const [guestRoleChoice, setGuestRoleChoice] = useState(settings.guestRoleId ?? NO_GUEST_ROLE);
  const initialReplacementRole = defaultRoleCandidates.find((role) => role.id !== settings.guestRoleId)?.id ?? '';
  const [replacementDefaultRoleId, setReplacementDefaultRoleId] = useState(initialReplacementRole);
  const selectsGuestRole = guestRoleChoice !== NO_GUEST_ROLE;
  const defaultRoleLocked = guestsEnabled && selectsGuestRole;
  const disablesDefaultGuestRole = Boolean(!guestsEnabled && settings.guestsEnabled && settings.guestRoleId && settings.defaultRoleId === settings.guestRoleId);
  const selectedGuestRoleId = guestRoleChoice === NO_GUEST_ROLE || guestRoleChoice === CREATE_GUEST_ROLE ? null : guestRoleChoice;
  const guestRoleChanged = guestsEnabled && (
    guestRoleChoice === CREATE_GUEST_ROLE
      || guestRoleChoice === NO_GUEST_ROLE && settings.guestRoleId !== null
      || selectedGuestRoleId !== null && selectedGuestRoleId !== settings.guestRoleId
  );
  const guestSettingsChanged = guestsEnabled !== settings.guestsEnabled || guestRoleChanged;
  const defaultRoleChanged = !defaultRoleLocked && !disablesDefaultGuestRole && Boolean(defaultRoleId && defaultRoleId !== settings.defaultRoleId);
  const changed = notificationEmailsEnabled !== settings.notificationEmailsEnabled || guestSettingsChanged || defaultRoleChanged;
  const replacementValid = !disablesDefaultGuestRole || Boolean(replacementDefaultRoleId);

  const mutation = useMutation({
    mutationFn: async () => {
      let persisted = settings;
      if (guestSettingsChanged) {
        const guestUpdate: GuestSettingsUpdateInput = guestsEnabled
          ? guestRoleChoice === CREATE_GUEST_ROLE
            ? { guestsEnabled: true, createGuestRole: true }
            : guestRoleChoice === NO_GUEST_ROLE
              ? { guestsEnabled: true, guestRoleId: null }
              : { guestsEnabled: true, guestRoleId: guestRoleChoice }
          : {
            guestsEnabled: false,
            ...(disablesDefaultGuestRole ? { replacementDefaultRoleId } : {}),
          };
        persisted = await api.updateGuestSettings(groupId, guestUpdate);
      }

      const generalUpdate: GroupSettingsUpdateInput = {
        ...(notificationEmailsEnabled !== persisted.notificationEmailsEnabled ? { notificationEmailsEnabled } : {}),
        ...(!defaultRoleLocked && !disablesDefaultGuestRole && defaultRoleId && defaultRoleId !== persisted.defaultRoleId ? { defaultRoleId } : {}),
      };
      return Object.keys(generalUpdate).length > 0
        ? api.updateGroupSettings(groupId, generalUpdate)
        : persisted;
    },
    onSuccess: async (persisted) => {
      queryClient.setQueryData<GroupSettings>(['group-settings', groupId], persisted);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['roles', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['booking-context', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['members', groupId] }),
      ]);
    },
    onError: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['group-settings', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['roles', groupId] }),
      ]);
    },
  });

  return (
    <form className={styles.form} onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
      <section aria-labelledby="guest-setting-title" className={styles.card}>
        <div className={styles.settingRow}>
          <div>
            <h3 id="guest-setting-title">{t('behaviorSettings.guestsTitle')}</h3>
            <p>{t('behaviorSettings.guestsDescription')}</p>
          </div>
          <Toggle checked={guestsEnabled} disabled={mutation.isPending} label={t('behaviorSettings.guestsToggle')} onChange={(checked) => { setGuestsEnabled(checked); mutation.reset(); }} />
        </div>
        {guestsEnabled ? <div className={styles.guestSetup}>
          <Field hint={t('behaviorSettings.guestRoleHint')} htmlFor="guest-role" label={t('behaviorSettings.guestRoleLabel')}>
            <SelectInput id="guest-role" onChange={(event) => { setGuestRoleChoice(event.target.value); mutation.reset(); }} value={guestRoleChoice}>
              {settings.guestRoleId === null ? <option value={NO_GUEST_ROLE}>{t('behaviorSettings.noGuestRole')}</option> : null}
              <option value={CREATE_GUEST_ROLE}>{t('behaviorSettings.createGuestRole')}</option>
              {guestRoleCandidates.map((role) => <option key={role.id} value={role.id}>{roleDisplayName(role)}</option>)}
              {ineligibleGuestRoles.length > 0 ? <optgroup label={t('behaviorSettings.ineligibleGuestRoles')}>
                {ineligibleGuestRoles.map((role) => <option disabled key={role.id} value={role.id}>{t('behaviorSettings.ineligibleGuestRoleOption', { role: roleDisplayName(role) })}</option>)}
              </optgroup> : null}
            </SelectInput>
          </Field>
          {selectsGuestRole ? <p className={`${styles.notice} ${styles.warning}`}><TriangleAlert aria-hidden="true" size={18} /> {t('behaviorSettings.guestRoleDefaultWarning')}</p> : <p className={styles.notice}>{t('behaviorSettings.noGuestRoleNotice')}</p>}
        </div> : <p className={styles.notice}>{t('behaviorSettings.guestsDisabledNotice')}</p>}
        {disablesDefaultGuestRole ? <div className={styles.warningBlock}>
          <p><TriangleAlert aria-hidden="true" size={18} /> {t('behaviorSettings.guestDefaultReplacementWarning')}</p>
          <Field hint={t('behaviorSettings.guestDefaultReplacementHint')} htmlFor="guest-default-replacement" label={t('behaviorSettings.guestDefaultReplacementLabel')}>
            <SelectInput id="guest-default-replacement" onChange={(event) => { setReplacementDefaultRoleId(event.target.value); mutation.reset(); }} value={replacementDefaultRoleId}>
              <option disabled value="">{t('behaviorSettings.guestDefaultReplacementPlaceholder')}</option>
              {defaultRoleCandidates.filter((role) => role.id !== settings.guestRoleId).map((role) => <option key={role.id} value={role.id}>{roleDisplayName(role)}</option>)}
            </SelectInput>
          </Field>
        </div> : null}
      </section>

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
        <Field hint={defaultRoleLocked ? t('behaviorSettings.defaultRoleLockedByGuests') : settings.defaultRoleId ? t('behaviorSettings.defaultRoleHint') : t('behaviorSettings.defaultRoleMissing')} htmlFor="default-membership-role" label={t('behaviorSettings.defaultRoleFieldLabel')}>
          <SelectInput disabled={defaultRoleLocked} id="default-membership-role" onChange={(event) => { setDefaultRoleId(event.target.value); mutation.reset(); }} value={defaultRoleLocked && selectedGuestRoleId ? selectedGuestRoleId : defaultRoleId}>
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
        <div className={styles.actions}><Button disabled={!changed || !replacementValid || mutation.isPending} type="submit">{mutation.isPending ? t('behaviorSettings.saving') : t('behaviorSettings.save')}</Button></div>
      </div>
    </form>
  );
}

/**
 * Loads and renders administrator-only group behavior switches.
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
    <SettingsForm groupId={activeGroupId} key={`${activeGroupId}:${settingsQuery.data.guestsEnabled}:${settingsQuery.data.guestRoleId ?? 'none'}:${settingsQuery.data.defaultRoleId ?? 'none'}`} roles={rolesQuery.data} settings={settingsQuery.data} />
  </div>;
}
