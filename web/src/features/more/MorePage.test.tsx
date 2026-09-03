import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionKey } from '@/api/types';
import { MorePage } from './MorePage';
import { NotificationSummaryContext } from '@/features/notifications/NotificationSummaryContext';

const mocks = vi.hoisted(() => ({ useActiveGroup: vi.fn() }));

vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => mocks.useActiveGroup() }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a> }));
vi.mock('@/components/ui/Avatar', () => ({ Avatar: () => <div>avatar</div> }));
vi.mock('@/components/auth/LogoutButton', () => ({ LogoutButton: () => <button type="button">Abmelden</button> }));

function usePermissions(permissions: PermissionKey[], systemRoles: string[] = [], planningEnabled = false): void {
  mocks.useActiveGroup.mockReturnValue({
    session: { user: { displayName: 'Alex', email: 'alex@example.test' }, systemRoles },
    activeGroup: { name: 'Group A', planningEnabled, membership: { effectiveGrants: permissions.map((permission) => ({ permission, scope: { type: 'GROUP' as const } })) } },
  });
}

function menuItems(): string[] {
  const navigation = screen.getByRole('navigation', { name: 'Weitere Bereiche' });
  return Array.from(navigation.querySelectorAll('a, button')).map((item) => item.textContent ?? '');
}

describe('MorePage role navigation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the requested complete order for administrators', () => {
    usePermissions(['FINANCE_MANAGEMENT', 'CATALOG_MANAGEMENT', 'GROUP_ADMINISTRATION']);
    render(<MorePage />);

    expect(menuItems()).toEqual(['Katalog', 'Finanzen', 'Einstellungen', 'Benachrichtigungen', 'Mein Konto', 'Abmelden']);
    expect(screen.getByRole('link', { name: 'Benachrichtigungen' })).toHaveAttribute('href', '/notifications');
  });

  it.each([
    { permissions: ['FINANCE_MANAGEMENT'] as PermissionKey[], expected: ['Finanzen', 'Benachrichtigungen', 'Mein Konto', 'Abmelden'] },
    { permissions: ['CATALOG_MANAGEMENT'] as PermissionKey[], expected: ['Katalog', 'Benachrichtigungen', 'Mein Konto', 'Abmelden'] },
    { permissions: [] as PermissionKey[], expected: ['Benachrichtigungen', 'Mein Konto', 'Abmelden'] },
  ])('filters unavailable workspaces for $permissions', ({ permissions, expected }) => {
    usePermissions(permissions);
    render(<MorePage />);

    expect(menuItems()).toEqual(expected);
  });

  it('shows the exact unread count on the notification menu item', () => {
    usePermissions([]);
    render(<NotificationSummaryContext.Provider value={7}><MorePage /></NotificationSummaryContext.Provider>);
    expect(screen.getByLabelText('7 ungelesene Benachrichtigungen')).toHaveTextContent('7');
  });

  it('preserves the desktop module order before fixed account actions', () => {
    usePermissions(['USE_PLANNING', 'FINANCE_MANAGEMENT'], [], true);
    render(<MorePage />);

    expect(menuItems()).toEqual(['Planung', 'Finanzen', 'Benachrichtigungen', 'Mein Konto', 'Abmelden']);
  });

  it('shows system settings independently from group capabilities', () => {
    usePermissions([], ['SYSTEM_ADMINISTRATOR']);
    render(<MorePage />);

    expect(menuItems()).toEqual(['Einstellungen', 'Benachrichtigungen', 'Mein Konto', 'Abmelden']);
  });
});
