import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SelectMenu } from './SelectMenu';

describe('SelectMenu scrolling', () => {
  it('keeps the listbox open for internal scrolling and closes for external scrolling', async () => {
    const user = userEvent.setup();
    render(
      <dialog open>
        <SelectMenu
          ariaLabel="Member"
          id="member"
          onChange={vi.fn()}
          options={[
            { label: 'Ada', value: 'ada' },
            { label: 'Ben', value: 'ben' },
            { label: 'Carla', value: 'carla' },
          ]}
          value="ada"
        />
      </dialog>,
    );

    const trigger = screen.getByRole('combobox', { name: 'Member' });
    await user.click(trigger);
    const listbox = screen.getByRole('listbox', { name: 'Member' });

    fireEvent.scroll(listbox);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(listbox).toBeVisible();

    fireEvent.scroll(window);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox', { name: 'Member' })).not.toBeInTheDocument();
  });

  it('keeps unavailable options visible while skipping them for keyboard selection', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SelectMenu
        ariaLabel="Range"
        id="range"
        onChange={onChange}
        options={[
          { disabled: true, label: 'Current period', value: 'current' },
          { label: 'Last 30 days', value: '30-days' },
          { label: 'Custom', value: 'custom' },
        ]}
        value="30-days"
      />,
    );

    const trigger = screen.getByRole('combobox', { name: 'Range' });
    await user.click(trigger);
    expect(screen.getByRole('option', { name: 'Current period' })).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('{Home}{Enter}');

    expect(onChange).toHaveBeenCalledWith('30-days');
  });
});
