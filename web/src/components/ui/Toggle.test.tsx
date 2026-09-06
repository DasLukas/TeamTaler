import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { Toggle } from './Toggle';

describe('Toggle', () => {
  it('exposes switch semantics and reports changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const label = i18n.t('roles.finance.label');
    render(<Toggle checked={false} label={label} onChange={onChange} />);
    const toggle = screen.getByRole('switch', { name: label });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('associates optional supporting copy with the switch', () => {
    render(<><p id="switch-description">Supporting copy</p><Toggle checked={false} descriptionId="switch-description" label="Described switch" onChange={vi.fn()} /></>);

    expect(screen.getByRole('switch', { name: 'Described switch' })).toHaveAccessibleDescription('Supporting copy');
  });
});
