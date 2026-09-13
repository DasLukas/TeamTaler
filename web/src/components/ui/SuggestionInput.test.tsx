import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { SuggestionInput } from './SuggestionInput';

/** Supplies controlled state for the editable suggestion-input contract. */
function SuggestionInputHarness() {
  const [value, setValue] = useState('');
  return <SuggestionInput aria-label="Reason" onChange={setValue} options={[{ value: 'Membership fee' }, { label: 'Team lead', value: 'lead@example.test' }]} value={value} />;
}

describe('SuggestionInput', () => {
  it('keeps arbitrary text editable and selects a custom-rendered suggestion', async () => {
    const user = userEvent.setup();
    render(<SuggestionInputHarness />);

    const input = screen.getByRole('combobox', { name: 'Reason' });
    await user.click(input);
    expect(screen.getByRole('listbox')).toBeVisible();
    await user.click(screen.getByRole('option', { name: 'Membership fee' }));
    expect(input).toHaveValue('Membership fee');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, 'Custom note');
    expect(input).toHaveValue('Custom note');
  });

  it('supports keyboard filtering and selection without a native datalist', async () => {
    const user = userEvent.setup();
    render(<SuggestionInputHarness />);

    const input = screen.getByRole('combobox', { name: 'Reason' });
    await user.type(input, 'lead');
    expect(screen.getByRole('option', { name: 'Team lead lead@example.test' })).toBeVisible();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(input).toHaveValue('lead@example.test');
    expect(document.querySelector('datalist')).not.toBeInTheDocument();
  });
});
