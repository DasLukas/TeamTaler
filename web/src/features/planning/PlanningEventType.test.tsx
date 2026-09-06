import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { PlanningEventTypeSelect } from './PlanningEventType';

describe('PlanningEventTypeSelect', () => {
  it('offers the sustainable appointment types with their canonical icons', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PlanningEventTypeSelect id="planning-type" onChange={onChange} value="APPOINTMENT" />);

    const control = screen.getByRole('combobox');
    expect(control).toHaveTextContent(i18n.t('planning.types.APPOINTMENT'));
    expect(control.querySelector('svg')).not.toBeNull();
    await user.click(control);

    const poll = screen.getByRole('option', { name: i18n.t('planning.types.APPOINTMENT_POLL') });
    const registration = screen.getByRole('option', { name: i18n.t('planning.types.APPOINTMENT_REGISTRATION') });
    expect(poll.querySelector('svg')).not.toBeNull();
    expect(registration.querySelector('svg')).not.toBeNull();
    await user.click(registration);

    expect(onChange).toHaveBeenCalledWith('APPOINTMENT_REGISTRATION');
  });
});
