import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountPage } from './AccountPage';

const mocks = vi.hoisted(() => ({ activeGroup: vi.fn() }));

vi.mock('@/app/useActiveGroup', () => ({ useOptionalActiveGroup: () => mocks.activeGroup() }));
vi.mock('./AccountDetailsPanel', () => ({ AccountDetailsPanel: () => <div>account-details</div> }));
vi.mock('./ProfileImagePanel', () => ({ ProfileImagePanel: () => <div>profile-image</div> }));
vi.mock('./AccountFinanceSection', () => ({ AccountFinanceSection: () => <div>account-finance</div> }));
vi.mock('./NotificationPreferencesPanel', () => ({ NotificationPreferencesPanel: () => <div>notification-preferences</div> }));

describe('AccountPage group-independent shell', () => {
  beforeEach(() => mocks.activeGroup.mockReturnValue(null));

  it('keeps personal account settings but does not mount group finance without a group', () => {
    render(<AccountPage />);

    expect(screen.getByText('account-details')).toBeVisible();
    expect(screen.getByText('profile-image')).toBeVisible();
    expect(screen.queryByText('account-finance')).not.toBeInTheDocument();
    expect(screen.getByText('notification-preferences')).toBeVisible();
    expect(screen.getByText('Verwalte dein persönliches Konto und deine Anmeldedaten.')).toBeVisible();
  });

  it('mounts the finance projection when a group provider is available', () => {
    mocks.activeGroup.mockReturnValue({ activeGroupId: 'group-a' });
    render(<AccountPage />);

    expect(screen.getByText('account-finance')).toBeVisible();
    expect(screen.getByText('notification-preferences')).toBeVisible();
  });
});
