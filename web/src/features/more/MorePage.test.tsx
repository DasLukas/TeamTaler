import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupRole } from '@/api/types';
import { MorePage } from './MorePage';
import { NotificationSummaryContext } from '@/features/notifications/NotificationSummaryContext';

const mocks = vi.hoisted(() => ({ useActiveGroup: vi.fn() }));

vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => mocks.useActiveGroup() }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a> }));
vi.mock('@/components/ui/Avatar', () => ({ Avatar: () => <div>avatar</div> }));
vi.mock('@/components/auth/LogoutButton', () => ({ LogoutButton: () => <button type="button">Abmelden</button> }));

function useRoles(roles: GroupRole[]): void {
  mocks.useActiveGroup.mockReturnValue({
    session: { user: { displayName: 'Alex', email: 'alex@example.test' } },
    activeGroup: { name: 'Group A', membership: { roles } },
  });
}

function menuItems(): string[] {
  const navigation = screen.getByRole('navigation', { name: 'Weitere Bereiche' });
  return Array.from(navigation.querySelectorAll('a, button')).map((item) => item.textContent ?? '');
}

describe('MorePage role navigation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the requested complete order for administrators', () => {
    useRoles(['ADMIN', 'MEMBER']);
    render(<MorePage />);

    expect(menuItems()).toEqual(['Benachrichtigungen', 'Finanzen', 'Katalog', 'Verwaltung', 'Mein Konto', 'Abmelden']);
    expect(screen.getByRole('link', { name: 'Benachrichtigungen' })).toHaveAttribute('href', '/notifications');
  });

  it.each([
    { roles: ['FINANCE_MANAGER', 'MEMBER'] as GroupRole[], expected: ['Benachrichtigungen', 'Finanzen', 'Mein Konto', 'Abmelden'] },
    { roles: ['CATALOG_MANAGER', 'MEMBER'] as GroupRole[], expected: ['Benachrichtigungen', 'Katalog', 'Mein Konto', 'Abmelden'] },
    { roles: ['MEMBER'] as GroupRole[], expected: ['Benachrichtigungen', 'Mein Konto', 'Abmelden'] },
  ])('filters unavailable workspaces for $roles', ({ roles, expected }) => {
    useRoles(roles);
    render(<MorePage />);

    expect(menuItems()).toEqual(expected);
  });

  it('shows the exact unread count on the notification menu item', () => {
    useRoles(['MEMBER']);
    render(<NotificationSummaryContext.Provider value={7}><MorePage /></NotificationSummaryContext.Provider>);
    expect(screen.getByLabelText('7 ungelesene Benachrichtigungen')).toHaveTextContent('7');
  });
});
