import CalendarRange from 'lucide-react/dist/esm/icons/calendar-range';
import Repeat2 from 'lucide-react/dist/esm/icons/repeat-2';
import Settings2 from 'lucide-react/dist/esm/icons/settings-2';
import X from 'lucide-react/dist/esm/icons/x';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlanningMonthlyMode, PlanningRecurrenceFrequency, PlanningRecurrenceInput, PlanningWeekday } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { SelectMenu, type SelectMenuOption } from '@/components/ui/SelectMenu';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { planningRecurrenceIncludesAnchor, planningRecurrenceSummary, planningWeekdayForDate } from './planningRecurrence';
import styles from './Planning.module.css';

type RecurrencePreset = 'NONE' | 'DAILY' | 'WEEKDAYS' | 'WEEKLY' | 'MONTHLY' | 'YEARLY' | 'CUSTOM';
type RecurrenceRangeType = PlanningRecurrenceInput['range']['type'];

const weekdays: PlanningWeekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

function defaultRecurrence(startsAt: string): PlanningRecurrenceInput {
  return { frequency: 'WEEKLY', interval: 1, weekdays: [planningWeekdayForDate(startsAt)], range: { type: 'NEVER' } };
}

function withRequiredAnchor(recurrence: PlanningRecurrenceInput, startsAt: string): PlanningRecurrenceInput {
  if (recurrence.frequency !== 'WEEKLY') return recurrence;
  const anchor = planningWeekdayForDate(startsAt);
  const selected = new Set([...(recurrence.weekdays ?? []), anchor]);
  return { ...recurrence, weekdays: weekdays.filter((weekday) => selected.has(weekday)) };
}

function recurrenceForPreset(preset: RecurrencePreset, startsAt: string): PlanningRecurrenceInput | null {
  if (preset === 'NONE') return null;
  const range = { type: 'NEVER' as const };
  if (preset === 'DAILY') return { frequency: 'DAILY', interval: 1, range };
  if (preset === 'WEEKDAYS') return { frequency: 'WEEKLY', interval: 1, weekdays: ['MO', 'TU', 'WE', 'TH', 'FR'], range };
  if (preset === 'MONTHLY') return { frequency: 'MONTHLY', interval: 1, monthlyMode: 'DAY_OF_MONTH', range };
  if (preset === 'YEARLY') return { frequency: 'YEARLY', interval: 1, range };
  return defaultRecurrence(startsAt);
}

function equalWeekdays(left: readonly PlanningWeekday[] | undefined, right: readonly PlanningWeekday[]): boolean {
  return left?.length === right.length && right.every((weekday) => left.includes(weekday));
}

function recurrencePreset(recurrence: PlanningRecurrenceInput | null, startsAt: string): RecurrencePreset {
  if (!recurrence) return 'NONE';
  if (recurrence.interval !== 1 || recurrence.range.type !== 'NEVER') return 'CUSTOM';
  if (recurrence.frequency === 'DAILY') return 'DAILY';
  if (recurrence.frequency === 'YEARLY') return 'YEARLY';
  if (recurrence.frequency === 'MONTHLY' && recurrence.monthlyMode === 'DAY_OF_MONTH') return 'MONTHLY';
  if (recurrence.frequency === 'WEEKLY' && equalWeekdays(recurrence.weekdays, ['MO', 'TU', 'WE', 'TH', 'FR'])) return 'WEEKDAYS';
  if (recurrence.frequency === 'WEEKLY' && equalWeekdays(recurrence.weekdays, [planningWeekdayForDate(startsAt)])) return 'WEEKLY';
  return 'CUSTOM';
}

interface PlanningRecurrenceFieldProps {
  disabled?: boolean;
  onChange: (recurrence: PlanningRecurrenceInput | null) => void;
  startsAt: string;
  value: PlanningRecurrenceInput | null;
}

