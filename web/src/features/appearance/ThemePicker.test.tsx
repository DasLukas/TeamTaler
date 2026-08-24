import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { ThemePicker } from './ThemePicker';

describe('ThemePicker', () => {
  it('merges the inherited group default into its single theme card with a visible badge', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ThemePicker defaultTheme="TEAMTALER" includeGroupDefault label="Theme" onChange={onChange} value={null} />);

    const group = screen.getByRole('group', { name: 'Theme' });
    expect(screen.getByRole('radio', { name: i18n.t('appearance.groupDefaultAccessibleLabel', { theme: i18n.t('appearance.themes.TEAMTALER') }) })).toBeChecked();
    expect(screen.getByText(i18n.t('appearance.groupDefaultBadge'))).toBeVisible();
    expect(screen.getAllByText(i18n.t('appearance.themes.TEAMTALER'))).toHaveLength(1);
    expect(group.querySelectorAll('input[type="radio"]')).toHaveLength(4);

    await user.click(screen.getByRole('radio', { name: i18n.t('appearance.themes.TIEF_IM_WESTEN') }));
    expect(onChange).toHaveBeenCalledWith('TIEF_IM_WESTEN');
  });

  it('moves inheritance and the badge when the group default changes', () => {
    const { rerender } = render(<ThemePicker defaultTheme="TEAMTALER" includeGroupDefault label="Theme" onChange={vi.fn()} value={null} />);

    rerender(<ThemePicker defaultTheme="NRW" includeGroupDefault label="Theme" onChange={vi.fn()} value={null} />);

    expect(screen.getByRole('radio', { name: i18n.t('appearance.groupDefaultAccessibleLabel', { theme: i18n.t('appearance.themes.NRW') }) })).toBeChecked();
    expect(screen.getByRole('radio', { name: i18n.t('appearance.themes.TEAMTALER') })).not.toBeChecked();
    expect(screen.getAllByText(i18n.t('appearance.groupDefaultBadge'))).toHaveLength(1);
    expect(screen.getAllByRole('radio')).toHaveLength(4);
  });

  it('omits inheritance when selecting an administrator-managed group default', () => {
    render(<ThemePicker label="Theme" onChange={vi.fn()} value="FIRE" />);

    expect(screen.getAllByRole('radio')).toHaveLength(4);
    expect(screen.getByRole('radio', { name: i18n.t('appearance.themes.FIRE') })).toBeChecked();
    expect(screen.queryByText(i18n.t('appearance.groupDefaultBadge'))).not.toBeInTheDocument();
  });
});
