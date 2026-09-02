import { useMutation, useQueryClient } from '@tanstack/react-query';
import Check from 'lucide-react/dist/esm/icons/check';
import CircleHelp from 'lucide-react/dist/esm/icons/circle-help';
import LogOut from 'lucide-react/dist/esm/icons/log-out';
import X from 'lucide-react/dist/esm/icons/x';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { api } from '@/api/client';
import type { PlanningEvent, PlanningParticipationStatus } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { planningKeys } from './planningQueryKeys';
import styles from './Planning.module.css';

/** Lets the current member answer an appointment poll or manage appointment registration. */
export function ParticipationAction({ event, compact = false }: { event: PlanningEvent; compact?: boolean }) {
  const { t } = useTranslation();
  const { activeGroupId } = useActiveGroup();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (status: PlanningParticipationStatus | 'WITHDRAWN') => api.updatePlanningParticipation(activeGroupId, event.id, event.eventType, status),
    onSuccess: async (persisted) => {
      queryClient.setQueryData(planningKeys.event(activeGroupId, event.id), persisted);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: planningKeys.events(activeGroupId) }),
        queryClient.invalidateQueries({ queryKey: ['dashboard', activeGroupId] }),
      ]);
    },
  });
  if (!event.canRespond || event.status !== 'PUBLISHED' || event.eventType === 'APPOINTMENT') return null;
  const effectiveStatus = event.viewerParticipation?.status;
  const selected = effectiveStatus === 'WITHDRAWN' ? undefined : effectiveStatus;
  const action = (status: PlanningParticipationStatus, icon: ReactNode) => (
    <Button aria-pressed={selected === status} disabled={mutation.isPending} key={status} leadingIcon={icon} onClick={() => mutation.mutate(status)} size={compact ? 'small' : 'medium'} variant={selected === status ? 'primary' : 'secondary'}>
      {t(`planning.participation.${status.toLowerCase()}`)}
    </Button>
  );
  return <div className={styles.participation}>
    {selected === 'RECONFIRMATION_REQUIRED' ? <strong>{t('planning.participation.reconfirmation_required')}</strong> : null}
    {event.eventType === 'APPOINTMENT_POLL' ? <>
      {action('ATTENDING', <Check size={16} />)}
      {action('MAYBE', <CircleHelp size={16} />)}
      {action('DECLINED', <X size={16} />)}
    </> : selected === 'RECONFIRMATION_REQUIRED' ? <>{action('ATTENDING', <Check size={16} />)}<Button disabled={mutation.isPending} leadingIcon={<LogOut size={16} />} onClick={() => mutation.mutate('WITHDRAWN')} size={compact ? 'small' : 'medium'} variant="secondary">{t('planning.participation.withdraw')}</Button></>
      : selected ? <Button disabled={mutation.isPending} leadingIcon={<LogOut size={16} />} onClick={() => mutation.mutate('WITHDRAWN')} size={compact ? 'small' : 'medium'} variant="secondary">{t('planning.participation.withdraw')}</Button>
        : action('ATTENDING', <Check size={16} />)}
    {mutation.isError ? <span className={styles.error} role="alert">{t('planning.participation.error')}</span> : null}
    {mutation.isSuccess ? <span className={styles.srOnly} role="status">{t('planning.participation.saved')}</span> : null}
  </div>;
}
