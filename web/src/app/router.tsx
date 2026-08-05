import { Navigate, Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { AppShell } from '@/components/layout/AppShell';
import { AccountPage } from '@/features/account/AccountPage';
import { ActivitiesPage } from '@/features/activities/ActivitiesPage';
import { AdminPage } from '@/features/admin/AdminPage';
import { InvitationPage } from '@/features/auth/InvitationPage';
import { LoginPage } from '@/features/auth/LoginPage';
import { BookingPage } from '@/features/bookings/BookingPage';
import { CatalogPage } from '@/features/catalog/CatalogPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { FinancePage } from '@/features/finance/FinancePage';
import { MorePage } from '@/features/more/MorePage';
import { NotificationsPage } from '@/features/notifications/NotificationsPage';
import { NotFoundPage } from './NotFoundPage';
import { memberPaths } from './paths';

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFoundPage,
});

const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authenticated',
  component: AppShell,
});

const landingRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: memberPaths.landing, component: () => <Navigate replace to={memberPaths.booking} /> });
const dashboardRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: memberPaths.overview, component: DashboardPage });
const bookingRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: memberPaths.booking, component: BookingPage });
const legacyReportsRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: memberPaths.legacyReports, component: () => <Navigate replace to={memberPaths.overview} /> });
const activitiesRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: '/activities', component: ActivitiesPage });
const catalogRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: memberPaths.catalog, component: CatalogPage });
const financeRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: memberPaths.finance, component: FinancePage });
const adminRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: '/admin', component: AdminPage });
const notificationsRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: '/notifications', component: NotificationsPage });
const accountRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: '/account', component: AccountPage });
const moreRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: '/more', component: MorePage });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login', component: LoginPage });
const inviteRoute = createRoute({ getParentRoute: () => rootRoute, path: '/invite', component: InvitationPage });

const routeTree = rootRoute.addChildren([
  authenticatedRoute.addChildren([landingRoute, dashboardRoute, bookingRoute, legacyReportsRoute, activitiesRoute, catalogRoute, financeRoute, adminRoute, notificationsRoute, accountRoute, moreRoute]),
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
