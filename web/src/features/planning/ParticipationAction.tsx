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

type ParticipationActionMode = 'controls' | 'summary';
type ParticipationCountKey = 'attending' | 'maybe' | 'declined' | 'unanswered' | 'waitlisted';

interface ParticipationActionProps {
  event: PlanningEvent;
  compact?: boolean;
  mode?: ParticipationActionMode;
}

const COUNT_STATUS: Partial<Record<ParticipationCountKey, PlanningParticipationStatus>> = {
  attending: 'ATTENDING',
  maybe: 'MAYBE',
  declined: 'DECLINED',
  waitlisted: 'WAITLISTED',
};

/**
 * Builds the aggregate values used by the interactive response summary.
 *
 * @param event - Planning event whose privacy-safe response totals are displayed.
 * @returns Ordered count keys and values for the event type.
 */
function participationCountItems(event: PlanningEvent): ReadonlyArray<readonly [ParticipationCountKey, number]> {
  return event.eventType === 'APPOINTMENT_REGISTRATION'
    ? [['attending', event.participation.attending], ['waitlisted', event.participation.waitlisted]]
    : [['attending', event.participation.attending], ['maybe', event.participation.maybe], ['declined', event.participation.declined], ['unanswered', event.participation.unanswered]];
}

/** Returns the configured registration capacity, including the compatibility summary field. */
function registrationCapacity(event: PlanningEvent): number | undefined {
  return event.capacity ?? event.participation.capacity;
}

/** Reports whether every configured registration place is currently occupied. */
function registrationIsFull(event: PlanningEvent): boolean {
  const capacity = registrationCapacity(event);
  return capacity !== undefined && event.participation.attending >= capacity;
}

/**
 * Resolves the mutation triggered by an interactive count tile.
 *
 * @param event - Event that owns the response controls.
 * @param countKey - Aggregate represented by the selected tile.
 * @param selected - Current effective participation state.
 * @returns The next server status, or undefined when the tile is informational only.
 */
function summaryTileAction(event: PlanningEvent, countKey: ParticipationCountKey, selected?: PlanningParticipationStatus): PlanningParticipationStatus | 'WITHDRAWN' | undefined {
  if (!event.canRespond || event.status !== 'PUBLISHED') return undefined;
  const countStatus = COUNT_STATUS[countKey];
  if (event.eventType === 'APPOINTMENT_POLL') return countStatus === 'ATTENDING' || countStatus === 'MAYBE' || countStatus === 'DECLINED' ? countStatus : undefined;
  if (event.eventType !== 'APPOINTMENT_REGISTRATION') return undefined;
  if (selected && countStatus === selected) return 'WITHDRAWN';
  if (selected !== undefined) return undefined;
  if (!registrationIsFull(event)) return countStatus === 'ATTENDING' ? 'ATTENDING' : undefined;
  return event.waitlistEnabled && countStatus === 'WAITLISTED' ? 'ATTENDING' : undefined;
}

/** Returns the semantic utilization tone for a capacity-constrained registration. */
function registrationCapacityTone(event: PlanningEvent): 'low' | 'medium' | 'high' {
  const capacity = registrationCapacity(event);
  if (capacity === undefined || event.participation.attending / capacity < 0.6) return 'low';
  return event.participation.attending / capacity < 0.85 ? 'medium' : 'high';
}

