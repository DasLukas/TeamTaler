import { Navigate, Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { AppShell } from '@/components/layout/AppShell';
import { AccountPage } from '@/features/account/AccountPage';
import { ActivitiesPage } from '@/features/activities/ActivitiesPage';
import { AdminPage } from '@/features/admin/AdminPage';
import { InvitationPage } from '@/features/auth/InvitationPage';
import { LoginPage } from '@/features/auth/LoginPage';
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage';
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage';
import { EmailChangeConfirmationPage } from '@/features/auth/EmailChangeConfirmationPage';
import { PublicJoinPage } from '@/features/auth/PublicJoinPage';
import { PublicJoinVerificationPage } from '@/features/auth/PublicJoinVerificationPage';
import { CatalogPage } from '@/features/catalog/CatalogPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { FinancePage } from '@/features/finance/FinancePage';
import { MorePage } from '@/features/more/MorePage';
import { NotificationsPage } from '@/features/notifications/NotificationsPage';
import { NotFoundPage } from './NotFoundPage';
import { memberPaths } from './paths';
import { BookingPermissionRoute, PreferredWorkspaceRedirect } from './PermissionRoutes';

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFoundPage,
});

const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authenticated',
  component: AppShell,
});

const landingRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: memberPaths.landing, component: PreferredWorkspaceRedirect });
const dashboardRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: memberPaths.overview, component: DashboardPage });
const bookingRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: memberPaths.booking, component: BookingPermissionRoute });
const legacyReportsRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: memberPaths.legacyReports, component: () => <Navigate replace to={memberPaths.overview} /> });
const activitiesRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: '/activities', component: ActivitiesPage });
const catalogRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: memberPaths.catalog, component: CatalogPage });
const financeRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: memberPaths.finance, component: FinancePage });
const adminRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: '/admin', component: AdminPage });
const notificationsRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: '/notifications', component: NotificationsPage });
const accountRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: '/account', component: AccountPage });
const moreRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: '/more', component: MorePage });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login', component: LoginPage });
const forgotPasswordRoute = createRoute({ getParentRoute: () => rootRoute, path: '/forgot-password', component: ForgotPasswordPage });
const resetPasswordRoute = createRoute({ getParentRoute: () => rootRoute, path: '/reset-password', component: ResetPasswordPage });
const emailChangeConfirmationRoute = createRoute({ getParentRoute: () => rootRoute, path: '/email-change/confirm', component: EmailChangeConfirmationPage });
const inviteRoute = createRoute({ getParentRoute: () => rootRoute, path: '/invite', component: InvitationPage });
const publicJoinRoute = createRoute({ getParentRoute: () => rootRoute, path: '/join', component: PublicJoinPage });
const publicJoinVerificationRoute = createRoute({ getParentRoute: () => rootRoute, path: '/join/verify', component: PublicJoinVerificationPage });

const routeTree = rootRoute.addChildren([
  authenticatedRoute.addChildren([landingRoute, dashboardRoute, bookingRoute, legacyReportsRoute, activitiesRoute, catalogRoute, financeRoute, adminRoute, notificationsRoute, accountRoute, moreRoute]),
  loginRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  emailChangeConfirmationRoute,
  inviteRoute,
  publicJoinRoute,
  publicJoinVerificationRoute,
]);

/** Application router with code-defined, fully typed public and authenticated routes. */
export const router = createRouter({ routeTree, defaultPreload: 'intent', defaultPreloadStaleTime: 30_000 });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
