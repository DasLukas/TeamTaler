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
});
