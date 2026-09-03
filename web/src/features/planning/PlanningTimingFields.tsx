import { useTranslation } from 'react-i18next';
import { Field, TextInput } from '@/components/ui/FormField';
import { Toggle } from '@/components/ui/Toggle';
import type { PlanningFormState } from './planningFormState';
import styles from './Planning.module.css';

/** Timing fields owned by the all-day/timed schedule control. */
export type PlanningTimingFormValue = Pick<PlanningFormState, 'allDay' | 'startDate' | 'endDate' | 'startsAt' | 'endsAt'>;

/** Properties accepted by the planning timing editor. */
export interface PlanningTimingFieldsProps extends PlanningTimingFormValue {
  endRequired: boolean;
  startError?: string;
  endError?: string;
  onChange: (value: PlanningTimingFormValue) => void;
}

/**
 * Renders an accessible all-day switch and the matching date or date-time inputs.
 *
 * @param props - Current timing state, validation messages, and atomic change callback.
 * @returns A responsive set of schedule controls that preserves inactive timed values.
 */
export function PlanningTimingFields({ allDay, startDate, endDate, startsAt, endsAt, endRequired, startError, endError, onChange }: PlanningTimingFieldsProps) {
  const { t } = useTranslation();
  const announcementId = 'planning-timing-announcement';
  const changeMode = (checked: boolean) => onChange({ allDay: checked, startDate, endDate, startsAt, endsAt });
  return <>
    <div className={`${styles.toggleOption} ${styles.timingModeOption}`}>
      <div className={styles.toggleOptionCopy}>
        <strong>{t('planning.fields.allDay')}</strong>
      </div>
      <Toggle checked={allDay} label={t('planning.fields.allDay')} onChange={changeMode} />
      <span aria-live="polite" className={styles.srOnly} id={announcementId}>{t(allDay ? 'planning.form.allDayEnabled' : 'planning.form.timedEnabled')}</span>
    </div>
    {allDay ? <>
      <Field error={startError} htmlFor="planning-start-date" label={t('planning.fields.startDate')} messageId="planning-start-date-message" required>
        <TextInput aria-describedby={startError ? 'planning-start-date-message' : undefined} aria-invalid={Boolean(startError)} id="planning-start-date" onChange={(event) => onChange({ allDay, startDate: event.target.value, endDate, startsAt, endsAt })} required type="date" value={startDate} />
      </Field>
      <Field error={endError} hint={!endError ? t('planning.form.allDayEndHint') : undefined} htmlFor="planning-end-date" label={t('planning.fields.endDate')} messageId="planning-end-date-message" required>
        <TextInput aria-describedby="planning-end-date-message" aria-invalid={Boolean(endError)} id="planning-end-date" min={startDate || undefined} onChange={(event) => onChange({ allDay, startDate, endDate: event.target.value, startsAt, endsAt })} required type="date" value={endDate} />
      </Field>
    </> : <>
      <Field error={startError} htmlFor="planning-start" label={t('planning.fields.start')} messageId="planning-start-message" required>
        <TextInput aria-describedby={startError ? 'planning-start-message' : undefined} aria-invalid={Boolean(startError)} id="planning-start" onChange={(event) => onChange({ allDay, startDate, endDate, startsAt: event.target.value, endsAt })} required type="datetime-local" value={startsAt} />
      </Field>
      <Field error={endError} hint={!endError && endRequired ? t('planning.recurrence.endHint') : undefined} htmlFor="planning-end" label={t('planning.fields.end')} messageId="planning-end-message" required={endRequired}>
        <TextInput aria-describedby={endError || endRequired ? 'planning-end-message' : undefined} aria-invalid={Boolean(endError)} id="planning-end" onChange={(event) => onChange({ allDay, startDate, endDate, startsAt, endsAt: event.target.value })} required={endRequired} type="datetime-local" value={endsAt} />
      </Field>
    </>}
  </>;
}
