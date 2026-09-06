import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left';
import Ban from 'lucide-react/dist/esm/icons/ban';
import CheckCircle from 'lucide-react/dist/esm/icons/check-circle';
import Edit from 'lucide-react/dist/esm/icons/edit';
import Repeat2 from 'lucide-react/dist/esm/icons/repeat-2';
import UsersRound from 'lucide-react/dist/esm/icons/users-round';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '@/api/client';
import type { PlanningEvent, PlanningParticipantPage, PlanningSeriesScope } from '@/api/types';
import { can } from '@/app/permissions';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { StatePanel } from '@/components/ui/StatePanel';
import { ParticipationAction } from './ParticipationAction';
import { PlanningEventTypeBadge } from './PlanningEventType';
import { planningRecurrenceSummary } from './planningRecurrence';
import { PlanningSeriesScopeDialog } from './PlanningSeriesScopeDialog';
import { formatPlanningDateTime } from './planningDate';
import { planningKeys } from './planningQueryKeys';
import type { PlanningSearch } from './planningSearch';
import { formatPlanningAllDayRange, planningEndDateExclusive } from './planningTiming';
import styles from './Planning.module.css';

type Transition = 'close' | 'complete' | 'cancel';

function EventCounts({ event }: { event: PlanningEvent }) {
  const { t } = useTranslation();
  const values = event.eventType === 'APPOINTMENT_REGISTRATION'
    ? [['attending', event.participation.attending], ['waitlisted', event.participation.waitlisted]] as const
    : [['attending', event.participation.attending], ['maybe', event.participation.maybe], ['declined', event.participation.declined], ['unanswered', event.participation.unanswered]] as const;
  return <div className={styles.counts}>{values.map(([key, value]) => <div className={styles.count} key={key}><strong>{value}</strong><span>{t(`planning.counts.${key}`)}</span></div>)}</div>;
}

