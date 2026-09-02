import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left';
import Save from 'lucide-react/dist/esm/icons/save';
import Send from 'lucide-react/dist/esm/icons/send';
import X from 'lucide-react/dist/esm/icons/x';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '@/api/client';
import type { PlanningEvent, PlanningEventInput, PlanningSeries, PlanningSeriesScope } from '@/api/types';
import { can } from '@/app/permissions';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { Button } from '@/components/ui/Button';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { Field, TextInput } from '@/components/ui/FormField';
import { StatePanel } from '@/components/ui/StatePanel';
import { Toggle } from '@/components/ui/Toggle';
import { PlanningAudiencePicker } from './PlanningAudiencePicker';
import { PlanningEventTypeSelect } from './PlanningEventType';
import { PlanningRecurrenceField } from './PlanningRecurrenceField';
import { PlanningSeriesScopeDialog } from './PlanningSeriesScopeDialog';
import { PlanningTimingFields, type PlanningTimingFormValue } from './PlanningTimingFields';
import { planningAudienceIsReduced } from './planningAudience';
import { zonedDateKey, zonedDateTimeInputToIso } from './planningDate';
import { defaultPlanningFormState, planningDeadlineHoursToMinutes, planningFormStateFromEvent, type PlanningFormState, usePlanningFormState } from './planningFormState';
import { planningKeys } from './planningQueryKeys';
import { planningRecurrenceEndIsValid, planningRecurrenceIncludesAnchor, planningRecurrenceIsEditable } from './planningRecurrence';
import { planningContextSearch, type PlanningSearch } from './planningSearch';
import { isPlanningDateKey, planningAllDayRangeIsValid, planningEndDateExclusive } from './planningTiming';
import styles from './Planning.module.css';

interface PersistedFormResult {
  event: PlanningEvent;
  series?: PlanningSeries;
}

function safeZonedIso(value: string, timeZone: string): string | undefined {
  if (!value) return undefined;
  try { return zonedDateTimeInputToIso(value, timeZone); } catch { return undefined; }
}

