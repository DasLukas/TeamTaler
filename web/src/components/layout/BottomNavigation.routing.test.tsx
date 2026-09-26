import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BottomNavigation } from './BottomNavigation';
import styles from './BottomNavigation.module.css';

vi.mock('@/app/useActiveGroup', () => ({
  useActiveGroup: () => ({ activeGroup: { membership: { effectiveGrants: [] } } }),
}));

/** Simulates the activity table persisting its initial sorting in the URL. */
function ActivitiesWithSorting() {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ to: '/activities', search: { 'tt.activities.sorting': '[{"id":"occurredAt","desc":true}]' }, replace: true });
  }, [navigate]);
  return <h1>Activity history</h1>;
}

describe('BottomNavigation route activation', () => {
  it('marks activities active after the first click even when sorting updates the URL', async () => {
    const user = userEvent.setup();
    const root = createRootRoute({ component: () => <><Outlet /><BottomNavigation /></> });
    const overview = createRoute({ getParentRoute: () => root, path: '/overview', component: () => <h1>Overview</h1> });
    const activities = createRoute({ getParentRoute: () => root, path: '/activities', component: ActivitiesWithSorting });
    const router = createRouter({ history: createMemoryHistory({ initialEntries: ['/overview'] }), routeTree: root.addChildren([overview, activities]) });
    render(<RouterProvider router={router} />);
    await user.click(await screen.findByRole('link', { name: 'Aktivitäten', hidden: true }));
    await screen.findByRole('heading', { name: 'Activity history' });
    await waitFor(() => expect(router.state.location.search).toHaveProperty('tt.activities.sorting'));
    await waitFor(() => expect(screen.getByRole('link', { name: 'Aktivitäten', hidden: true })).toHaveAttribute('aria-current', 'page'));
    expect(screen.getByRole('link', { name: 'Aktivitäten', hidden: true })).toHaveClass(styles.active);
    expect(screen.getByRole('link', { name: 'Übersicht', hidden: true })).not.toHaveAttribute('aria-current');
  });
});
