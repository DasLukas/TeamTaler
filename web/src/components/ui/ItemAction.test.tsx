import { render, screen } from '@testing-library/react';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import Archive from 'lucide-react/dist/esm/icons/archive';
import { describe, expect, it } from 'vitest';
import { ItemAction } from './ItemAction';

describe('ItemAction', () => {
  it('keeps its icon and visible label in the shared link-style presentation', () => {
    const rendered = render(<ItemAction leadingIcon={<Archive data-testid="archive-icon" size={16} />}>Archive</ItemAction>);

    const action = screen.getByRole('button', { name: 'Archive' });
    expect(action.className).toContain('small');
    expect(action.className).toContain('ghost');
    expect(action.className).not.toContain('collapseLabelAt');
    expect(screen.getByText('Archive')).toBeVisible();
    expect(rendered.container.querySelector('[aria-hidden="true"]')).toContainElement(screen.getByTestId('archive-icon'));
  });

  it('renders navigation as a semantic router link', async () => {
    const rootRoute = createRootRoute({ component: Outlet });
    const sourceRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <ItemAction leadingIcon={<Archive size={16} />} search={{ filter: 'period-a' }} to="/activities">Open</ItemAction>,
    });
    const targetRoute = createRoute({ getParentRoute: () => rootRoute, path: '/activities', component: () => <p>Activities</p> });
    const router = createRouter({ history: createMemoryHistory({ initialEntries: ['/'] }), routeTree: rootRoute.addChildren([sourceRoute, targetRoute]) });

    render(<RouterProvider router={router} />);

    const action = await screen.findByRole('link', { name: 'Open' });
    expect(action).toHaveAttribute('href', '/activities?filter=period-a');
    expect(action.className).toContain('small');
    expect(action.className).toContain('ghost');
  });
});
