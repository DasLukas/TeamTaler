import type { PlanningEvent } from '@/api/types';
import { toZonedDateTimeInput, zonedDateKey, zonedStartOfDay } from './planningDate';
import { addPlanningDays } from './planningTiming';

/** Positioned timed occurrence clipped to one visible calendar day. */
export interface PlanningTimedEventLayout {
  column: number;
  columnCount: number;
  dayKey: string;
  endMinute: number;
  event: PlanningEvent;
  startMinute: number;
}

/** Positioned all-day occurrence spanning visible day columns. */
export interface PlanningAllDayEventLayout {
  endColumn: number;
  event: PlanningEvent;
  row: number;
  startColumn: number;
}

/** Roving time-grid focus target. */
export interface PlanningTimeSlot {
  date: string;
  minute: number;
}

function wallClockMinute(value: string | number | Date, timeZone: string): number {
  const input = toZonedDateTimeInput(new Date(value).toISOString(), timeZone);
  return Number(input.slice(11, 13)) * 60 + Number(input.slice(14, 16));
}

/** Lays out timed events in non-overlapping columns for one wall-clock day. */
export function layoutPlanningTimedEvents(events: readonly PlanningEvent[], dayKey: string, timeZone: string): PlanningTimedEventLayout[] {
  const dayStart = zonedStartOfDay(dayKey, timeZone).getTime();
  const dayEnd = zonedStartOfDay(addPlanningDays(dayKey, 1), timeZone).getTime();
  const candidates = events.flatMap((event) => {
    if (event.allDay) return [];
    const eventStart = new Date(event.startsAt).getTime();
    const eventEnd = event.endsAt ? new Date(event.endsAt).getTime() : eventStart + 30 * 60_000;
    if (eventStart >= dayEnd || eventEnd <= dayStart) return [];
    const clippedStart = Math.max(eventStart, dayStart);
    const clippedEnd = Math.min(eventEnd, dayEnd);
    const startMinute = clippedStart === dayStart ? 0 : wallClockMinute(clippedStart, timeZone);
    const naturalEndMinute = clippedEnd === dayEnd ? 1440 : wallClockMinute(clippedEnd, timeZone);
    return [{ event, startMinute, endMinute: Math.min(1440, Math.max(startMinute + 15, naturalEndMinute)) }];
  }).sort((left, right) => left.startMinute - right.startMinute || right.endMinute - left.endMinute || left.event.title.localeCompare(right.event.title, 'de'));

  const result: PlanningTimedEventLayout[] = [];
  for (let index = 0; index < candidates.length;) {
    const cluster = [candidates[index]];
    let clusterEnd = candidates[index].endMinute;
    let cursor = index + 1;
    while (cursor < candidates.length && candidates[cursor].startMinute < clusterEnd) {
      cluster.push(candidates[cursor]);
      clusterEnd = Math.max(clusterEnd, candidates[cursor].endMinute);
      cursor += 1;
    }
    const columnEnds: number[] = [];
    const positioned = cluster.map((entry) => {
      let column = columnEnds.findIndex((end) => end <= entry.startMinute);
      if (column === -1) column = columnEnds.length;
      columnEnds[column] = entry.endMinute;
      return { ...entry, column };
    });
    result.push(...positioned.map((entry) => ({ ...entry, columnCount: columnEnds.length, dayKey })));
    index = cursor;
  }
  return result;
}

/** Assigns visible all-day event spans to the first available non-overlapping row. */
export function layoutPlanningAllDayEvents(events: readonly PlanningEvent[], dateKeys: readonly string[]): PlanningAllDayEventLayout[] {
  if (dateKeys.length === 0) return [];
  const first = dateKeys[0];
  const afterLast = addPlanningDays(dateKeys.at(-1) ?? first, 1);
  const candidates = events.flatMap((event) => {
    if (!event.allDay || event.startDate >= afterLast || event.endDateExclusive <= first) return [];
    const startKey = event.startDate < first ? first : event.startDate;
    const endKey = event.endDateExclusive > afterLast ? afterLast : event.endDateExclusive;
    return [{ event, startColumn: dateKeys.indexOf(startKey), endColumn: endKey === afterLast ? dateKeys.length : dateKeys.indexOf(endKey) }];
  }).filter((entry) => entry.startColumn >= 0 && entry.endColumn > entry.startColumn)
    .sort((left, right) => left.startColumn - right.startColumn || right.endColumn - left.endColumn || left.event.title.localeCompare(right.event.title, 'de'));
  const rowEnds: number[] = [];
  return candidates.map((entry) => {
    let row = rowEnds.findIndex((end) => end <= entry.startColumn);
    if (row === -1) row = rowEnds.length;
    rowEnds[row] = entry.endColumn;
    return { ...entry, row };
  });
}

/** Returns the preferred initial roving slot: now, first event, or 08:00. */
export function initialPlanningTimeSlot(events: readonly PlanningEvent[], dateKeys: readonly string[], timeZone: string, now = new Date()): PlanningTimeSlot {
  const today = zonedDateKey(now, timeZone);
  if (dateKeys.includes(today)) {
    const minute = wallClockMinute(now, timeZone);
    return { date: today, minute: Math.floor(minute / 30) * 30 };
  }
  for (const key of dateKeys) {
    const firstEvent = layoutPlanningTimedEvents(events, key, timeZone)[0];
    if (firstEvent) return { date: key, minute: Math.floor(firstEvent.startMinute / 30) * 30 };
  }
  return { date: dateKeys[0] ?? today, minute: 8 * 60 };
}

/** Formats a slot minute as a strict wall-clock value. */
export function planningSlotTime(minute: number): string {
  const bounded = Math.max(0, Math.min(1439, minute));
  return `${String(Math.floor(bounded / 60)).padStart(2, '0')}:${String(bounded % 60).padStart(2, '0')}`;
}
