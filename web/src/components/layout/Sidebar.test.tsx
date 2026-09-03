import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionKey } from '@/api/types';
import { NotificationSummaryContext } from '@/features/notifications/NotificationSummaryContext';
import { Sidebar } from './Sidebar';

const mocks = vi.hoisted(() => ({ useActiveGroup: vi.fn() }));

vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => mocks.useActiveGroup() }));
vi.mock('@tanstack/react-router', () => ({
  Link: (props: { children: ReactNode; to: string; title?: string; 'aria-label'?: string }) => (
    <a aria-label={props['aria-label']} href={props.to} title={props.title}>{props.children}</a>
  ),
}));
vi.mock('@/components/brand/Brand', () => ({ Brand: () => <div>brand</div> }));
vi.mock('@/components/auth/LogoutButton', () => ({ LogoutButton: () => <button type="button">logout</button> }));

function usePermissions(permissions: PermissionKey[], systemRoles: string[] = [], statisticsEnabled = false): void {
  const group = { id: 'group-a', name: 'Group A', currency: 'EUR', statisticsEnabled, membership: { id: 'member-a', effectiveGrants: permissions.map((permission) => ({ permission, scope: { type: 'GROUP' as const } })) } };
  mocks.useActiveGroup.mockReturnValue({ session: { groups: [group], systemRoles }, activeGroupId: group.id, setActiveGroupId: vi.fn() });
}

describe('Sidebar role navigation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows finance without administration to a pure finance manager', () => {
    usePermissions(['FINANCE_MANAGEMENT']);
    render(<Sidebar collapsed={false} onCollapsedChange={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Finanzen' })).toHaveAttribute('href', '/finance');
    expect(screen.queryByRole('link', { name: 'Einstellungen' })).not.toBeInTheDocument();
  });

  it('shows catalog without administration or finance to a pure catalog manager', () => {
    usePermissions(['CATALOG_MANAGEMENT']);
    render(<Sidebar collapsed={false} onCollapsedChange={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Katalog' })).toHaveAttribute('href', '/catalog');
    expect(screen.queryByRole('link', { name: 'Einstellungen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Finanzen' })).not.toBeInTheDocument();
  });

  it('shows catalog and finance before administration to administrators', () => {
    usePermissions(['CATALOG_MANAGEMENT', 'FINANCE_MANAGEMENT', 'GROUP_ADMINISTRATION']);
    render(<Sidebar collapsed={false} onCollapsedChange={vi.fn()} />);
    const links = screen.getAllByRole('link').map((link) => link.textContent);
    expect(links.indexOf('Katalog')).toBeLessThan(links.indexOf('Finanzen'));
    expect(links.indexOf('Finanzen')).toBeLessThan(links.indexOf('Einstellungen'));
  });

  it('shows statistics only when the group switch and unified permission are both effective', () => {
    usePermissions(['VIEW_STATISTICS'], [], true);
    const rendered = render(<Sidebar collapsed={false} onCollapsedChange={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Statistiken' })).toHaveAttribute('href', '/statistics');

    usePermissions(['VIEW_STATISTICS'], [], false);
    rendered.rerender(<Sidebar collapsed={false} onCollapsedChange={vi.fn()} />);
    expect(screen.queryByRole('link', { name: 'Statistiken' })).not.toBeInTheDocument();
  });

  it('shows settings to a system administrator without group administration rights', () => {
    usePermissions([], ['SYSTEM_ADMINISTRATOR']);
    render(<Sidebar collapsed={false} onCollapsedChange={vi.fn()} />);

    expect(screen.getByRole('link', { name: 'Einstellungen' })).toHaveAttribute('href', '/admin');
  });

  it('shows group logos and initial fallbacks in the keyboard-operable custom selector', () => {
    const setActiveGroupId = vi.fn();
    mocks.useActiveGroup.mockReturnValue({
      session: {
        groups: [
          { id: 'group-a', name: 'Group A', currency: 'EUR', logoUrl: '/api/v1/groups/group-a/logo', membership: { id: 'member-a', effectiveGrants: [] } },
          { id: 'group-b', name: 'Beta Club', currency: 'EUR', membership: { id: 'member-b', effectiveGrants: [] } },
        ],
        systemRoles: [],
      },
      activeGroupId: 'group-a',
      setActiveGroupId,
    });
    render(<Sidebar collapsed={false} onCollapsedChange={vi.fn()} />);

    const selector = screen.getByRole('combobox', { name: 'Gruppe auswählen' });
    expect(selector.querySelector('img')).toHaveAttribute('src', '/api/v1/groups/group-a/logo');
    fireEvent.keyDown(selector, { key: 'ArrowDown' });
    const fallbackOption = screen.getByRole('option', { name: 'Beta Club' });
    expect(fallbackOption).toHaveTextContent('B');
    fireEvent.keyDown(selector, { key: 'ArrowDown' });
    fireEvent.keyDown(selector, { key: 'Enter' });
    expect(setActiveGroupId).toHaveBeenCalledWith('group-b');
  });

  it('exposes an accessible tablet-rail toggle and preserves icon destinations', () => {
    const onCollapsedChange = vi.fn();
    usePermissions(['CREATE_OWN_BOOKING', 'CATALOG_MANAGEMENT', 'FINANCE_MANAGEMENT', 'GROUP_ADMINISTRATION']);

    const { rerender } = render(<Sidebar collapsed={false} onCollapsedChange={onCollapsedChange} />);
    fireEvent.click(screen.getByTitle('Navigationsleiste einklappen'));
    expect(onCollapsedChange).toHaveBeenCalledWith(true);

    rerender(<Sidebar collapsed onCollapsedChange={onCollapsedChange} />);
    expect(screen.getByTitle('Navigationsleiste ausklappen')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('combobox', { name: 'Gruppe auswählen' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Buchen' })).toHaveAttribute('title', 'Buchen');
  });

  it('anchors the unread badge to the notification bell', () => {
    usePermissions([]);

    render(<NotificationSummaryContext.Provider value={3}><Sidebar collapsed={false} onCollapsedChange={vi.fn()} /></NotificationSummaryContext.Provider>);

    const badge = screen.getByLabelText('3 ungelesene Benachrichtigungen');
    expect(badge.parentElement?.querySelector('svg')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Benachrichtigungen' })).toContainElement(badge);
  });
});
