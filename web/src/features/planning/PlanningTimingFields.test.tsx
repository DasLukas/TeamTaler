import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { PlanningTimingFields, type PlanningTimingFormValue } from './PlanningTimingFields';
import { defaultPlanningFormState, usePlanningFormState } from './planningFormState';

function Harness() {
  const [timing, setTiming] = useState<PlanningTimingFormValue>({ allDay: false, startDate: '2026-09-05', endDate: '2026-09-05', startsAt: '2026-09-05T18:30', endsAt: '2026-09-06T00:00' });
  return <PlanningTimingFields {...timing} endRequired={false} onChange={setTiming} />;
}

function FormStateHarness() {
  const initial = defaultPlanningFormState('Europe/Berlin', '2026-09-05');
  const [state, updateState] = usePlanningFormState('create:Europe/Berlin:2026-09-05', initial);
  return <PlanningTimingFields {...state} endRequired={false} onChange={(timing) => updateState((current) => ({ ...current, ...timing }))} />;
}

describe('PlanningTimingFields', () => {
  it('switches accessibly between modes and preserves both independently edited input sets', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const toggle = screen.getByRole('switch', { name: i18n.t('planning.fields.allDay') });

    expect(toggle).not.toBeChecked();
    expect(toggle).not.toHaveAttribute('aria-describedby');
    await user.clear(screen.getByLabelText(/^Beginn/));
    await user.type(screen.getByLabelText(/^Beginn/), '2026-09-05T19:15');
    await user.clear(screen.getByLabelText(/^Ende/));
    await user.type(screen.getByLabelText(/^Ende/), '2026-09-06T00:45');
    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(screen.getByLabelText(/^Startdatum/)).toHaveValue('2026-09-05');
    expect(screen.getByLabelText(/^Enddatum/)).toHaveValue('2026-09-05');

    await user.clear(screen.getByLabelText(/^Enddatum/));
    await user.type(screen.getByLabelText(/^Enddatum/), '2026-09-07');

    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(screen.getByLabelText(/^Beginn/)).toHaveValue('2026-09-05T19:15');
    expect(screen.getByLabelText(/^Ende/)).toHaveValue('2026-09-06T00:45');

    await user.click(toggle);
    expect(screen.getByLabelText(/^Enddatum/)).toHaveValue('2026-09-07');
  });

  it('preserves inactive timing overrides in the complete planning form state', async () => {
    const user = userEvent.setup();
    render(<FormStateHarness />);
    const toggle = screen.getByRole('switch', { name: i18n.t('planning.fields.allDay') });

    await user.click(toggle);
    await user.clear(screen.getByLabelText(/^Beginn/));
    await user.type(screen.getByLabelText(/^Beginn/), '2026-09-05T11:30');
    await user.clear(screen.getByLabelText(/^Ende/));
    await user.type(screen.getByLabelText(/^Ende/), '2026-09-05T12:45');
    await user.click(toggle);
    await user.click(toggle);

    expect(screen.getByLabelText(/^Beginn/)).toHaveValue('2026-09-05T11:30');
    expect(screen.getByLabelText(/^Ende/)).toHaveValue('2026-09-05T12:45');
  });
});
