import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { GroupSettings } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { StatePanel } from '@/components/ui/StatePanel';
import { Toggle } from '@/components/ui/Toggle';
import styles from './BehaviorSettingsPanel.module.css';

/** Properties for the editable group behavior settings form. */
interface SettingsFormProps {
  groupId: string;
  settings: GroupSettings;
}

/**
 * Renders the controlled form for administrator-managed group behavior.
 *
 * @param props - Group identifier and the last persisted settings snapshot.
 * @returns An accessible settings card with explicit save feedback.
 */
function SettingsForm({ groupId, settings }: SettingsFormProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [membersCanViewAllBookings, setMembersCanViewAllBookings] = useState(settings.membersCanViewAllBookings);
  const mutation = useMutation({
    mutationFn: () => api.updateGroupSettings(groupId, { membersCanViewAllBookings }),
    onSuccess: async (persisted) => {
      queryClient.setQueryData<GroupSettings>(['group-settings', groupId], persisted);
      await queryClient.invalidateQueries({ queryKey: ['bookings', groupId] });
    },
  });
  const changed = membersCanViewAllBookings !== settings.membersCanViewAllBookings;

  return (
    <form className={styles.card} onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
      <div className={styles.settingRow}>
        <div>
          <h3>{t('behaviorSettings.bookingVisibilityTitle')}</h3>
          <p>{t('behaviorSettings.bookingVisibilityDescription')}</p>
        </div>
        <Toggle
          checked={membersCanViewAllBookings}
          disabled={mutation.isPending}
          label={t('behaviorSettings.bookingVisibilityToggle')}
          onChange={(checked) => { setMembersCanViewAllBookings(checked); mutation.reset(); }}
        />
      </div>
      <p className={styles.notice}>{t('behaviorSettings.bookingVisibilityNotice')}</p>
      {mutation.isError ? <p className={styles.error} role="alert">{t('behaviorSettings.saveError')} {mutation.error.message}</p> : null}
      {mutation.isSuccess ? <p className={styles.success} role="status">{t('behaviorSettings.saved')}</p> : null}
      <div className={styles.actions}>
        <Button disabled={!changed || mutation.isPending} type="submit">
          {mutation.isPending ? t('behaviorSettings.saving') : t('behaviorSettings.save')}
        </Button>
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

  if (settingsQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (settingsQuery.isError || !settingsQuery.data) return <div className={styles.state}><StatePanel kind="error" message={t('behaviorSettings.loadError')} /></div>;

  return (
    <div className={styles.content}>
      <header className={styles.header}>
        <h2>{t('behaviorSettings.title')}</h2>
        <p>{t('behaviorSettings.intro')}</p>
      </header>
      <SettingsForm groupId={activeGroupId} key={activeGroupId} settings={settingsQuery.data} />
    </div>
  );
}
