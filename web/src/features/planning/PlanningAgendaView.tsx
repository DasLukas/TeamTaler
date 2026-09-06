import { useTranslation } from 'react-i18next';
import type { PlanningEvent } from '@/api/types';
import { StatePanel } from '@/components/ui/StatePanel';
import { PlanningEventCard } from './PlanningEventCard';
import type { PlanningSearch } from './planningSearch';
import styles from './Planning.module.css';

/** Properties accepted by the bounded planning agenda. */
export interface PlanningAgendaViewProps {
  byDate: ReadonlyMap<string, readonly PlanningEvent[]>;
  dateKeys: readonly string[];
  navigationSearch: PlanningSearch;
  timeZone: string;
}

function formatAgendaDate(key: string): string {
  return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'long', timeZone: 'UTC', weekday: 'long' }).format(new Date(`${key}T12:00:00Z`));
}

/** Renders event-day groups for a finite day, month selection, or agenda range. */
export function PlanningAgendaView({ byDate, dateKeys, navigationSearch, timeZone }: PlanningAgendaViewProps) {
  const { t } = useTranslation();
  const populatedDates = dateKeys.filter((key) => (byDate.get(key)?.length ?? 0) > 0);
  return <section aria-label={t('planning.agenda')} className={styles.agenda}>
    {populatedDates.length === 0 ? <StatePanel kind="empty" message={t('planning.empty')} /> : populatedDates.map((key) => <div className={styles.dayGroup} key={key}>
      <h2><time dateTime={key}>{formatAgendaDate(key)}</time></h2>
      {(byDate.get(key) ?? []).map((event) => <PlanningEventCard event={event} key={event.id} navigationSearch={navigationSearch} timeZone={timeZone} />)}
    </div>)}
  </section>;
}
