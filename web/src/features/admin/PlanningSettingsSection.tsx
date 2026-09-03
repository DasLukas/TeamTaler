import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import CalendarDays from 'lucide-react/dist/esm/icons/calendar-days';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { Session } from '@/api/types';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { StatePanel } from '@/components/ui/StatePanel';
import { Toggle } from '@/components/ui/Toggle';
import { notificationKeys } from '@/features/notifications/notificationQueryKeys';
import { planningKeys } from '@/features/planning/planningQueryKeys';
import styles from './BehaviorSettingsPanel.module.css';

/** Renders the group-administrator feature switch for planning. */
export function PlanningSettingsSection({ groupId }: { groupId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirmDisable, setConfirmDisable] = useState(false);
  const query = useQuery({ queryKey: planningKeys.settings(groupId), queryFn: () => api.getPlanningSettings(groupId) });
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => api.updatePlanningSettings(groupId, enabled, query.data?.version ?? 0),
    onSuccess: async (persisted) => {
      queryClient.setQueryData(planningKeys.settings(groupId), persisted);
      queryClient.setQueryData<Session>(['session'], (session) => session ? { ...session, groups: session.groups.map((group) => group.id === groupId ? { ...group, planningEnabled: persisted.enabled } : group) } : session);
      if (!persisted.enabled) {
        queryClient.removeQueries({
          predicate: (cachedQuery) => cachedQuery.queryKey[0] === 'planning' && cachedQuery.queryKey[1] === groupId && cachedQuery.queryKey[2] !== 'settings',
        });
      }
      queryClient.removeQueries({ queryKey: notificationKeys.preferences(groupId) });
      await queryClient.invalidateQueries({ queryKey: ['dashboard', groupId] });
      setConfirmDisable(false);
    },
  });
  if (query.isLoading) return <StatePanel kind="loading" />;
  if (query.isError || !query.data) return <StatePanel actionLabel={t('common.retry')} kind="error" message={t('behaviorSettings.planning.loadError')} onAction={() => void query.refetch()} />;
  return <section aria-labelledby="planning-setting-title" className={styles.card}>
    <div className={styles.settingRow}><div><h4 id="planning-setting-title">{t('behaviorSettings.planning.title')}</h4><p>{t('behaviorSettings.planning.description')}</p></div><Toggle checked={query.data.enabled} disabled={mutation.isPending} label={t('behaviorSettings.planning.toggle')} onChange={(enabled) => enabled ? mutation.mutate(true) : setConfirmDisable(true)} /></div>
    <p className={styles.notice}>{t(query.data.enabled ? 'behaviorSettings.planning.enabledNotice' : 'behaviorSettings.planning.disabledNotice')}</p>
    {mutation.isError ? <p className={styles.error} role="alert">{t('behaviorSettings.planning.saveError')}</p> : null}
    <ConfirmationDialog confirmIcon={<CalendarDays size={17} />} confirmLabel={t('behaviorSettings.planning.disable')} message={t('behaviorSettings.planning.disableImpact')} onClose={() => setConfirmDisable(false)} onConfirm={() => mutation.mutate(false)} open={confirmDisable} pending={mutation.isPending} title={t('behaviorSettings.planning.disableTitle')} tone="danger" />
  </section>;
}
