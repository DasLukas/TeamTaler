import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left';
import Ban from 'lucide-react/dist/esm/icons/ban';
import CheckCircle from 'lucide-react/dist/esm/icons/check-circle';
import Edit from 'lucide-react/dist/esm/icons/edit';
import Repeat2 from 'lucide-react/dist/esm/icons/repeat-2';
import UsersRound from 'lucide-react/dist/esm/icons/users-round';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '@/api/client';
import type { PlanningEvent, PlanningParticipant, PlanningParticipantPage, PlanningParticipationStatus, PlanningSeriesScope } from '@/api/types';
import { can } from '@/app/permissions';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { StatePanel } from '@/components/ui/StatePanel';
import { ParticipationAction } from './ParticipationAction';
import { PlanningEventTypeBadge } from './PlanningEventType';
import { planningRecurrenceSummaryParts } from './planningRecurrence';
import { PlanningSeriesScopeDialog } from './PlanningSeriesScopeDialog';
import { formatPlanningDateTime } from './planningDate';
import { planningKeys } from './planningQueryKeys';
import type { PlanningSearch } from './planningSearch';
import { formatPlanningAllDayRange, planningEndDateExclusive } from './planningTiming';
import styles from './Planning.module.css';

type Transition = 'close' | 'complete' | 'cancel';
type ParticipantResponseGroupStatus = PlanningParticipationStatus | 'WITHDRAWN' | 'UNANSWERED';
type ParticipantGroupStatus = ParticipantResponseGroupStatus | 'INVITED';

interface ParticipantGroup {
  status: ParticipantGroupStatus;
  participants: PlanningParticipant[];
}

const PARTICIPANT_STATUS_ORDER: Record<ParticipantResponseGroupStatus, number> = {
  ATTENDING: 0,
  MAYBE: 1,
  WAITLISTED: 2,
  DECLINED: 3,
  UNANSWERED: 4,
  WITHDRAWN: 5,
};
const PARTICIPANT_NAME_COLLATOR = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/**
 * Resolves the visible response group for one participant.
 *
 * @param participant - Participant projection returned by the planning API.
 * @returns The effective response or the explicit unanswered group.
 */
function getParticipantGroupStatus(participant: PlanningParticipant): ParticipantResponseGroupStatus {
  return participant.effectiveStatus ?? 'UNANSWERED';
}

/**
 * Sorts event participants by their displayed response and then by name.
 *
 * @param participants - Participant projections loaded for the event.
 * @returns A new array ordered by response priority and German alphabetical rules.
 */
function sortPlanningParticipants(participants: PlanningParticipant[]): PlanningParticipant[] {
  return [...participants].sort((left, right) => {
    const leftOrder = PARTICIPANT_STATUS_ORDER[getParticipantGroupStatus(left)];
    const rightOrder = PARTICIPANT_STATUS_ORDER[getParticipantGroupStatus(right)];
    return leftOrder - rightOrder || PARTICIPANT_NAME_COLLATOR.compare(left.displayName, right.displayName);
  });
}

/**
 * Groups participants into response sections or one alphabetical invitation section.
 *
 * @param participants - Participant projections loaded for the event.
 * @param invitationsOnly - Whether the event has no response workflow.
 * @returns Display groups with names sorted alphabetically inside each group.
 */
