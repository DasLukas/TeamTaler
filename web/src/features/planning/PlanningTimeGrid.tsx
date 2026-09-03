import { Link } from '@tanstack/react-router';
import Repeat2 from 'lucide-react/dist/esm/icons/repeat-2';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlanningEvent } from '@/api/types';
import { PlanningEventTypeIcon } from './PlanningEventType';
import { toZonedDateTimeInput, zonedDateKey, zonedDateTimeInputOccurrences, zonedStartOfDay } from './planningDate';
import type { PlanningSearch, PlanningView } from './planningSearch';
import { addPlanningDays, formatPlanningEventTime } from './planningTiming';
import { initialPlanningTimeSlot, layoutPlanningAllDayEvents, layoutPlanningTimedEvents, planningSlotTime, type PlanningTimeSlot } from './planningTimeGridLayout';
import styles from './Planning.module.css';

const hourHeight = 56;

/** Properties accepted by the shared day and week wall-clock grid. */
export interface PlanningTimeGridProps {
  dateKeys: readonly string[];
  events: readonly PlanningEvent[];
  navigationSearch: PlanningSearch;
  onCreate: (search: PlanningSearch) => void;
  onNavigateDate: (key: string) => void;
  timeZone: string;
  todayKey: string;
  view: Extract<PlanningView, 'day' | 'week'>;
}

function formatDayHeading(key: string, compact: boolean): string {
  return new Intl.DateTimeFormat('de-DE', compact ? { day: '2-digit', month: '2-digit', timeZone: 'UTC', weekday: 'short' } : { day: 'numeric', month: 'long', timeZone: 'UTC', weekday: 'long' }).format(new Date(`${key}T12:00:00Z`));
}

function slotSelector(slot: PlanningTimeSlot): string {
  return `button[data-planning-slot="${slot.date}-${slot.minute}"]`;
}

