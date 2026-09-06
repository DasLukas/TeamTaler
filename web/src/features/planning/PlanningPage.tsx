import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import Plus from 'lucide-react/dist/esm/icons/plus';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { canCreatePlanningEvents } from '@/app/groupCapabilities';
import { memberPaths } from '@/app/paths';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { StatePanel } from '@/components/ui/StatePanel';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { PlanningAgendaView } from './PlanningAgendaView';
import { PlanningMonthView } from './PlanningMonthView';
import { PlanningTimeGrid } from './PlanningTimeGrid';
import { PlanningToolbar } from './PlanningToolbar';
import { groupPlanningEventsByDate } from './planningCalendar';
import { zonedDateKey } from './planningDate';
import { planningKeys } from './planningQueryKeys';
import type { PlanningSearch, PlanningView } from './planningSearch';
import { formatPlanningViewLabel, movePlanningViewAnchor, planningVisibleRange } from './planningView';
import { readPlanningViewPreference, writePlanningViewPreference } from './planningViewPreference';
import { usePlanningEventsRange } from './usePlanningEventsRange';
import styles from './Planning.module.css';

/** Renders the persisted day, week, month, and 90-day agenda calendar. */
export function PlanningPage() {
  const { t } = useTranslation();
  const { activeGroupId, activeGroup } = useActiveGroup();
  const navigate = useNavigate();
  const search = useSearch({ from: '/authenticated/group-required/planning' });
  const [storedView] = useState(readPlanningViewPreference);
  const view: PlanningView = search.view ?? storedView ?? 'week';
  const settingsQuery = useQuery({ queryKey: planningKeys.settings(activeGroupId), queryFn: () => api.getPlanningSettings(activeGroupId), staleTime: 60_000 });
  const timeZone = settingsQuery.data?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const selectedKey = search.date ?? zonedDateKey(new Date(), timeZone);
  const range = useMemo(() => planningVisibleRange(view, selectedKey, timeZone), [selectedKey, timeZone, view]);
  const eventsQuery = usePlanningEventsRange(activeGroupId, range, settingsQuery.isSuccess);
  const byDate = useMemo(() => groupPlanningEventsByDate(eventsQuery.events, timeZone), [eventsQuery.events, timeZone]);
  const navigationSearch = { date: selectedKey, view } satisfies PlanningSearch;
  const todayKey = zonedDateKey(new Date(), timeZone);
  const canCreate = canCreatePlanningEvents(activeGroup.membership?.effectiveGrants);
  const compact = useMediaQuery('(max-width: 767px)');

  useEffect(() => {
    if (!search.view) void navigate({ to: '/planning', search: (current) => ({ date: current.date, view }), replace: true, resetScroll: false });
  }, [navigate, search.view, view]);

  const setSelectedDate = (date: string) => void navigate({ to: '/planning', search: (current) => ({ date, view: current.view ?? view }), replace: true, resetScroll: false });
  const setView = (next: PlanningView) => {
    writePlanningViewPreference(next);
    void navigate({ to: '/planning', search: (current) => ({ date: current.date ?? selectedKey, view: next }), replace: true, resetScroll: false });
  };
  const createEvent = (context: PlanningSearch) => void navigate({ to: memberPaths.planningNew, search: context });
  const movePeriod = (offset: -1 | 1) => setSelectedDate(movePlanningViewAnchor(view, selectedKey, offset));
  const calendar = view === 'month'
    ? <div className={styles.workspace}>
      <PlanningMonthView byDate={byDate} canCreate={canCreate} dateKeys={range.dateKeys} navigationSearch={navigationSearch} onCreate={createEvent} onSelectDate={setSelectedDate} selectedKey={selectedKey} todayKey={todayKey} />
      <PlanningAgendaView byDate={byDate} dateKeys={[selectedKey]} navigationSearch={navigationSearch} timeZone={timeZone} />
    </div>
    : view === 'agenda'
      ? <div className={`${styles.workspace} ${styles.agendaOnly}`}><PlanningAgendaView byDate={byDate} dateKeys={range.dateKeys} navigationSearch={navigationSearch} timeZone={timeZone} /></div>
      : <PlanningTimeGrid dateKeys={range.dateKeys} events={eventsQuery.events} key={`${view}:${selectedKey}:${timeZone}`} navigationSearch={navigationSearch} onCreate={createEvent} onNavigateDate={setSelectedDate} timeZone={timeZone} todayKey={todayKey} view={view} />;

  const createAction = canCreate && !compact
    ? <Link aria-label={t('planning.create')} className={styles.buttonLink} search={navigationSearch} title={t('planning.create')} to={memberPaths.planningNew}><Plus aria-hidden="true" size={18} />{t('planning.actions.createShort')}</Link>
    : null;

  return <Page actions={createAction} className={styles.page} title={t('planning.title')} wide>
    <PlanningToolbar label={formatPlanningViewLabel(view, selectedKey)} onMove={movePeriod} onToday={() => setSelectedDate(todayKey)} onViewChange={setView} view={view} />
    {settingsQuery.isError || eventsQuery.isError
      ? <StatePanel actionLabel={t('common.retry')} kind="error" message={t('planning.loadError')} onAction={() => void Promise.all([settingsQuery.refetch(), eventsQuery.refetch()])} />
      : settingsQuery.isLoading || eventsQuery.isInitialLoading
        ? <StatePanel kind="loading" />
        : <div aria-busy={eventsQuery.isLoadingMore}>{calendar}{eventsQuery.isLoadingMore ? <p aria-live="polite" className={styles.backgroundLoading}>{t('common.loading')}</p> : null}</div>}
    {canCreate && compact ? <Link className={styles.floatingCreateButton} search={navigationSearch} title={t('planning.create')} to={memberPaths.planningNew}><Plus aria-hidden="true" size={26} /><span className={styles.srOnly}>{t('planning.create')}</span></Link> : null}
  </Page>;
}
