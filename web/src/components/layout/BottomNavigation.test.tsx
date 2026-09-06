import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomNavigation } from './BottomNavigation';
import { NotificationSummaryContext } from '@/features/notifications/NotificationSummaryContext';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) => select({ location: { pathname: '/overview' } }),
}));

const activeGroupState = vi.hoisted(() => ({ planningEnabled: true, statisticsEnabled: true }));

vi.mock('@/app/useActiveGroup', () => ({
  useActiveGroup: () => ({ activeGroup: { planningEnabled: activeGroupState.planningEnabled, statisticsEnabled: activeGroupState.statisticsEnabled, membership: { effectiveGrants: [{ permission: 'CREATE_OWN_BOOKING', scope: { type: 'GROUP' } }, { permission: 'USE_PLANNING', scope: { type: 'GROUP' } }, { permission: 'VIEW_STATISTICS', scope: { type: 'GROUP' } }] } } }),
}));

describe('BottomNavigation', () => {
  beforeEach(() => { activeGroupState.planningEnabled = true; });

  it('keeps secondary modules out of the compact mobile navigation', () => {
    render(<BottomNavigation />);

    expect(screen.getAllByRole('link', { hidden: true }).map((link) => link.textContent)).toEqual(['Übersicht', 'Buchen', 'Aktivitäten', 'Mehr']);
    expect(screen.queryByRole('link', { name: 'Planung' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Statistiken' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Katalog' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Finanzen' })).not.toBeInTheDocument();
  });

  it('shows the unread badge on the More destination', () => {
    render(<NotificationSummaryContext.Provider value={3}><BottomNavigation /></NotificationSummaryContext.Provider>);
    expect(screen.getByLabelText('3 ungelesene Benachrichtigungen')).toHaveTextContent('3');
  });

  it('keeps the same primary destinations when planning is unavailable', () => {
    activeGroupState.planningEnabled = false;
    render(<BottomNavigation />);

    expect(screen.getAllByRole('link', { hidden: true }).map((link) => link.textContent)).toEqual(['Übersicht', 'Buchen', 'Aktivitäten', 'Mehr']);
  });
});
