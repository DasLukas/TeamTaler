import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BookingTarget } from '@/api/types';
import i18n from '@/i18n';
import { MemberMultiSelect } from './MemberMultiSelect';

const targets: BookingTarget[] = [
  { membershipId: 'member-regular', displayName: 'Regular Member', isTemporaryGuest: false },
  { membershipId: 'member-guest', displayName: 'Existing Guest', isTemporaryGuest: true },
];

describe('MemberMultiSelect', () => {
  it('exposes named member groups and enforces the shared 100-target limit', async () => {
    const user = userEvent.setup();
    render(<MemberMultiSelect
      canBookForGuests
      id="target-picker"
      label={i18n.t('booking.forMember')}
      onAddGuest={vi.fn()}
      onChange={vi.fn()}
      onRemoveGuest={vi.fn()}
      pendingGuestNames={Array.from({ length: 99 }, (_, index) => `Pending Guest ${index + 1}`)}
      placeholder={i18n.t('booking.selectMembers')}
      selectedIds={['member-regular']}
      targets={targets}
    />);

    await user.click(screen.getByRole('button', { name: i18n.t('booking.forMember') }));

    expect(screen.getByRole('group', { name: i18n.t('booking.regularMembers') })).toBeVisible();
    expect(screen.getByRole('group', { name: i18n.t('booking.guests') })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /Regular Member/ })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Existing Guest' })).toBeDisabled();
    expect(screen.getByPlaceholderText('Anzeigename')).toBeVisible();
    expect(screen.queryByText('Der Gast wird erst zusammen mit der Buchung angelegt und benötigt kein Login.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: i18n.t('booking.addGuestAction') })).toBeDisabled();
  });

  it('matches server-side control-character, code-point, and case-folding validation', async () => {
    const user = userEvent.setup();
    const onAddGuest = vi.fn();
    render(<MemberMultiSelect
      canBookForGuests
      id="target-picker"
      label={i18n.t('booking.forMember')}
      onAddGuest={onAddGuest}
      onChange={vi.fn()}
      onRemoveGuest={vi.fn()}
      pendingGuestNames={['Sam', 'Jose']}
      placeholder={i18n.t('booking.selectMembers')}
      selectedIds={[]}
      targets={targets}
    />);
    await user.click(screen.getByRole('button', { name: i18n.t('booking.forMember') }));
    const input = screen.getByLabelText(i18n.t('booking.addGuest'));

    await user.type(input, 'sAm');
    await user.click(screen.getByRole('button', { name: i18n.t('booking.addGuestAction') }));
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('booking.guestNameDuplicate'));

    fireEvent.change(input, { target: { value: 'Guest\u0007Name' } });
    await user.click(screen.getByRole('button', { name: i18n.t('booking.addGuestAction') }));
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('booking.guestNameControlCharacters'));

    fireEvent.change(input, { target: { value: '😀'.repeat(121) } });
    await user.click(screen.getByRole('button', { name: i18n.t('booking.addGuestAction') }));
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('booking.guestNameTooLong'));
    expect(onAddGuest).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'José' } });
    await user.click(screen.getByRole('button', { name: i18n.t('booking.addGuestAction') }));
    expect(onAddGuest).toHaveBeenCalledWith('José');
  });
});
