import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/api/types';
import { ActiveGroupContext } from '@/app/active-group-context';
import i18n from '@/i18n';
import { BehaviorSettingsPanel } from './BehaviorSettingsPanel';

const apiMock = vi.hoisted(() => ({
  getGroupSettings: vi.fn(),
  updateGroupSettings: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: apiMock }));

const session: Session = {
  user: { id: 'user-a', displayName: 'Admin', email: 'admin@example.test' },
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: 'member-a', roles: ['ADMIN', 'MEMBER'], groupPermissions: [] } }],
  activeGroupId: 'group-a',
};

function renderPanel(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ActiveGroupContext.Provider value={{ session, activeGroup: session.groups[0], activeGroupId: 'group-a', setActiveGroupId: vi.fn() }}>
        {children}
      </ActiveGroupContext.Provider>
    </QueryClientProvider>
  );
  render(<BehaviorSettingsPanel />, { wrapper });
  return queryClient;
}

describe('BehaviorSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getGroupSettings.mockResolvedValue({ membersCanViewAllBookings: false });
  });

  it('loads, changes, and explicitly saves booking visibility', async () => {
    const user = userEvent.setup();
    apiMock.updateGroupSettings.mockResolvedValue({ membersCanViewAllBookings: true });
    const queryClient = renderPanel();
    const toggle = await screen.findByRole('switch', { name: i18n.t('behaviorSettings.bookingVisibilityToggle') });
    const save = screen.getByRole('button', { name: i18n.t('behaviorSettings.save') });

    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(save).toBeDisabled();
    await user.click(toggle);
    await user.click(save);

    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalledWith('group-a', { membersCanViewAllBookings: true }));
    await waitFor(() => expect(queryClient.getQueryData(['group-settings', 'group-a'])).toEqual({ membersCanViewAllBookings: true }));
    expect(await screen.findByText(i18n.t('behaviorSettings.saved'))).toHaveAttribute('role', 'status');
  });

  it('shows a localized error when settings cannot be loaded', async () => {
    apiMock.getGroupSettings.mockRejectedValue(new Error('denied'));
    renderPanel();
    expect(await screen.findByText(i18n.t('behaviorSettings.loadError'))).toBeVisible();
  });
});
