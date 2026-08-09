import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionKey } from '@/api/types';
import { Sidebar } from './Sidebar';

const mocks = vi.hoisted(() => ({ useActiveGroup: vi.fn() }));

vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => mocks.useActiveGroup() }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a> }));
vi.mock('@/components/brand/Brand', () => ({ Brand: () => <div>brand</div> }));
vi.mock('@/components/auth/LogoutButton', () => ({ LogoutButton: () => <button type="button">logout</button> }));

function usePermissions(permissions: PermissionKey[]): void {
  const group = { id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: 'member-a', effectiveGrants: permissions.map((permission) => ({ permission, scope: { type: 'GROUP' as const } })) } };
  mocks.useActiveGroup.mockReturnValue({ session: { groups: [group] }, activeGroupId: group.id, setActiveGroupId: vi.fn() });
}

describe('Sidebar role navigation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows finance without administration to a pure finance manager', () => {
    usePermissions(['FINANCE_MANAGEMENT']);
    render(<Sidebar />);
    expect(screen.getByRole('link', { name: 'Finanzen' })).toHaveAttribute('href', '/finance');
    expect(screen.queryByRole('link', { name: 'Verwaltung' })).not.toBeInTheDocument();
  });

  it('shows catalog without administration or finance to a pure catalog manager', () => {
    usePermissions(['CATALOG_MANAGEMENT']);
    render(<Sidebar />);
    expect(screen.getByRole('link', { name: 'Katalog' })).toHaveAttribute('href', '/catalog');
    expect(screen.queryByRole('link', { name: 'Verwaltung' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Finanzen' })).not.toBeInTheDocument();
  });

  it('shows catalog and finance before administration to administrators', () => {
    usePermissions(['CATALOG_MANAGEMENT', 'FINANCE_MANAGEMENT', 'GROUP_ADMINISTRATION']);
    render(<Sidebar />);
    const links = screen.getAllByRole('link').map((link) => link.textContent);
    expect(links.indexOf('Katalog')).toBeLessThan(links.indexOf('Finanzen'));
    expect(links.indexOf('Finanzen')).toBeLessThan(links.indexOf('Verwaltung'));
  });
});
