import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BottomNavigation } from './BottomNavigation';
import { NotificationSummaryContext } from '@/features/notifications/NotificationSummaryContext';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) => select({ location: { pathname: '/overview' } }),
}));

vi.mock('@/app/useActiveGroup', () => ({
  useActiveGroup: () => ({ activeGroup: { membership: { effectiveGrants: [{ permission: 'CREATE_OWN_BOOKING', scope: { type: 'GROUP' } }] } } }),
}));

describe('BottomNavigation', () => {
  it('always renders the four primary mobile destinations', () => {
    render(<BottomNavigation />);

    expect(screen.getAllByRole('link', { hidden: true }).map((link) => link.textContent)).toEqual(['Übersicht', 'Buchen', 'Aktivitäten', 'Mehr']);
    expect(screen.queryByRole('link', { name: 'Katalog' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Finanzen' })).not.toBeInTheDocument();
  });

  it('shows the unread badge on the More destination', () => {
    render(<NotificationSummaryContext.Provider value={3}><BottomNavigation /></NotificationSummaryContext.Provider>);
    expect(screen.getByLabelText('3 ungelesene Benachrichtigungen')).toHaveTextContent('3');
  });
});
