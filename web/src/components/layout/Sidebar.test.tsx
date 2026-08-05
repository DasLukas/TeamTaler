import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';

const mocks = vi.hoisted(() => ({ useActiveGroup: vi.fn() }));

vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => mocks.useActiveGroup() }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a> }));
vi.mock('@/components/brand/Brand', () => ({ Brand: () => <div>brand</div> }));
vi.mock('@/components/auth/LogoutButton', () => ({ LogoutButton: () => <button type="button">logout</button> }));

function useRoles(roles: string[]): void {
  const group = { id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: 'member-a', roles } };
  mocks.useActiveGroup.mockReturnValue({ session: { groups: [group] }, activeGroupId: group.id, setActiveGroupId: vi.fn() });
}

describe('Sidebar role navigation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows finance without administration to a pure finance manager', () => {
    useRoles(['FINANCE_MANAGER', 'MEMBER']);
    render(<Sidebar />);
    expect(screen.getByRole('link', { name: 'Finanzen' })).toHaveAttribute('href', '/finance');
    expect(screen.queryByRole('link', { name: 'Verwaltung' })).not.toBeInTheDocument();
  });

  it('shows catalog without administration or finance to a pure catalog manager', () => {
    useRoles(['CATALOG_MANAGER', 'MEMBER']);
    render(<Sidebar />);
    expect(screen.getByRole('link', { name: 'Katalog' })).toHaveAttribute('href', '/catalog');
    expect(screen.queryByRole('link', { name: 'Verwaltung' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Finanzen' })).not.toBeInTheDocument();
  });

  it('shows catalog and finance before administration to administrators', () => {
    useRoles(['ADMIN', 'MEMBER']);
    render(<Sidebar />);
    const links = screen.getAllByRole('link').map((link) => link.textContent);
    expect(links.indexOf('Katalog')).toBeLessThan(links.indexOf('Finanzen'));
    expect(links.indexOf('Finanzen')).toBeLessThan(links.indexOf('Verwaltung'));
  });
});