/** Renders the accessible create/edit form for individual and recurring planning events. */
export function PlanningEventFormPage({ mode }: { mode: 'create' | 'edit' }) {
  const { eventId = '' } = useParams({ strict: false }) as { eventId?: string };
  const search = useSearch({ strict: false }) as PlanningSearch;
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeGroupId, activeGroup } = useActiveGroup();
  const grants = activeGroup.membership?.effectiveGrants;
  const canManage = can(grants, 'MANAGE_PLANNING_EVENTS');
  const canCreate = can(grants, 'CREATE_PLANNING_EVENTS') || canManage;
  const canReadRoles = can(grants, 'ROLE_MANAGEMENT') || can(grants, 'MEMBER_MANAGEMENT') || can(grants, 'GROUP_ADMINISTRATION');
  const canReadMembers = can(grants, 'VIEW_MEMBER_DIRECTORY') || can(grants, 'MEMBER_MANAGEMENT') || can(grants, 'GROUP_ADMINISTRATION');
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const [confirmStartChange, setConfirmStartChange] = useState(false);
  const [scopeDialogOpen, setScopeDialogOpen] = useState(false);
  const [seriesScope, setSeriesScope] = useState<PlanningSeriesScope>('THIS');
  const settingsQuery = useQuery({ queryKey: planningKeys.settings(activeGroupId), queryFn: () => api.getPlanningSettings(activeGroupId), staleTime: 60_000 });
  const groupTimeZone = settingsQuery.data?.timeZone ?? browserTimeZone;
  const rolesQuery = useQuery({ queryKey: ['roles', activeGroupId], queryFn: () => api.getRoles(activeGroupId), enabled: canCreate && canReadRoles });
  const membersQuery = useQuery({ queryKey: ['members', activeGroupId], queryFn: () => api.getMembers(activeGroupId), enabled: canCreate && canReadMembers });
  const eventQuery = useQuery({ queryKey: planningKeys.event(activeGroupId, eventId), queryFn: () => api.getPlanningEvent(activeGroupId, eventId), enabled: mode === 'edit' && canCreate });
  const eventSeriesId = eventQuery.data?.seriesId ?? '';
  const seriesQuery = useQuery({ queryKey: planningKeys.series(activeGroupId, eventSeriesId), queryFn: () => api.getPlanningSeries(activeGroupId, eventSeriesId), enabled: mode === 'edit' && Boolean(eventSeriesId) });
  const timeZone = seriesQuery.data?.timeZone ?? groupTimeZone;
  const recurrenceEditable = planningRecurrenceIsEditable(mode, eventSeriesId);
  const initialFormState = useMemo(() => mode === 'edit' && eventQuery.data
    ? planningFormStateFromEvent(eventQuery.data, seriesQuery.data?.recurrence ?? null, timeZone)
    : defaultPlanningFormState(timeZone, search.date, mode === 'create' ? search.time : undefined), [eventQuery.data, mode, search.date, search.time, seriesQuery.data?.recurrence, timeZone]);
  const formInitializationKey = mode === 'create'
    ? `create:${timeZone}:${search.date ?? ''}:${search.time ?? ''}`
    : `edit:${eventQuery.data?.id ?? eventId}:${seriesQuery.data?.id ?? (eventSeriesId ? 'series-pending' : 'one-off')}:${timeZone}`;
  const [state, updateState] = usePlanningFormState(formInitializationKey, initialFormState);

  const startIso = useMemo(() => state.allDay ? undefined : safeZonedIso(state.startsAt, timeZone), [state.allDay, state.startsAt, timeZone]);
  const endIso = useMemo(() => state.allDay ? undefined : safeZonedIso(state.endsAt, timeZone), [state.allDay, state.endsAt, timeZone]);
  const startDateValid = isPlanningDateKey(state.startDate);
  const endDateValid = isPlanningDateKey(state.endDate);
  const allDayRangeValid = planningAllDayRangeIsValid(state.startDate, state.endDate);
  const deadlineMinutes = planningDeadlineHoursToMinutes(state.responseDeadlineHoursBefore);
  const input = useMemo<PlanningEventInput>(() => ({
    eventType: state.eventType,
    title: state.title.trim(),
    description: state.description.trim() || undefined,
    location: state.location.trim() || undefined,
    responseDeadlineMinutesBefore: state.eventType !== 'APPOINTMENT' ? deadlineMinutes : undefined,
    capacity: state.eventType === 'APPOINTMENT_REGISTRATION' && Number(state.capacity) > 0 ? Number(state.capacity) : undefined,
    waitlistEnabled: state.eventType === 'APPOINTMENT_REGISTRATION' && state.waitlistEnabled,
    audience: { type: state.audienceType, roleIds: state.audienceType === 'ALL_ACTIVE_MEMBERS' ? [] : state.roleIds, memberIds: state.audienceType === 'ALL_ACTIVE_MEMBERS' ? [] : state.memberIds },
    ...(state.allDay
      ? { allDay: true as const, startDate: state.startDate, endDateExclusive: allDayRangeValid ? planningEndDateExclusive(state.endDate) : '' }
      : { allDay: false as const, startsAt: startIso ?? '', endsAt: endIso }),
  }), [allDayRangeValid, deadlineMinutes, endIso, startIso, state]);
  const published = eventQuery.data?.status === 'PUBLISHED';
  const timingChanged = Boolean(eventQuery.data && (state.allDay
    ? !eventQuery.data.allDay || eventQuery.data.startDate !== state.startDate || eventQuery.data.endDateExclusive !== (allDayRangeValid ? planningEndDateExclusive(state.endDate) : '')
    : eventQuery.data.allDay || !startIso || new Date(startIso).getTime() !== new Date(eventQuery.data.startsAt).getTime() || (endIso ? new Date(endIso).getTime() : undefined) !== (eventQuery.data.endsAt ? new Date(eventQuery.data.endsAt).getTime() : undefined)));
  const startChanged = Boolean(published && timingChanged);
  const waitlistCapacityValid = state.eventType !== 'APPOINTMENT_REGISTRATION' || !state.waitlistEnabled || Number(state.capacity) > 0;
  const deadlineValid = state.eventType === 'APPOINTMENT' || !state.responseDeadlineHoursBefore.trim() || deadlineMinutes !== undefined;
  const recurrenceAnchor = state.allDay ? state.startDate : state.startsAt;
  const recurrenceAnchorValid = planningRecurrenceIncludesAnchor(state.recurrence, recurrenceAnchor);
  const recurrenceValid = !state.recurrence || state.recurrence.interval >= 1 && state.recurrence.interval <= 99 && recurrenceAnchorValid && (state.recurrence.range.type !== 'COUNT' || state.recurrence.range.count >= 2 && state.recurrence.range.count <= 500) && (state.recurrence.range.type !== 'UNTIL' || state.recurrence.range.until >= recurrenceAnchor.slice(0, 10));
  const endValid = state.allDay ? allDayRangeValid : planningRecurrenceEndIsValid(state.recurrence, startIso, endIso, state.endsAt);
  const timingValid = state.allDay ? allDayRangeValid : Boolean(startIso) && endValid;
  const valid = input.title.length > 0 && timingValid && endValid && deadlineValid && waitlistCapacityValid && recurrenceValid && (state.audienceType === 'ALL_ACTIVE_MEMBERS' || state.roleIds.length + state.memberIds.length > 0);
  const audienceReduced = Boolean(published && eventSeriesId && eventQuery.data && planningAudienceIsReduced(eventQuery.data.audience, input.audience));
  const mutation = useMutation({
    mutationFn: async ({ scope }: { scope?: PlanningSeriesScope }): Promise<PersistedFormResult> => {
      const currentEvent = eventQuery.data;
      const currentSeries = seriesQuery.data;
      if (mode === 'edit' && currentEvent) {
        if (currentSeries && scope && scope !== 'THIS') {
          const series = await api.updatePlanningSeries(activeGroupId, currentSeries.id, { ...input, recurrence: state.recurrence ?? currentSeries.recurrence, scope, fromOriginalStartAt: currentEvent.originalStartAt ?? currentEvent.startsAt }, currentSeries.version);
          return { event: await api.getPlanningEvent(activeGroupId, eventId), series };
        }
        return { event: await api.updatePlanningEvent(activeGroupId, eventId, input, currentEvent.version) };
      }
      if (state.recurrence) {
        const result = await api.createPlanningSeries(activeGroupId, { ...input, recurrence: state.recurrence });
        if (!result.firstOccurrence) throw new Error('Planning series response did not include its first occurrence.');
        return { event: result.firstOccurrence, series: result.series };
      }
      return { event: await api.createPlanningEvent(activeGroupId, input) };
    },
    onSuccess: async ({ event, series }) => {
      setConfirmStartChange(false);
      setScopeDialogOpen(false);
      queryClient.setQueryData(planningKeys.event(activeGroupId, event.id), event);
      if (series) queryClient.setQueryData(planningKeys.series(activeGroupId, series.id), series);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: planningKeys.events(activeGroupId) }),
        queryClient.invalidateQueries({ queryKey: ['dashboard', activeGroupId] }),
      ]);
      const contextualSearch = { date: search.date ?? (event.allDay ? event.startDate : zonedDateKey(event.startsAt, timeZone)), view: search.view ?? 'week' as const };
      await navigate({ to: '/planning/events/$eventId', params: { eventId: event.id }, search: contextualSearch });
    },
  });
  if (!canCreate) return <Page title={t(mode === 'create' ? 'planning.form.createTitle' : 'planning.form.editTitle')}><StatePanel kind="empty" message={t('planning.noCreateAccess')} /></Page>;
  const seriesLoading = Boolean(eventSeriesId) && seriesQuery.isLoading;
  if (settingsQuery.isLoading || mode === 'edit' && eventQuery.isLoading || seriesLoading || canReadRoles && rolesQuery.isLoading || canReadMembers && membersQuery.isLoading) return <Page title={t('planning.form.editTitle')}><StatePanel kind="loading" /></Page>;
  if (settingsQuery.isError || mode === 'edit' && (eventQuery.isError || !eventQuery.data) || seriesQuery.isError || canReadRoles && rolesQuery.isError || canReadMembers && membersQuery.isError) return <Page title={t('planning.form.editTitle')}><StatePanel kind="error" message={t('planning.form.loadError')} /></Page>;
  if (mode === 'edit' && !eventQuery.data?.canEdit && !canManage) return <Page title={t('planning.form.editTitle')}><StatePanel kind="empty" message={t('planning.noEditAccess')} /></Page>;
  const set = <Key extends keyof PlanningFormState>(key: Key, value: PlanningFormState[Key]) => updateState((current) => ({ ...current, [key]: value }));
  const setTiming = (timing: PlanningTimingFormValue) => updateState((current) => ({ ...current, ...timing }));
  const save = () => {
    if (mode === 'edit' && eventSeriesId) {
      setSeriesScope('THIS');
      setScopeDialogOpen(true);
      return;
    }
    if (startChanged) setConfirmStartChange(true);
    else mutation.mutate({});
  };
  const mutationError = mutation.error instanceof ApiError && (mutation.error.problem.status === 409 || mutation.error.problem.status === 412)
    ? t('planning.form.conflictError')
    : mutation.isError ? t('planning.form.saveError') : undefined;
  const contextSearch = planningContextSearch(search);
  return <Page className={styles.page} title={t(mode === 'create' ? 'planning.form.createTitle' : 'planning.form.editTitle')}>
    {mode === 'edit'
      ? <Link className={styles.backLink} params={{ eventId }} search={contextSearch} to="/planning/events/$eventId"><ArrowLeft aria-hidden="true" size={17} />{t('planning.backToCalendar')}</Link>
      : <Link className={styles.backLink} search={contextSearch} to="/planning"><ArrowLeft aria-hidden="true" size={17} />{t('planning.backToCalendar')}</Link>}
    <form className={styles.form} onSubmit={(event) => { event.preventDefault(); save(); }}>
      <section className={styles.formSection}><h2>{t('planning.form.basics')}</h2><div className={styles.formGrid}>
        <Field hint={published ? t('planning.form.publishedLocked') : undefined} htmlFor="planning-type" label={t('planning.fields.type')}><PlanningEventTypeSelect disabled={published} id="planning-type" onChange={(value) => set('eventType', value)} value={state.eventType} /></Field>
        <Field htmlFor="planning-title" label={t('planning.fields.title')} required><TextInput id="planning-title" maxLength={160} onChange={(event) => set('title', event.target.value)} required value={state.title} /></Field>
        <Field htmlFor="planning-location" label={t('planning.fields.location')}><TextInput id="planning-location" maxLength={240} onChange={(event) => set('location', event.target.value)} value={state.location} /></Field>
        <Field htmlFor="planning-description" label={t('planning.fields.description')}><textarea className={styles.textarea} id="planning-description" maxLength={4000} onChange={(event) => set('description', event.target.value)} value={state.description} /></Field>
      </div></section>
      <section className={styles.formSection}><h2>{t('planning.form.schedule')}</h2><div className={styles.formGrid}>
        <PlanningTimingFields allDay={state.allDay} endDate={state.endDate} endError={state.allDay ? !endDateValid ? t('planning.form.dateRequired') : startDateValid && state.endDate < state.startDate ? t('planning.form.allDayEndError') : undefined : state.recurrence && !state.endsAt ? t('planning.recurrence.endRequired') : state.endsAt && !endIso ? t('planning.form.timeZoneError') : state.endsAt && startIso && endIso && new Date(endIso) <= new Date(startIso) ? t('planning.form.endError') : undefined} endRequired={Boolean(state.recurrence)} endsAt={state.endsAt} onChange={setTiming} startDate={state.startDate} startError={state.allDay ? !startDateValid ? t('planning.form.dateRequired') : undefined : state.startsAt && !startIso ? t('planning.form.timeZoneError') : undefined} startsAt={state.startsAt} />
        {recurrenceEditable ? <div className={styles.spanTwo}><Field error={!recurrenceAnchorValid ? t('planning.recurrence.anchorRequired') : undefined} hint={published && eventSeriesId ? t('planning.recurrence.publishedHint') : undefined} htmlFor="planning-recurrence" label={t('planning.recurrence.label')}><PlanningRecurrenceField allowNone={!eventSeriesId} onChange={(recurrence) => set('recurrence', recurrence)} startsAt={recurrenceAnchor} value={state.recurrence} /></Field></div> : null}
        {state.eventType !== 'APPOINTMENT' ? <Field hint={t(state.allDay ? 'planning.form.allDayDeadlineHint' : 'planning.form.deadlineHint')} htmlFor="planning-deadline-offset" label={t('planning.fields.deadlineOffset')}><TextInput id="planning-deadline-offset" max={8760} min={0.01} onChange={(event) => set('responseDeadlineHoursBefore', event.target.value)} step="any" type="number" value={state.responseDeadlineHoursBefore} /></Field> : null}
        {state.eventType === 'APPOINTMENT_REGISTRATION' ? <>
          <Field htmlFor="planning-capacity" label={t('planning.fields.capacity')} required={state.waitlistEnabled}><TextInput id="planning-capacity" min={1} onChange={(event) => set('capacity', event.target.value)} required={state.waitlistEnabled} type="number" value={state.capacity} /></Field>
          <div className={styles.toggleOption}>
            <div className={styles.toggleOptionCopy}><strong>{t('planning.fields.waitlist')}</strong><span id="planning-waitlist-description">{t('planning.form.waitlistHint')}</span></div>
            <Toggle checked={state.waitlistEnabled} descriptionId="planning-waitlist-description" label={t('planning.fields.waitlist')} onChange={(checked) => set('waitlistEnabled', checked)} />
          </div>
        </> : null}
      </div></section>
      <section className={styles.formSection}><h2>{t('planning.form.audience')}</h2><PlanningAudiencePicker audienceType={state.audienceType} editMode={published ? eventSeriesId ? 'SERIES_SCOPE' : 'PUBLISHED_ADD_ONLY' : 'EDITABLE'} lockedMemberIds={published && !eventSeriesId ? eventQuery.data?.audience.memberIds : []} lockedRoleIds={published && !eventSeriesId ? eventQuery.data?.audience.roleIds : []} memberIds={state.memberIds} members={membersQuery.data ?? []} onChange={(selection) => updateState((current) => ({ ...current, ...selection }))} roleIds={state.roleIds} roles={rolesQuery.data ?? []} /></section>
      {mutationError && !scopeDialogOpen ? <p className={styles.error} role="alert">{mutationError}</p> : null}
      <footer className={styles.formActions}><Button leadingIcon={<X size={17} />} onClick={() => { const context = planningContextSearch(search); if (mode === 'edit') void navigate({ to: '/planning/events/$eventId', params: { eventId }, search: context }); else void navigate({ to: '/planning', search: context }); }} variant="secondary">{t('common.cancel')}</Button><Button disabled={!valid || mutation.isPending} leadingIcon={mode === 'create' ? <Send size={17} /> : <Save size={17} />} type="submit">{t(mode === 'create' ? 'planning.actions.publish' : 'planning.form.saveChanges')}</Button></footer>
    </form>
    <ConfirmationDialog confirmIcon={<Save size={17} />} confirmLabel={t('planning.form.confirmStartChange')} errorMessage={mutationError} message={t('planning.form.startChangeImpact')} onClose={() => setConfirmStartChange(false)} onConfirm={() => mutation.mutate({})} open={confirmStartChange} pending={mutation.isPending} title={t('planning.form.startChangeTitle')} />
    <PlanningSeriesScopeDialog action="edit" disabledScopes={audienceReduced ? ['THIS'] : []} errorMessage={mutationError} onClose={() => setScopeDialogOpen(false)} onConfirm={(scope) => { if (!(audienceReduced && scope === 'THIS')) mutation.mutate({ scope }); }} onScopeChange={setSeriesScope} open={scopeDialogOpen} pending={mutation.isPending} recurrenceChanged={Boolean(seriesQuery.data && JSON.stringify(state.recurrence) !== JSON.stringify(seriesQuery.data.recurrence))} restrictionMessage={audienceReduced ? t('planning.seriesScope.audienceReductionNote') : undefined} scope={seriesScope} />
  </Page>;
}
