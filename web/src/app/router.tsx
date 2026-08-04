import { Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { AppShell } from '@/components/layout/AppShell';
import { AccountPage } from '@/features/account/AccountPage';
import { ActivitiesPage } from '@/features/activities/ActivitiesPage';
import { AdminPage } from '@/features/admin/AdminPage';
import { InvitationPage } from '@/features/auth/InvitationPage';
import { LoginPage } from '@/features/auth/LoginPage';
import { BookingPage } from '@/features/bookings/BookingPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { MorePage } from '@/features/more/MorePage';
import { NotificationsPage } from '@/features/notifications/NotificationsPage';
import { ReportsPage } from '@/features/reports/ReportsPage';
import { NotFoundPage } from './NotFoundPage';

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFoundPage,
});

const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authenticated',
  component: AppShell,
});

const dashboardRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: '/', component: DashboardPage });
const bookingRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: '/book', component: BookingPage });
const activitiesRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: '/activities', component: ActivitiesPage });
const reportsRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: '/reports', component: ReportsPage });
const adminRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: '/admin', component: AdminPage });
const notificationsRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: '/notifications', component: NotificationsPage });
const accountRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: '/account', component: AccountPage });
const moreRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: '/more', component: MorePage });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login', component: LoginPage });
const inviteRoute = createRoute({ getParentRoute: () => rootRoute, path: '/invite', component: InvitationPage });

const routeTree = rootRoute.addChildren([
  authenticatedRoute.addChildren([dashboardRoute, bookingRoute, activitiesRoute, reportsRoute, adminRoute, notificationsRoute, accountRoute, moreRoute]),
  loginRoute,
  inviteRoute,
]);

/** Application router with code-defined, fully typed public and authenticated routes. */
export const router = createRouter({ routeTree, defaultPreload: 'intent', defaultPreloadStaleTime: 30_000 });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