/** Lets the current member answer an appointment poll or manage appointment registration using buttons or semantic choice controls. */
export function ParticipationAction({ event, compact = false, mode = 'controls' }: ParticipationActionProps) {
  const { t } = useTranslation();
  const { activeGroupId } = useActiveGroup();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (status: PlanningParticipationStatus | 'WITHDRAWN') => api.updatePlanningParticipation(activeGroupId, event.id, event.eventType, status),
    onSuccess: async (persisted) => {
      queryClient.setQueryData(planningKeys.event(activeGroupId, event.id), persisted);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: planningKeys.events(activeGroupId) }),
        queryClient.invalidateQueries({ queryKey: planningKeys.participants(activeGroupId, event.id) }),
        queryClient.invalidateQueries({ queryKey: ['dashboard', activeGroupId] }),
      ]);
    },
  });
  const effectiveStatus = event.viewerParticipation?.status;
  const selected = effectiveStatus === 'WITHDRAWN' ? undefined : effectiveStatus;
  const canRespond = event.canRespond && event.status === 'PUBLISHED' && event.eventType !== 'APPOINTMENT';
  if (mode === 'summary') {
    const choiceName = `participation-${event.id}`;
    const choiceType = event.eventType === 'APPOINTMENT_POLL' ? 'radio' : 'checkbox';
    return <fieldset className={styles.countsFieldset}>
      <legend className={styles.srOnly}>{t('planning.participation.title')}</legend>
      <div aria-busy={mutation.isPending} className={styles.counts}>
        {participationCountItems(event).map(([key, value]) => {
          const countStatus = COUNT_STATUS[key];
          const isSelected = countStatus !== undefined && countStatus === selected;
          const nextStatus = summaryTileAction(event, key, selected);
          const label = t(`planning.counts.${key}`);
          if (event.eventType === 'APPOINTMENT_REGISTRATION' && key === 'waitlisted' && registrationCapacity(event) === undefined) {
            return <div className={`${styles.count} ${styles.unlimitedCapacityCount}`} key={key}>
              <strong>{t('planning.participation.unlimitedCapacity')}</strong>
              <span>{t('planning.participation.places')}</span>
            </div>;
          }
          if (event.eventType === 'APPOINTMENT_REGISTRATION' && key === 'waitlisted') {
            const capacity = registrationCapacity(event) as number;
            const available = Math.max(0, capacity - event.participation.attending);
            const capacityContent = <>
              <strong>{t('planning.participation.availablePlaces', { available })}</strong>
              <span>{t('planning.participation.occupiedCapacity', { occupied: event.participation.attending, capacity })}</span>
              <progress aria-label={t('planning.participation.capacityProgress', { occupied: event.participation.attending, capacity })} className={styles.registrationCapacityProgress} data-tone={registrationCapacityTone(event)} max={capacity} value={Math.min(event.participation.attending, capacity)} />
              <small className={styles.registrationWaitlistMeta}>{event.waitlistEnabled ? t('planning.participation.waitlistCount', { count: value }) : t('planning.participation.noWaitlist')}</small>
            </>;
            if (nextStatus === undefined) return <div className={`${styles.count} ${styles.registrationCapacityCount}`} key={key}>{capacityContent}</div>;
            return <label className={`${styles.count} ${styles.countChoice} ${styles.registrationCapacityCount}`} data-selected={isSelected} key={key}>
              <input aria-label={t(isSelected ? 'planning.participation.leaveWaitlist' : 'planning.participation.joinWaitlist')} checked={isSelected} className={styles.countChoiceInput} disabled={mutation.isPending} onChange={() => mutation.mutate(nextStatus)} type="checkbox" />
              {capacityContent}
            </label>;
          }
          if (nextStatus === undefined) return <div className={styles.count} key={key}><strong>{value}</strong><span>{label}</span></div>;
          return <label className={`${styles.count} ${styles.countChoice}`} data-selected={isSelected} key={key}>
            <input checked={isSelected} className={styles.countChoiceInput} disabled={mutation.isPending} name={choiceType === 'radio' ? choiceName : undefined} onChange={() => mutation.mutate(nextStatus)} type={choiceType} />
            <strong>{value}</strong>
            <span>{label}</span>
          </label>;
        })}
      </div>
      {mutation.isError ? <span className={styles.error} role="alert">{t('planning.participation.error')}</span> : null}
      {mutation.isSuccess ? <span className={styles.srOnly} role="status">{t('planning.participation.saved')}</span> : null}
    </fieldset>;
  }
  if (!canRespond) return null;
  const action = (status: PlanningParticipationStatus, icon: ReactNode) => (
    <Button aria-pressed={selected === status} disabled={mutation.isPending} key={status} leadingIcon={icon} onClick={() => mutation.mutate(status)} size={compact ? 'small' : 'medium'} variant={selected === status ? 'primary' : 'secondary'}>
      {t(`planning.participation.${status.toLowerCase()}`)}
    </Button>
  );
  return <div className={styles.participation}>
    {event.eventType === 'APPOINTMENT_POLL' ? <>
      {action('ATTENDING', <Check size={16} />)}
      {action('MAYBE', <CircleHelp size={16} />)}
      {action('DECLINED', <X size={16} />)}
    </> : selected ? <Button disabled={mutation.isPending} leadingIcon={<LogOut size={16} />} onClick={() => mutation.mutate('WITHDRAWN')} size={compact ? 'small' : 'medium'} variant="secondary">{t('planning.participation.withdraw')}</Button>
        : action('ATTENDING', <Check size={16} />)}
    {mutation.isError ? <span className={styles.error} role="alert">{t('planning.participation.error')}</span> : null}
    {mutation.isSuccess ? <span className={styles.srOnly} role="status">{t('planning.participation.saved')}</span> : null}
  </div>;
}