/** Renders an accessible 24-hour grid with a separate spanning all-day lane. */
export function PlanningTimeGrid({ dateKeys, events, navigationSearch, onCreate, onNavigateDate, timeZone, todayKey, view }: PlanningTimeGridProps) {
  const { t } = useTranslation();
  const multiDay = dateKeys.length > 1;
  const cardRef = useRef<HTMLElement>(null);
  const horizontalScrollRef = useRef<HTMLDivElement>(null);
  const verticalScrollRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => new Date());
  const layoutsByDate = useMemo(() => new Map(dateKeys.map((key) => [key, layoutPlanningTimedEvents(events, key, timeZone)] as const)), [dateKeys, events, timeZone]);
  const allDayLayouts = useMemo(() => layoutPlanningAllDayEvents(events, dateKeys), [dateKeys, events]);
  const preferredSlot = useMemo(() => initialPlanningTimeSlot(events, dateKeys, timeZone), [dateKeys, events, timeZone]);
  const slotStatuses = useMemo(() => new Map(dateKeys.flatMap((date) => {
    const transitionDay = zonedStartOfDay(addPlanningDays(date, 1), timeZone).getTime() - zonedStartOfDay(date, timeZone).getTime() !== 24 * 60 * 60_000;
    return Array.from({ length: 48 }, (_, index) => {
      const minute = index * 30;
      const key = `${date}-${minute}`;
      const occupied = (layoutsByDate.get(date) ?? []).some((layout) => layout.startMinute < minute + 30 && layout.endMinute > minute);
      if (!transitionDay) return [key, { ambiguous: false, available: !occupied }] as const;
      try {
        const ambiguous = zonedDateTimeInputOccurrences(`${date}T${planningSlotTime(minute)}`, timeZone).length > 1;
        return [key, { ambiguous, available: !occupied && !ambiguous }] as const;
      } catch {
        return [key, { ambiguous: false, available: false }] as const;
      }
    });
  })), [dateKeys, layoutsByDate, timeZone]);
  const slotAvailable = (slot: PlanningTimeSlot): boolean => slotStatuses.get(`${slot.date}-${slot.minute}`)?.available ?? false;
  const firstAvailableSlot = useMemo(() => {
    const candidates = dateKeys.flatMap((date) => Array.from({ length: 48 }, (_, index) => ({ date, minute: index * 30 })));
    const preferredIndex = candidates.findIndex((slot) => slot.date === preferredSlot.date && slot.minute === preferredSlot.minute);
    const ordered = preferredIndex < 0 ? candidates : [...candidates.slice(preferredIndex), ...candidates.slice(0, preferredIndex)];
    return ordered.find(slotAvailable) ?? preferredSlot;
  // `slotAvailable` depends only on the memoized status map listed below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateKeys, preferredSlot, slotStatuses]);
  const [focusedSlot, setFocusedSlot] = useState(firstAvailableSlot);
  const activeSlot = slotAvailable(focusedSlot) ? focusedSlot : firstAvailableSlot;
  const allDayRows = Math.max(1, ...allDayLayouts.map((layout) => layout.row + 1));
  const gridStyle = { '--planning-day-count': dateKeys.length, '--planning-hour-height': `${hourHeight}px` } as CSSProperties;
  const currentKey = zonedDateKey(now, timeZone);
  const currentInput = toZonedDateTimeInput(now.toISOString(), timeZone);
  const currentMinute = Number(currentInput.slice(11, 13)) * 60 + Number(currentInput.slice(14, 16));

  useEffect(() => {
    const delay = 60_000 - Date.now() % 60_000;
    let interval: number | undefined;
    const timeout = window.setTimeout(() => {
      setNow(new Date());
      interval = window.setInterval(() => setNow(new Date()), 60_000);
    }, delay);
    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, []);

  useLayoutEffect(() => {
    const horizontalViewport = horizontalScrollRef.current;
    const verticalViewport = verticalScrollRef.current;
    if (!horizontalViewport || !verticalViewport) return;
    verticalViewport.scrollTop = Math.max(0, preferredSlot.minute / 60 * hourHeight - 120);
    if (dateKeys.length > 1) {
      const dayIndex = Math.max(0, dateKeys.indexOf(preferredSlot.date));
      const dayWidth = Math.max(132, (horizontalViewport.scrollWidth - 72) / dateKeys.length);
      const scrollLeft = Math.max(0, dayIndex * dayWidth - horizontalViewport.clientWidth / 2 + dayWidth / 2);
      horizontalViewport.scrollLeft = scrollLeft;
      verticalViewport.scrollLeft = scrollLeft;
    }
  }, [dateKeys, preferredSlot.date, preferredSlot.minute]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return undefined;
    const updateAvailableHeight = () => {
      const bottomInset = window.innerWidth < 768 ? 88 : 16;
      const availableHeight = Math.floor(window.innerHeight - card.getBoundingClientRect().top - bottomInset);
      card.style.setProperty('--planning-time-grid-height', `${Math.max(320, Math.min(760, availableHeight))}px`);
    };
    window.addEventListener('resize', updateAvailableHeight);
    window.visualViewport?.addEventListener('resize', updateAvailableHeight);
    updateAvailableHeight();
    return () => {
      window.removeEventListener('resize', updateAvailableHeight);
      window.visualViewport?.removeEventListener('resize', updateAvailableHeight);
    };
  }, []);

  const synchronizeHeaderScroll = () => {
    const headerViewport = horizontalScrollRef.current;
    const bodyViewport = verticalScrollRef.current;
    if (headerViewport && bodyViewport && bodyViewport.scrollLeft !== headerViewport.scrollLeft) bodyViewport.scrollLeft = headerViewport.scrollLeft;
  };
  const synchronizeBodyScroll = () => {
    const headerViewport = horizontalScrollRef.current;
    const bodyViewport = verticalScrollRef.current;
    if (headerViewport && bodyViewport && headerViewport.scrollLeft !== bodyViewport.scrollLeft) headerViewport.scrollLeft = bodyViewport.scrollLeft;
  };

  const focusSlot = (slot: PlanningTimeSlot) => {
    setFocusedSlot(slot);
    window.setTimeout(() => document.querySelector<HTMLButtonElement>(slotSelector(slot))?.focus(), 0);
  };
  const moveSlot = (event: KeyboardEvent<HTMLButtonElement>, slot: PlanningTimeSlot) => {
    let dayOffset = 0;
    let minuteOffset = 0;
    if (event.key === 'ArrowLeft') dayOffset = -1;
    else if (event.key === 'ArrowRight') dayOffset = 1;
    else if (event.key === 'ArrowUp') minuteOffset = -30;
    else if (event.key === 'ArrowDown') minuteOffset = 30;
    else return;
    event.preventDefault();
    if (dayOffset !== 0) {
      const nextDate = addPlanningDays(slot.date, dayOffset);
      const candidate = { date: nextDate, minute: slot.minute };
      if (dateKeys.includes(nextDate)) {
        if (slotAvailable(candidate)) focusSlot(candidate);
        else {
          const fallback = Array.from({ length: 48 }, (_, distance) => [slot.minute + distance * 30, slot.minute - distance * 30]).flat()
            .find((minute) => slotAvailable({ date: nextDate, minute }));
          if (fallback !== undefined) focusSlot({ date: nextDate, minute: fallback });
        }
      } else onNavigateDate(nextDate);
      return;
    }
    for (let minute = slot.minute + minuteOffset; minute >= 0 && minute < 1440; minute += minuteOffset) {
      const candidate = { date: slot.date, minute };
      if (slotAvailable(candidate)) {
        focusSlot(candidate);
        break;
      }
    }
  };

  return <section className={styles.timeGridCard} ref={cardRef}>
    <div aria-label={t('planning.timeGrid')} className={styles.timeGridRegion} role="region" tabIndex={0}>
      <div className={`${styles.timeGridScroll} ${multiDay ? '' : styles.dayTimeGridScroll}`} data-planning-scroll="header" onScroll={synchronizeHeaderScroll} ref={horizontalScrollRef}>
        <div className={`${styles.timeGridCanvas} ${multiDay ? styles.weekTimeGridCanvas : ''}`} style={gridStyle}>
        <div className={styles.timeGridHeader}>
          <span aria-hidden="true" />
          {dateKeys.map((key) => <time aria-current={key === todayKey ? 'date' : undefined} dateTime={key} key={key}>{formatDayHeading(key, view === 'week')}</time>)}
        </div>
        <div className={styles.allDayLane} style={{ ...gridStyle, gridTemplateRows: `repeat(${allDayRows}, minmax(30px, auto))` }}>
          <strong style={{ gridRow: `1 / span ${allDayRows}` }}>{t('planning.allDay')}</strong>
          {allDayLayouts.map((layout) => <Link className={styles.allDayEvent} key={layout.event.id} params={{ eventId: layout.event.id }} search={navigationSearch} style={{ gridColumn: `${layout.startColumn + 2} / ${layout.endColumn + 2}`, gridRow: layout.row + 1 }} title={layout.event.title} to="/planning/events/$eventId"><span>{layout.event.title}</span>{layout.event.seriesId ? <Repeat2 aria-hidden="true" size={13} /> : null}</Link>)}
        </div>
        </div>
      </div>
      <div className={`${styles.timeGridBodyScroll} ${multiDay ? '' : styles.dayTimeGridScroll}`} data-planning-scroll="body" onScroll={synchronizeBodyScroll} ref={verticalScrollRef}>
        <div className={`${styles.timeGridBody} ${multiDay ? styles.weekTimeGridCanvas : ''}`} style={gridStyle}>
            <div aria-hidden="true" className={styles.timeAxis}>{Array.from({ length: 24 }, (_, hour) => <span key={hour} style={{ top: `${hour * hourHeight}px` }}>{planningSlotTime(hour * 60)}</span>)}</div>
            {dateKeys.map((key) => {
              const layouts = layoutsByDate.get(key) ?? [];
              return <div className={styles.timeGridDay} data-date={key} key={key}>
                <div className={styles.slotLayer}>{Array.from({ length: 48 }, (_, index) => {
                  const slot = { date: key, minute: index * 30 };
                  const available = slotAvailable(slot);
                  const ambiguous = slotStatuses.get(`${key}-${slot.minute}`)?.ambiguous ?? false;
                  const time = planningSlotTime(slot.minute);
                  const date = formatDayHeading(key, false);
                  return <button aria-label={ambiguous ? t('planning.dstFoldUnavailable') : t('planning.createAt', { date, time })} className={styles.timeSlot} data-planning-slot={`${key}-${slot.minute}`} disabled={!available} key={time} onClick={() => onCreate({ date: key, time, view })} onKeyDown={(event) => moveSlot(event, slot)} style={{ height: `${hourHeight / 2}px`, top: `${index * hourHeight / 2}px` }} tabIndex={available && activeSlot.date === key && activeSlot.minute === slot.minute ? 0 : -1} title={ambiguous ? t('planning.dstFoldUnavailable') : undefined} type="button" />;
                })}</div>
                {key === currentKey ? <span aria-label={t('planning.currentTime')} className={styles.currentTimeLine} role="img" style={{ top: `${currentMinute / 1440 * 100}%` }}><span /></span> : null}
                <div className={styles.timedEventLayer}>{layouts.map((layout) => {
                  const top = layout.startMinute / 1440 * 100;
                  const height = (layout.endMinute - layout.startMinute) / 1440 * 100;
                  const width = 100 / layout.columnCount;
                  const eventStyle = { height: `${height}%`, left: `${layout.column * width}%`, top: `${top}%`, width: `${width}%` };
                  return <Link aria-label={`${layout.event.title}, ${formatPlanningEventTime(layout.event, timeZone, t('planning.allDay'))}`} className={styles.timedEvent} key={layout.event.id} params={{ eventId: layout.event.id }} search={navigationSearch} style={eventStyle} to="/planning/events/$eventId"><span className={styles.timedEventMeta}><PlanningEventTypeIcon size={12} type={layout.event.eventType} />{formatPlanningEventTime(layout.event, timeZone, t('planning.allDay'))}</span><strong>{layout.event.title}</strong>{layout.event.location ? <small>{layout.event.location}</small> : null}</Link>;
                })}</div>
              </div>;
            })}
        </div>
      </div>
    </div>
  </section>;
}
