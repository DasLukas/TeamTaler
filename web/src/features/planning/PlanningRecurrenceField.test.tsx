import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PlanningRecurrenceInput } from '@/api/types';
import i18n from '@/i18n';
import { PlanningRecurrenceField } from './PlanningRecurrenceField';

function RecurrenceHarness() {
  const [value, setValue] = useState<PlanningRecurrenceInput | null>(null);
  return <div><label htmlFor="planning-recurrence">{i18n.t('planning.recurrence.label')}</label><PlanningRecurrenceField onChange={setValue} startsAt="2026-08-31T12:00" value={value} /></div>;
}

function PublishedSeriesHarness() {
  const [value, setValue] = useState<PlanningRecurrenceInput | null>({ frequency: 'WEEKLY', interval: 1, weekdays: ['MO'], range: { type: 'NEVER' } });
  return <div><label htmlFor="planning-recurrence">{i18n.t('planning.recurrence.label')}</label><PlanningRecurrenceField allowNone={false} onChange={setValue} startsAt="2026-08-31T12:00" value={value} /></div>;
}

describe('PlanningRecurrenceField', () => {
  it('offers accessible presets and stores a structured recurrence', async () => {
    const user = userEvent.setup();
    render(<RecurrenceHarness />);

    const recurrenceSelect = screen.getByRole('combobox', { name: i18n.t('planning.recurrence.label') });
    expect(recurrenceSelect.parentElement?.parentElement?.className).toContain('recurrenceControlSingle');
    await user.click(recurrenceSelect);
    await user.click(screen.getByRole('option', { name: i18n.t('planning.recurrence.presets.WEEKDAYS') }));

    expect(screen.getByText(/Mo, Di, Mi, Do, Fr/)).toBeVisible();
    expect(screen.getByRole('button', { name: i18n.t('planning.recurrence.customize') })).toBeVisible();
  });

  it('edits weekly days and a finite range in the advanced dialog', async () => {
    const user = userEvent.setup();
    render(<RecurrenceHarness />);

    await user.click(screen.getByRole('combobox', { name: i18n.t('planning.recurrence.label') }));
    await user.click(screen.getByRole('option', { name: i18n.t('planning.recurrence.presets.CUSTOM') }));
    const dialog = screen.getByRole('dialog', { name: i18n.t('planning.recurrence.dialogTitle') });

    expect(within(dialog).getByRole('checkbox', { name: 'Mo' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Mo' })).toBeDisabled();
    expect(within(dialog).getByText(i18n.t('planning.recurrence.anchorHint', { weekday: 'Mo' }))).toBeVisible();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Mi' }));
    await user.click(within(dialog).getByRole('combobox', { name: i18n.t('planning.recurrence.range') }));
    await user.click(screen.getByRole('option', { name: i18n.t('planning.recurrence.ranges.COUNT') }));
    await user.clear(within(dialog).getByRole('spinbutton', { name: i18n.t('planning.recurrence.count') }));
    await user.type(within(dialog).getByRole('spinbutton', { name: i18n.t('planning.recurrence.count') }), '6');
    await user.click(within(dialog).getByRole('button', { name: i18n.t('planning.recurrence.apply') }));

    expect(screen.getByText(/endet nach 6 Terminen/)).toBeVisible();
  });

  it('does not offer an invalid no-recurrence state for a published series', async () => {
    const user = userEvent.setup();
    render(<PublishedSeriesHarness />);

    await user.click(screen.getByRole('combobox', { name: i18n.t('planning.recurrence.label') }));

    expect(screen.queryByRole('option', { name: i18n.t('planning.recurrence.presets.NONE') })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: i18n.t('planning.recurrence.presets.WEEKLY') })).toBeVisible();
  });

  it('uses the shared bottom-sheet pattern on mobile viewports', async () => {
    const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: query === '(max-width: 767px)',
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    } as MediaQueryList));
    const user = userEvent.setup();
    render(<RecurrenceHarness />);

    await user.click(screen.getByRole('combobox', { name: i18n.t('planning.recurrence.label') }));
    await user.click(screen.getByRole('option', { name: i18n.t('planning.recurrence.presets.CUSTOM') }));
    const dialog = screen.getByRole('dialog', { name: i18n.t('planning.recurrence.dialogTitle') });

    expect(dialog.className).toContain('_sheet_');
    expect(dialog.querySelector(`button[aria-label="${i18n.t('dialog.sheetHandle')}"]`)).toBeInTheDocument();
    matchMedia.mockRestore();
  });
});
