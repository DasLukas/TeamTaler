import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/api/types';
import { ActiveGroupContext } from '@/app/active-group-context';
import { AuditPanel } from './AuditPanel';

const apiMock = vi.hoisted(() => ({
  getAuditFilterOptions: vi.fn(),
  getAuditPage: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: apiMock }));

const session: Session = {
  activeGroupId: 'group-a',
  defaultGroupId: null,
  colorMode: 'SYSTEM',
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', defaultTheme: 'TEAMTALER', membership: { id: 'member-a', roles: ['ADMIN'], groupPermissions: [], themeOverride: null } }],
  systemRoles: [],
  user: { id: 'user-a', displayName: 'Ada Admin', email: 'ada@example.test' },
};

/**
 * Renders the group audit panel with its active-group and query dependencies.
 *
 * @returns Nothing; the panel is mounted into the test document.
 */
function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>
    <ActiveGroupContext.Provider value={{ activeGroup: session.groups[0], activeGroupId: 'group-a', session, setActiveGroupId: vi.fn() }}>
      {children}
    </ActiveGroupContext.Provider>
  </QueryClientProvider>;
  render(<AuditPanel />, { wrapper });
}

describe('AuditPanel filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/admin');
    apiMock.getAuditFilterOptions.mockResolvedValue({
      actions: ['booking.created', 'payment.created'],
      resourceTypes: ['booking', 'payment'],
      actionResourceTypes: { 'booking.created': ['booking'], 'payment.created': ['payment'] },
    });
    apiMock.getAuditPage.mockResolvedValue({ hasMore: false, items: [], limit: 50 });
  });

  it('limits actions to the selected resource types', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole('heading', { name: 'Audit-Protokoll' });
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    const filterDialog = screen.getByRole('dialog', { name: 'Ergebnisse filtern' });

    await user.click(within(filterDialog).getByRole('button', { name: 'Ressourcentyp' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Ressourcentyp' })).getByRole('checkbox', { name: 'payment' }));
    await user.click(within(filterDialog).getByRole('button', { name: 'Aktion' }));
    const actionMenu = screen.getByRole('dialog', { name: 'Aktion' });
    expect(within(actionMenu).queryByRole('checkbox', { name: 'booking.created' })).not.toBeInTheDocument();
    await user.click(within(actionMenu).getByRole('checkbox', { name: 'payment.created' }));
    await user.click(within(filterDialog).getByRole('button', { name: 'Filter anwenden' }));

    await waitFor(() => expect(apiMock.getAuditPage).toHaveBeenLastCalledWith('group-a', expect.objectContaining({
      action: ['payment.created'],
      resourceType: ['payment'],
    })));
  });
});
