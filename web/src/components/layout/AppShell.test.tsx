import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';

const mocks = vi.hoisted(() => ({ useMediaQuery: vi.fn(), useQuery: vi.fn() }));
const storedPreferences = new Map<string, string>();

vi.mock('@tanstack/react-query', () => ({ useQuery: mocks.useQuery }));
vi.mock('@tanstack/react-router', () => ({
  Navigate: () => <div>redirect</div>,
  Outlet: () => <div>outlet</div>,
}));
vi.mock('@/api/client', () => ({
  ApiError: class ApiError extends Error {},
  api: { getSession: vi.fn() },
  isDevelopmentDemoEnabled: false,
}));
vi.mock('@/app/GroupContext', () => ({ GroupProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => ({ activeGroupId: 'group-a' }) }));
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: (query: string) => mocks.useMediaQuery(query) }));
vi.mock('@/features/notifications/NotificationSummaryProvider', () => ({ NotificationSummaryProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('./BottomNavigation', () => ({ BottomNavigation: () => null }));
vi.mock('./MobileHeader', () => ({ MobileHeader: () => null }));
vi.mock('./Sidebar', () => ({
  Sidebar: ({ collapsed, onCollapsedChange }: { collapsed: boolean; onCollapsedChange: (collapsed: boolean) => void }) => (
    <button onClick={() => onCollapsedChange(!collapsed)} type="button">{collapsed ? 'expand rail' : 'collapse rail'}</button>
  ),
}));

describe('AppShell empty group state', () => {
  beforeEach(() => {
    storedPreferences.clear();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        clear: () => storedPreferences.clear(),
        getItem: (key: string) => storedPreferences.get(key) ?? null,
        setItem: (key: string, value: string) => storedPreferences.set(key, value),
      },
    });
    mocks.useQuery.mockReturnValue({ data: { groups: [] }, isError: false, isLoading: false });
    mocks.useMediaQuery.mockReturnValue(false);
  });

  it('explains why an account may not have an active group', () => {
    render(<AppShell />);

    expect(screen.getByRole('heading', { name: 'Keine aktive Gruppe' })).toBeVisible();
    expect(screen.getByText('Du wurdest noch keiner Gruppe hinzugefügt oder deine Mitgliedschaft wurde archiviert.')).toBeVisible();
    expect(screen.queryByText(/CLI/i)).not.toBeInTheDocument();
  });

  it('persists the tablet navigation-rail preference across remounts', () => {
    mocks.useQuery.mockReturnValue({ data: { groups: [{ id: 'group-a' }] }, isError: false, isLoading: false });
    const firstRender = render(<AppShell />);

    fireEvent.click(screen.getByRole('button', { name: 'collapse rail' }));
    expect(window.localStorage.getItem('teamtaler:sidebar:v1')).toBe('collapsed');
    firstRender.unmount();

    render(<AppShell />);
    expect(screen.getByRole('button', { name: 'expand rail' })).toBeInTheDocument();
  });

  it('uses a temporary navigation rail when the available tablet width is constrained', () => {
    storedPreferences.set('teamtaler:sidebar:v1', 'expanded');
    mocks.useMediaQuery.mockReturnValue(true);
    mocks.useQuery.mockReturnValue({ data: { groups: [{ id: 'group-a' }] }, isError: false, isLoading: false });

    render(<AppShell />);

    expect(mocks.useMediaQuery).toHaveBeenCalledWith('(min-width: 768px) and (max-width: 959px)');
    fireEvent.click(screen.getByRole('button', { name: 'expand rail' }));
    expect(screen.getByRole('button', { name: 'collapse rail' })).toBeInTheDocument();
    expect(window.localStorage.getItem('teamtaler:sidebar:v1')).toBe('expanded');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'expand rail' })).toBeInTheDocument();
  });
});
