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
import { BookingPermissionRoute, GroupRequiredRoute, PreferredWorkspaceRedirect } from './PermissionRoutes';
import { PlanningCreateScreen, PlanningDetailScreen, PlanningEditScreen, PlanningIndexScreen } from '@/features/planning/PlanningRouteScreens';
import { validatePlanningSearch } from '@/features/planning/planningSearch';

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFoundPage,
});

const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authenticated',
  component: AppShell,
});

const groupRequiredRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  id: 'group-required',
  component: GroupRequiredRoute,
});

const landingRoute = createRoute({ getParentRoute: () => groupRequiredRoute, path: memberPaths.landing, component: PreferredWorkspaceRedirect });
const dashboardRoute = createRoute({ getParentRoute: () => groupRequiredRoute, path: memberPaths.overview, component: DashboardPage });
const planningRoute = createRoute({
  getParentRoute: () => groupRequiredRoute,
  path: memberPaths.planning,
  validateSearch: validatePlanningSearch,
  component: PlanningIndexScreen,
});
const planningNewRoute = createRoute({ getParentRoute: () => groupRequiredRoute, path: memberPaths.planningNew, validateSearch: validatePlanningSearch, component: PlanningCreateScreen });
const planningDetailRoute = createRoute({ getParentRoute: () => groupRequiredRoute, path: '/planning/events/$eventId', validateSearch: validatePlanningSearch, component: PlanningDetailScreen });
const planningEditRoute = createRoute({ getParentRoute: () => groupRequiredRoute, path: '/planning/events/$eventId/edit', validateSearch: validatePlanningSearch, component: PlanningEditScreen });
const bookingRoute = createRoute({ getParentRoute: () => groupRequiredRoute, path: memberPaths.booking, component: BookingPermissionRoute });
const legacyReportsRoute = createRoute({ getParentRoute: () => groupRequiredRoute, path: memberPaths.legacyReports, component: () => <Navigate replace to={memberPaths.overview} /> });
const activitiesRoute = createRoute({ getParentRoute: () => groupRequiredRoute, path: '/activities', component: ActivitiesPage });
const catalogRoute = createRoute({ getParentRoute: () => groupRequiredRoute, path: memberPaths.catalog, component: CatalogPage });
const financeRoute = createRoute({ getParentRoute: () => groupRequiredRoute, path: memberPaths.finance, component: FinancePage });
const adminRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: '/admin', component: AdminPage });
const notificationsRoute = createRoute({ getParentRoute: () => groupRequiredRoute, path: '/notifications', component: NotificationsPage });
const accountRoute = createRoute({ getParentRoute: () => authenticatedRoute, path: '/account', component: AccountPage });
const moreRoute = createRoute({ getParentRoute: () => groupRequiredRoute, path: '/more', component: MorePage });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login', component: LoginPage });
const forgotPasswordRoute = createRoute({ getParentRoute: () => rootRoute, path: '/forgot-password', component: ForgotPasswordPage });
const resetPasswordRoute = createRoute({ getParentRoute: () => rootRoute, path: '/reset-password', component: ResetPasswordPage });
const emailChangeConfirmationRoute = createRoute({ getParentRoute: () => rootRoute, path: '/email-change/confirm', component: EmailChangeConfirmationPage });
const inviteRoute = createRoute({ getParentRoute: () => rootRoute, path: '/invite', component: InvitationPage });
const publicJoinRoute = createRoute({ getParentRoute: () => rootRoute, path: '/join', component: PublicJoinPage });
const publicJoinVerificationRoute = createRoute({ getParentRoute: () => rootRoute, path: '/join/verify', component: PublicJoinVerificationPage });

const routeTree = rootRoute.addChildren([
  authenticatedRoute.addChildren([
    groupRequiredRoute.addChildren([landingRoute, dashboardRoute, planningRoute, planningNewRoute, planningDetailRoute, planningEditRoute, bookingRoute, legacyReportsRoute, activitiesRoute, catalogRoute, financeRoute, notificationsRoute, moreRoute]),
    adminRoute,
    accountRoute,
  ]),
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
