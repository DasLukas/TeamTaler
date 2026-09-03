import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlanningEvent } from '@/api/types';
import { planningAllDaySegment } from './planningCalendar';
import type { PlanningSearch } from './planningSearch';
import { addPlanningDays } from './planningTiming';
import { movePlanningViewAnchor } from './planningView';
import styles from './Planning.module.css';

/** Properties accepted by the Monday-first month calendar. */
export interface PlanningMonthViewProps {
  byDate: ReadonlyMap<string, readonly PlanningEvent[]>;
  canCreate: boolean;
  dateKeys: readonly string[];
  navigationSearch: PlanningSearch;
  onCreate: (search: PlanningSearch) => void;
  onSelectDate: (key: string) => void;
  selectedKey: string;
  todayKey: string;
}

function formatMonthDay(key: string): string {
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`));
}

function moveMonthCell(key: string, keyboardKey: string): string | undefined {
  if (keyboardKey === 'ArrowLeft') return addPlanningDays(key, -1);
  if (keyboardKey === 'ArrowRight') return addPlanningDays(key, 1);
  if (keyboardKey === 'ArrowUp') return addPlanningDays(key, -7);
  if (keyboardKey === 'ArrowDown') return addPlanningDays(key, 7);
  const weekday = (new Date(`${key}T12:00:00Z`).getUTCDay() + 6) % 7;
  if (keyboardKey === 'Home') return addPlanningDays(key, -weekday);
  if (keyboardKey === 'End') return addPlanningDays(key, 6 - weekday);
  if (keyboardKey === 'PageUp') return movePlanningViewAnchor('month', key, -1);
  if (keyboardKey === 'PageDown') return movePlanningViewAnchor('month', key, 1);
  return undefined;
}

/** Renders a keyboard-navigable six-week month grid. */
export function PlanningMonthView({ byDate, canCreate, dateKeys, navigationSearch, onCreate, onSelectDate, selectedKey, todayKey }: PlanningMonthViewProps) {
  const { t } = useTranslation();
  const selectedMonth = selectedKey.slice(0, 7);
  const selectedDateLabel = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', timeZone: 'UTC', weekday: 'long' }).format(new Date(`${selectedKey}T12:00:00Z`));
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, key: string) => {
    const next = moveMonthCell(key, event.key);
    if (!next) return;
    event.preventDefault();
    onSelectDate(next);
    window.setTimeout(() => document.querySelector<HTMLButtonElement>(`button[data-planning-date="${next}"]`)?.focus(), 0);
  };
  return <section aria-label={t('planning.month')} className={styles.calendar}>
    <div className={styles.calendarHeader}><strong><time dateTime={selectedKey}>{selectedDateLabel}</time></strong></div>
    <div aria-hidden="true" className={styles.weekdays}>{['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((day) => <span key={day}>{day}</span>)}</div>
    <div className={styles.monthGrid} role="grid">
      {Array.from({ length: 6 }, (_, rowIndex) => <div className={styles.monthRow} key={dateKeys[rowIndex * 7]} role="row">
        {dateKeys.slice(rowIndex * 7, rowIndex * 7 + 7).map((key) => {
          const dayEvents = byDate.get(key) ?? [];
          const count = dayEvents.length;
          const allDayEvents = dayEvents.filter((event) => event.allDay).slice(0, 3);
          const selected = key === selectedKey;
          const ariaLabel = t(selected && canCreate ? 'planning.selectedDayLabel' : 'planning.dayLabel', { count, date: formatMonthDay(key) });
          return <div aria-label={ariaLabel} aria-selected={selected} className={styles.monthGridCell} key={key} role="gridcell">
            <button aria-current={key === todayKey ? 'date' : undefined} aria-label={ariaLabel} className={key.startsWith(selectedMonth) ? '' : styles.outsideMonth} data-planning-date={key} onClick={() => { if (selected && canCreate) onCreate(navigationSearch); else onSelectDate(key); }} onKeyDown={(event) => moveFocus(event, key)} tabIndex={selected ? 0 : -1} type="button">
              <span className={styles.dayNumber}>{Number(key.slice(-2))}</span>
              {allDayEvents.length ? <span aria-hidden="true" className={styles.allDayMarkers}>{allDayEvents.map((event) => { const segment = planningAllDaySegment(event, key); return segment ? <span className={`${styles.allDayMarker} ${styles[`allDayMarker_${segment}`]}`} data-segment={segment} key={event.id} /> : null; })}</span> : null}
              {count > 0 ? <small>{count}</small> : null}
            </button>
          </div>;
        })}
      </div>)}
    </div>
  </section>;
}