/** Renders the recurrence preset selector and its accessible advanced editor. */
export function PlanningRecurrenceField({ disabled = false, onChange, startsAt, value }: PlanningRecurrenceFieldProps) {
  const { t } = useTranslation();
  const compact = useMediaQuery('(max-width: 767px)');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<PlanningRecurrenceInput>(() => value ?? defaultRecurrence(startsAt));
  const preset = recurrencePreset(value, startsAt);
  const anchorWeekday = planningWeekdayForDate(startsAt);
  const options = useMemo<SelectMenuOption<RecurrencePreset>[]>(() => [
    { value: 'NONE', label: t('planning.recurrence.presets.NONE'), visual: <X size={17} /> },
    { value: 'DAILY', label: t('planning.recurrence.presets.DAILY'), visual: <Repeat2 size={17} /> },
    { value: 'WEEKDAYS', label: t('planning.recurrence.presets.WEEKDAYS'), visual: <CalendarRange size={17} /> },
    { value: 'WEEKLY', label: t('planning.recurrence.presets.WEEKLY'), visual: <CalendarRange size={17} /> },
    { value: 'MONTHLY', label: t('planning.recurrence.presets.MONTHLY'), visual: <CalendarRange size={17} /> },
    { value: 'YEARLY', label: t('planning.recurrence.presets.YEARLY'), visual: <CalendarRange size={17} /> },
    { value: 'CUSTOM', label: t('planning.recurrence.presets.CUSTOM'), visual: <Settings2 size={17} /> },
  ], [t]);
  const frequencyOptions = useMemo<SelectMenuOption<PlanningRecurrenceFrequency>[]>(() => ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].map((frequency) => ({ value: frequency as PlanningRecurrenceFrequency, label: t(`planning.recurrence.frequencies.${frequency}`) })), [t]);
  const monthlyModeOptions = useMemo<SelectMenuOption<PlanningMonthlyMode>[]>(() => ['DAY_OF_MONTH', 'NTH_WEEKDAY', 'LAST_DAY'].map((mode) => ({ value: mode as PlanningMonthlyMode, label: t(`planning.recurrence.monthlyModes.${mode}`) })), [t]);
  const rangeOptions = useMemo<SelectMenuOption<RecurrenceRangeType>[]>(() => ['NEVER', 'COUNT', 'UNTIL'].map((type) => ({ value: type as RecurrenceRangeType, label: t(`planning.recurrence.ranges.${type}`) })), [t]);
  const draftValid = draft.interval >= 1 && draft.interval <= 99 && planningRecurrenceIncludesAnchor(draft, startsAt) && (draft.range.type !== 'COUNT' || draft.range.count >= 2 && draft.range.count <= 500) && (draft.range.type !== 'UNTIL' || Boolean(draft.range.until) && draft.range.until >= startsAt.slice(0, 10));
  const openEditor = (initial: PlanningRecurrenceInput) => {
    setDraft(withRequiredAnchor(initial, startsAt));
    setDialogOpen(true);
  };
  const choosePreset = (nextPreset: RecurrencePreset) => {
    if (nextPreset === 'CUSTOM') {
      openEditor(value ?? defaultRecurrence(startsAt));
      return;
    }
    onChange(recurrenceForPreset(nextPreset, startsAt));
  };
  const setFrequency = (frequency: PlanningRecurrenceFrequency) => setDraft((current) => {
    const selectedWeekdays = new Set([...(current.weekdays ?? []), anchorWeekday]);
    return {
      ...current,
      frequency,
      weekdays: frequency === 'WEEKLY' ? weekdays.filter((weekday) => selectedWeekdays.has(weekday)) : undefined,
      monthlyMode: frequency === 'MONTHLY' ? current.monthlyMode ?? 'DAY_OF_MONTH' : undefined,
    };
  });
  const setRangeType = (type: RecurrenceRangeType) => setDraft((current) => ({
    ...current,
    range: type === 'COUNT' ? { type, count: 10 } : type === 'UNTIL' ? { type, until: startsAt.slice(0, 10) } : { type },
  }));
  const toggleWeekday = (weekday: PlanningWeekday) => setDraft((current) => {
    if (weekday === anchorWeekday) return current;
    const selected = new Set(current.weekdays ?? []);
    if (selected.has(weekday) && selected.size > 1) selected.delete(weekday);
    else selected.add(weekday);
    return { ...current, weekdays: weekdays.filter((candidate) => selected.has(candidate)) };
  });

  return <>
    <div className={`${styles.recurrenceControl} ${value ? '' : styles.recurrenceControlSingle}`}>
      <SelectMenu disabled={disabled} id="planning-recurrence" onChange={choosePreset} options={options} value={preset} />
      {value ? <Button aria-label={t('planning.recurrence.customize')} className={styles.recurrenceCustomizeButton} disabled={disabled} iconOnly leadingIcon={<Settings2 size={18} />} onClick={() => openEditor(value)} variant="secondary">{t('planning.recurrence.customize')}</Button> : null}
      {value ? <p className={styles.recurrenceSummary}>{planningRecurrenceSummary(value, t)}</p> : null}
    </div>
    <Modal
      footer={<div className={styles.dialogActions}><Button leadingIcon={<X size={17} />} onClick={() => setDialogOpen(false)} variant="secondary">{t('common.cancel')}</Button><Button disabled={!draftValid} leadingIcon={<Repeat2 size={17} />} onClick={() => { onChange(draft); setDialogOpen(false); }}>{t('planning.recurrence.apply')}</Button></div>}
      onClose={() => setDialogOpen(false)}
      open={dialogOpen}
      title={t('planning.recurrence.dialogTitle')}
      variant={compact ? 'sheet' : 'dialog'}
    >
      <div className={styles.recurrenceDialog}>
        <p>{t('planning.recurrence.dialogIntro')}</p>
        <div className={styles.recurrenceGrid}>
          <Field htmlFor="planning-recurrence-frequency" label={t('planning.recurrence.frequency')}><SelectMenu id="planning-recurrence-frequency" onChange={setFrequency} options={frequencyOptions} value={draft.frequency} /></Field>
          <Field htmlFor="planning-recurrence-interval" label={t('planning.recurrence.interval')} required><TextInput id="planning-recurrence-interval" max={99} min={1} onChange={(event) => setDraft((current) => ({ ...current, interval: Math.min(99, Number(event.target.value)) }))} required type="number" value={draft.interval} /></Field>
          {draft.frequency === 'WEEKLY' ? <fieldset className={styles.weekdayFieldset}><legend>{t('planning.recurrence.weekdayLabel')}</legend><div className={styles.weekdayChoices}>{weekdays.map((weekday) => <label key={weekday}><input checked={draft.weekdays?.includes(weekday) ?? false} disabled={weekday === anchorWeekday} onChange={() => toggleWeekday(weekday)} type="checkbox" /><span>{t(`planning.recurrence.weekdays.${weekday}.short`)}</span></label>)}</div><p className={styles.weekdayAnchorHint}>{t('planning.recurrence.anchorHint', { weekday: t(`planning.recurrence.weekdays.${anchorWeekday}.short`) })}</p></fieldset> : null}
          {draft.frequency === 'MONTHLY' ? <Field htmlFor="planning-recurrence-monthly-mode" label={t('planning.recurrence.monthlyMode')}><SelectMenu id="planning-recurrence-monthly-mode" onChange={(monthlyMode) => setDraft((current) => ({ ...current, monthlyMode }))} options={monthlyModeOptions} value={draft.monthlyMode ?? 'DAY_OF_MONTH'} /></Field> : null}
          <Field htmlFor="planning-recurrence-range" label={t('planning.recurrence.range')}><SelectMenu id="planning-recurrence-range" onChange={setRangeType} options={rangeOptions} value={draft.range.type} /></Field>
          {draft.range.type === 'COUNT' ? <Field htmlFor="planning-recurrence-count" label={t('planning.recurrence.count')} required><TextInput id="planning-recurrence-count" max={500} min={2} onChange={(event) => setDraft((current) => ({ ...current, range: { type: 'COUNT', count: Math.min(500, Number(event.target.value)) } }))} required type="number" value={draft.range.count} /></Field> : null}
          {draft.range.type === 'UNTIL' ? <Field htmlFor="planning-recurrence-until" label={t('planning.recurrence.until')} required><TextInput id="planning-recurrence-until" min={startsAt.slice(0, 10)} onChange={(event) => setDraft((current) => ({ ...current, range: { type: 'UNTIL', until: event.target.value } }))} required type="date" value={draft.range.until} /></Field> : null}
        </div>
        <div aria-live="polite" className={styles.recurrencePreview}><Repeat2 aria-hidden="true" size={18} /><span>{planningRecurrenceSummary(draft, t)}</span></div>
      </div>
    </Modal>
  </>;
}