/** Renders one planning event, including series-aware management controls. */
export function PlanningEventDetailPage() {
  const { eventId } = useParams({ strict: false }) as { eventId: string };
  const search = useSearch({ strict: false }) as PlanningSearch;
  const { t } = useTranslation();
  const { activeGroupId, activeGroup } = useActiveGroup();
  const queryClient = useQueryClient();
  const [confirmation, setConfirmation] = useState<Transition | null>(null);
  const [cancelScopeOpen, setCancelScopeOpen] = useState(false);
  const [cancelScope, setCancelScope] = useState<PlanningSeriesScope>('THIS');
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const settingsQuery = useQuery({ queryKey: planningKeys.settings(activeGroupId), queryFn: () => api.getPlanningSettings(activeGroupId), staleTime: 60_000 });
  const eventQuery = useQuery({ queryKey: planningKeys.event(activeGroupId, eventId), queryFn: () => api.getPlanningEvent(activeGroupId, eventId) });
  const event = eventQuery.data;
  const seriesId = event?.seriesId ?? '';
  const seriesQuery = useQuery({ queryKey: planningKeys.series(activeGroupId, seriesId), queryFn: () => api.getPlanningSeries(activeGroupId, seriesId), enabled: Boolean(seriesId) });
  const timeZone = event?.timeZone ?? seriesQuery.data?.timeZone ?? settingsQuery.data?.timeZone ?? browserTimeZone;
  const manageAll = can(activeGroup.membership?.effectiveGrants, 'MANAGE_PLANNING_EVENTS');
  const participantsQuery = useInfiniteQuery({
    getNextPageParam: (lastPage: PlanningParticipantPage) => lastPage.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: planningKeys.participants(activeGroupId, eventId),
    queryFn: ({ pageParam }): Promise<PlanningParticipantPage> => api.getPlanningParticipants(activeGroupId, eventId, pageParam, 100),
    enabled: Boolean(event?.canViewParticipants || manageAll),
  });
  const participants = participantsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const invalidatePlanning = async () => Promise.all([
    queryClient.invalidateQueries({ queryKey: planningKeys.events(activeGroupId) }),
    queryClient.invalidateQueries({ queryKey: ['dashboard', activeGroupId] }),
  ]);
  const transition = useMutation({
    mutationFn: async (next: Transition): Promise<PlanningEvent> => api.transitionPlanningEvent(activeGroupId, eventId, next, event?.version ?? 0),
    onSuccess: async (persisted) => {
      queryClient.setQueryData(planningKeys.event(activeGroupId, eventId), persisted);
      setConfirmation(null);
      await invalidatePlanning();
    },
  });
  const cancelSeries = useMutation({
    mutationFn: async (scope: PlanningSeriesScope): Promise<PlanningEvent> => {
      if (!event?.seriesId || !seriesQuery.data || scope === 'THIS') return api.transitionPlanningEvent(activeGroupId, eventId, 'cancel', event?.version ?? 0);
      const fromOriginalStartAt = scope === 'THIS_AND_FOLLOWING' ? event.originalStartAt ?? event.startsAt : undefined;
      await api.cancelPlanningSeries(activeGroupId, event.seriesId, scope, fromOriginalStartAt, seriesQuery.data.version);
      return api.getPlanningEvent(activeGroupId, eventId);
    },
    onSuccess: async (persisted) => {
      queryClient.setQueryData(planningKeys.event(activeGroupId, eventId), persisted);
      setCancelScopeOpen(false);
      await Promise.all([
        invalidatePlanning(),
        seriesId ? queryClient.invalidateQueries({ queryKey: planningKeys.series(activeGroupId, seriesId) }) : Promise.resolve(),
      ]);
    },
  });
  const loading = eventQuery.isLoading || settingsQuery.isLoading || Boolean(seriesId) && seriesQuery.isLoading;
  if (loading) return <Page title={t('planning.detailTitle')}><StatePanel kind="loading" /></Page>;
  if (eventQuery.isError || settingsQuery.isError || seriesQuery.isError || !event) return <Page title={t('planning.detailTitle')}><StatePanel actionLabel={t('common.retry')} kind="error" message={t('planning.detailError')} onAction={() => void Promise.all([eventQuery.refetch(), settingsQuery.refetch(), ...(seriesId ? [seriesQuery.refetch()] : [])])} /></Page>;
  const canEdit = event.canEdit || manageAll;
  const openCancellation = () => {
    if (event.seriesId) {
      setCancelScope('THIS');
      setCancelScopeOpen(true);
    }
    else setConfirmation('cancel');
  };
  const actions = <div className={styles.detailActions}>
    {canEdit ? <Link className={styles.buttonLink} params={{ eventId }} search={search} to="/planning/events/$eventId/edit"><Edit size={16} />{t('common.edit')}</Link> : null}
    {canEdit && event.status === 'PUBLISHED' ? <Button leadingIcon={<CheckCircle size={16} />} onClick={() => setConfirmation('close')} variant="secondary">{t('planning.actions.close')}</Button> : null}
    {(event.canCancel || manageAll) && event.status === 'PUBLISHED' ? <Button leadingIcon={<Ban size={16} />} onClick={openCancellation} variant="danger">{t('planning.actions.cancel')}</Button> : null}
  </div>;
  const transitionError = transition.error instanceof ApiError && (transition.error.problem.status === 409 || transition.error.problem.status === 412) ? t('planning.form.conflictError') : transition.isError ? t('planning.transitionError') : undefined;
  const cancelError = cancelSeries.error instanceof ApiError && (cancelSeries.error.problem.status === 409 || cancelSeries.error.problem.status === 412) ? t('planning.form.conflictError') : cancelSeries.isError ? t('planning.transitionError') : undefined;
  return <Page actions={actions} className={styles.page} title={event.title} wide>
    <Link className={styles.backLink} search={search} to="/planning"><ArrowLeft aria-hidden="true" size={17} />{t('planning.backToCalendar')}</Link>
    <div className={styles.detailLayout}>
      <div>
        <section className={styles.detailCard}>
          <div className={styles.detailBadges}><PlanningEventTypeBadge type={event.eventType} /><span className={styles.statusBadge}>{t(`planning.status.${event.status}`)}</span></div>
          {seriesQuery.data ? <div className={styles.seriesSummary}><Repeat2 aria-hidden="true" size={18} /><span><strong>{t('planning.recurrence.series')}</strong>{planningRecurrenceSummary(seriesQuery.data.recurrence, t)}</span>{event.isSeriesException ? <small>{t('planning.recurrence.exception')}</small> : null}</div> : null}
          <dl className={styles.detailMeta}>
            {event.allDay ? <div><dt>{t(event.endDateExclusive === planningEndDateExclusive(event.startDate) ? 'planning.fields.date' : 'planning.fields.period')}</dt><dd><time dateTime={event.startDate}>{formatPlanningAllDayRange(event.startDate, event.endDateExclusive)}</time> · {t('planning.allDay')}</dd></div> : <>
              <div><dt>{t('planning.fields.start')}</dt><dd><time dateTime={event.startsAt}>{formatPlanningDateTime(event.startsAt, timeZone)}</time></dd></div>
              {event.endsAt ? <div><dt>{t('planning.fields.end')}</dt><dd><time dateTime={event.endsAt}>{formatPlanningDateTime(event.endsAt, timeZone)}</time></dd></div> : null}
            </>}
            {event.location ? <div><dt>{t('planning.fields.location')}</dt><dd>{event.location}</dd></div> : null}
            {event.responseDeadline ? <div><dt>{t('planning.fields.deadline')}</dt><dd><time dateTime={event.responseDeadline}>{formatPlanningDateTime(event.responseDeadline, timeZone)}</time></dd></div> : null}
          </dl>
          {event.description ? <p>{event.description}</p> : null}
        </section>
        {event.eventType !== 'APPOINTMENT' ? <section className={styles.detailCard} aria-labelledby="participation-title"><h2 id="participation-title">{t('planning.participation.title')}</h2><ParticipationAction event={event} /></section> : null}
      </div>
      {event.eventType !== 'APPOINTMENT' ? <aside>
        <section className={styles.detailCard}><h2>{t('planning.counts.title')}</h2><EventCounts event={event} /></section>
        {event.canViewParticipants || manageAll ? <section className={styles.detailCard}><h2>{t('planning.participants')}</h2>{participantsQuery.isLoading ? <StatePanel kind="loading" /> : participantsQuery.isError ? <StatePanel actionLabel={t('common.retry')} kind="error" message={t('planning.participantsError')} onAction={() => void participantsQuery.refetch()} /> : <><ul className={styles.participantList}>{participants.map((participant) => <li key={participant.membershipId}><span><Avatar name={participant.displayName} size="small" src={participant.avatarUrl} /> {participant.displayName}</span><small>{participant.effectiveStatus ? t(`planning.participation.${participant.effectiveStatus.toLowerCase()}`) : t('planning.counts.unanswered')}</small></li>)}</ul>{participantsQuery.hasNextPage ? <Button disabled={participantsQuery.isFetchingNextPage} leadingIcon={<UsersRound size={17} />} onClick={() => void participantsQuery.fetchNextPage()} variant="secondary">{t(participantsQuery.isFetchingNextPage ? 'planning.participantsLoadingMore' : 'planning.participantsLoadMore')}</Button> : null}</>}</section> : null}
      </aside> : null}
    </div>
    <ConfirmationDialog confirmIcon={confirmation === 'cancel' ? <Ban size={17} /> : <CheckCircle size={17} />} confirmLabel={confirmation ? t(`planning.actions.${confirmation}`) : ''} errorMessage={transitionError} message={confirmation ? t(`planning.confirm.${confirmation}`) : ''} onClose={() => setConfirmation(null)} onConfirm={() => confirmation && transition.mutate(confirmation)} open={confirmation !== null} pending={transition.isPending} title={t('planning.confirm.title')} tone={confirmation === 'cancel' ? 'danger' : 'default'} />
    <PlanningSeriesScopeDialog action="cancel" errorMessage={cancelError} onClose={() => setCancelScopeOpen(false)} onConfirm={(scope) => cancelSeries.mutate(scope)} onScopeChange={setCancelScope} open={cancelScopeOpen} pending={cancelSeries.isPending} scope={cancelScope} />
  </Page>;
}