function groupPlanningParticipants(participants: PlanningParticipant[], invitationsOnly: boolean): ParticipantGroup[] {
  if (invitationsOnly) {
    if (participants.length === 0) return [];
    return [{
      status: 'INVITED',
      participants: [...participants].sort((left, right) => PARTICIPANT_NAME_COLLATOR.compare(left.displayName, right.displayName)),
    }];
  }
  return sortPlanningParticipants(participants).reduce<ParticipantGroup[]>((groups, participant) => {
    const status = getParticipantGroupStatus(participant);
    const currentGroup = groups.at(-1);
    if (currentGroup?.status === status) currentGroup.participants.push(participant);
    else groups.push({ status, participants: [participant] });
    return groups;
  }, []);
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
  const participantGroups = useMemo(
    () => groupPlanningParticipants(participantsQuery.data?.pages.flatMap((page) => page.items) ?? [], event?.eventType === 'APPOINTMENT'),
    [event?.eventType, participantsQuery.data?.pages],
  );
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
  const canClose = canEdit && event.status === 'PUBLISHED'
    && (event.eventType === 'APPOINTMENT_POLL' || event.eventType === 'APPOINTMENT_REGISTRATION');
  const canCancel = (event.canCancel || manageAll) && event.status === 'PUBLISHED';
  const canViewParticipants = event.canViewParticipants || manageAll;
  const hasResponseSummary = event.eventType !== 'APPOINTMENT';
  const hasDetailSidebar = hasResponseSummary || canViewParticipants;
  const recurrenceSummary = seriesQuery.data ? planningRecurrenceSummaryParts(seriesQuery.data.recurrence, t) : null;
  const transitionError = transition.error instanceof ApiError && (transition.error.problem.status === 409 || transition.error.problem.status === 412) ? t('planning.form.conflictError') : transition.isError ? t('planning.transitionError') : undefined;
  const cancelError = cancelSeries.error instanceof ApiError && (cancelSeries.error.problem.status === 409 || cancelSeries.error.problem.status === 412) ? t('planning.form.conflictError') : cancelSeries.isError ? t('planning.transitionError') : undefined;
  return <Page className={styles.page} title={event.title} wide>
    <div>
      <div className={styles.detailNavigation}>
        <Link className={styles.backLink} search={search} to="/planning"><ArrowLeft aria-hidden="true" size={17} />{t('planning.backToCalendar')}</Link>
        {canCancel || canEdit ? <div className={styles.detailNavigationActions}>
          {canCancel ? <Button aria-label={t('planning.actions.cancel')} collapseLabelAt="narrow" leadingIcon={<Ban size={16} />} onClick={openCancellation} title={t('planning.actions.cancel')} variant="danger">{t('planning.actions.cancel')}</Button> : null}
          {canEdit ? <Link aria-label={t('common.edit')} className={`${styles.buttonLink} ${styles.detailEditLink}`} params={{ eventId }} search={search} title={t('common.edit')} to="/planning/events/$eventId/edit"><Edit aria-hidden="true" size={16} /><span className={styles.detailEditLabel}>{t('common.edit')}</span></Link> : null}
        </div> : null}
      </div>
      <div className={`${styles.detailLayout} ${hasDetailSidebar ? '' : styles.detailLayoutSingle}`}>
        <div>
          <section className={styles.detailCard}>
            <div className={styles.detailBadges}><PlanningEventTypeBadge type={event.eventType} /><span className={styles.statusBadge}>{t(`planning.status.${event.status}`)}</span></div>
            <div className={styles.detailSections}>
              {event.location ? <dl className={styles.detailMeta}><div><dt>{t('planning.fields.location')}</dt><dd>{event.location}</dd></div></dl> : null}
              {event.description ? <p className={styles.detailDescription}>{event.description}</p> : null}
              <dl className={styles.detailMeta}>
                {event.allDay ? <div><dt>{t(event.endDateExclusive === planningEndDateExclusive(event.startDate) ? 'planning.fields.date' : 'planning.fields.period')}</dt><dd><time dateTime={event.startDate}>{formatPlanningAllDayRange(event.startDate, event.endDateExclusive)}</time> · {t('planning.allDay')}</dd></div> : <>
                  <div><dt>{t('planning.fields.start')}</dt><dd><time dateTime={event.startsAt}>{formatPlanningDateTime(event.startsAt, timeZone)}</time></dd></div>
                  {event.endsAt ? <div><dt>{t('planning.fields.end')}</dt><dd><time dateTime={event.endsAt}>{formatPlanningDateTime(event.endsAt, timeZone)}</time></dd></div> : null}
                </>}
              </dl>
              {recurrenceSummary ? <div className={styles.seriesSummary}><Repeat2 aria-hidden="true" size={18} /><span className={styles.seriesSummaryText}><span>{recurrenceSummary.pattern}</span><span aria-hidden="true" className={styles.seriesSummarySeparator}>·</span><span>{recurrenceSummary.range}</span></span>{event.isSeriesException ? <small>{t('planning.recurrence.exception')}</small> : null}</div> : null}
            </div>
          </section>
        </div>
        {hasDetailSidebar ? <aside>
          {hasResponseSummary ? <section aria-labelledby="response-summary-title" className={styles.detailCard}>
            <h2 id="response-summary-title">{t('planning.counts.title')}</h2>
            <ParticipationAction event={event} mode="summary" />
            {event.responseDeadline || canClose ? <div className={styles.detailCountsActions}>
              {event.responseDeadline ? <dl className={styles.responseDeadline}><div><dt>{t('planning.fields.deadline')}</dt><dd><time dateTime={event.responseDeadline}>{formatPlanningDateTime(event.responseDeadline, timeZone)}</time></dd></div></dl> : null}
              {canClose ? <Button leadingIcon={<CheckCircle size={16} />} onClick={() => setConfirmation('close')} size="small" variant="ghost">{t('planning.actions.close')}</Button> : null}
            </div> : null}
          </section> : null}
          {canViewParticipants ? <section className={styles.detailCard}><h2>{t('planning.participants')}</h2>{participantsQuery.isLoading ? <StatePanel kind="loading" /> : participantsQuery.isError ? <StatePanel actionLabel={t('common.retry')} kind="error" message={t('planning.participantsError')} onAction={() => void participantsQuery.refetch()} /> : participantGroups.length === 0 ? <p className={styles.participantsEmpty}>{t('planning.participantsEmpty')}</p> : <><div className={styles.participantGroups}>{participantGroups.map((group) => {
            const groupId = `participant-group-${event.id}-${group.status.toLowerCase()}`;
            const groupLabel = group.status === 'INVITED' ? t('planning.participantsInvited') : group.status === 'UNANSWERED' ? t('planning.counts.unanswered') : t(`planning.participation.${group.status.toLowerCase()}`);
            return <section aria-labelledby={groupId} className={styles.participantGroup} key={group.status}><h3 id={groupId}><span>{groupLabel}</span><small>{group.participants.length}</small></h3><ul className={styles.participantList}>{group.participants.map((participant) => <li key={participant.membershipId}><Avatar name={participant.displayName} size="small" src={participant.avatarUrl} /><span>{participant.displayName}</span></li>)}</ul></section>;
          })}</div>{participantsQuery.hasNextPage ? <Button disabled={participantsQuery.isFetchingNextPage} leadingIcon={<UsersRound size={17} />} onClick={() => void participantsQuery.fetchNextPage()} variant="secondary">{t(participantsQuery.isFetchingNextPage ? 'planning.participantsLoadingMore' : 'planning.participantsLoadMore')}</Button> : null}</>}</section> : null}
        </aside> : null}
      </div>
    </div>
    <ConfirmationDialog confirmIcon={confirmation === 'cancel' ? <Ban size={17} /> : <CheckCircle size={17} />} confirmLabel={confirmation ? t(`planning.actions.${confirmation}`) : ''} errorMessage={transitionError} message={confirmation ? t(`planning.confirm.${confirmation}`) : ''} onClose={() => setConfirmation(null)} onConfirm={() => confirmation && transition.mutate(confirmation)} open={confirmation !== null} pending={transition.isPending} title={t('planning.confirm.title')} tone={confirmation === 'cancel' ? 'danger' : 'default'} />
    <PlanningSeriesScopeDialog action="cancel" errorMessage={cancelError} onClose={() => setCancelScopeOpen(false)} onConfirm={(scope) => cancelSeries.mutate(scope)} onScopeChange={setCancelScope} open={cancelScopeOpen} pending={cancelSeries.isPending} scope={cancelScope} />
  </Page>;
}
