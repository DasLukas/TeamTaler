import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookingTarget } from '@/api/types';
import i18n from '@/i18n';
import { MemberMultiSelect } from './MemberMultiSelect';

const mediaQuery = vi.hoisted(() => ({ compact: false }));

vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => mediaQuery.compact }));

const targets: BookingTarget[] = [
  { membershipId: 'member-regular', displayName: 'Regular Member', isTemporaryGuest: false },
  { membershipId: 'member-guest', displayName: 'Existing Guest', isTemporaryGuest: true },
];

describe('MemberMultiSelect', () => {
  beforeEach(() => {
    mediaQuery.compact = false;
  });

  it('renders the recipient count as an icon-button badge and keeps names in the dialog', async () => {
    const user = userEvent.setup();
    const label = 'Empfänger auswählen. 2 Personen ausgewählt.';
    render(<MemberMultiSelect
      canBookForGuests={false}
      iconOnly
      id="target-picker"
      label={label}
      onAddGuest={vi.fn()}
      onChange={vi.fn()}
      onRemoveGuest={vi.fn()}
      pendingGuestNames={['Pending Guest']}
      placeholder={i18n.t('booking.selectMembers')}
      selectedIds={['member-regular']}
      targets={targets}
    />);

    const trigger = screen.getByRole('button', { name: label });
    expect(trigger).toHaveTextContent('2');
    expect(trigger).not.toHaveTextContent('Regular Member');
    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: label })).toHaveTextContent('Regular Member');
    expect(screen.getByRole('dialog', { name: label })).toHaveTextContent('Pending Guest');
  });

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

  it('uses the production bottom sheet for the compact recipient picker', async () => {
    const user = userEvent.setup();
    mediaQuery.compact = true;
    render(<MemberMultiSelect
      canBookForGuests
      iconOnly
      id="target-picker"
      label="Empfänger auswählen. 1 Person ausgewählt."
      onAddGuest={vi.fn()}
      onChange={vi.fn()}
      onRemoveGuest={vi.fn()}
      overlayOnMobile
      pendingGuestNames={[]}
      placeholder={i18n.t('booking.selectMembers')}
      selectedIds={['member-regular']}
      targets={targets}
    />);

    const trigger = screen.getByRole('button', { name: 'Empfänger auswählen. 1 Person ausgewählt.' });
    await user.click(trigger);

    const sheet = screen.getByRole('dialog', { name: i18n.t('booking.selectRecipients') });
    expect(sheet).toBeVisible();
    expect(sheet).toHaveTextContent('Regular Member');
    expect(screen.getByLabelText(i18n.t('booking.addGuest'))).toBeVisible();

    await user.click(screen.getByRole('button', { name: i18n.t('dialog.close') }));
    expect(screen.queryByRole('dialog', { name: i18n.t('booking.selectRecipients') })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
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
