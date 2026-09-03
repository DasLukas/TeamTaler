import { minorUnitsToSafeNumber, normalizeMoney } from './money';
import {
  adaptAccountSummaries,
  adaptAppearancePreference,
  adaptActivity,
  adaptAuditEntry,
  adaptBooking,
  adaptBookingContext,
  adaptCategories,
  adaptDashboard,
  adaptGroupSettings,
  adaptGroupNotificationSettings,
  adaptInstanceCapabilities,
  adaptTransactionSettings,
  adaptLedger,
  adaptMembership,
  adaptMemberships,
  adaptStatisticsDashboard,
  adaptNotification,
  adaptNotificationDestination,
  adaptNotificationPreferences,
  adaptPermissionDefinition,
  adaptPayment,
  adaptPeriod,
  adaptProduct,
  adaptPushSubscriptions,
  adaptRole,
  adaptRoleAssignment,
  adaptSession,
  adaptSettlement,
  adaptSystemAccounts,
  adaptSystemAudit,
  adaptSystemGroups,
  adaptSystemGroupInvitationResult,
  adaptSystemGroupDeletionImpact,
  adaptSystemSettings,
  adaptThemePreference,
  adaptUser,
} from './adapters';
import type {
  AccountSummary,
  AppearancePreference,
  ActivityCollectionQuery,
  ActivityEntry,
  ActivityFilterOptions,
  AuthenticationCapabilities,
  AuditEntry,
  AuditFilterOptions,
  Booking,
  BookingFilterOptions,
  BookingCollectionQuery,
  BookingBatchCommand,
  BookingBulkCommand,
  BookingCommand,
  BookingContext,
  CatalogOrderCommand,
  Category,
  CategoryCreateCommand,
  CategoryUpdateCommand,
  CollectionPage,
  CreatedInvitation,
  Dashboard,
  DataExportJob,
  EmailDeliveryStatus,
  EmailChangeRequestResult,
  InvitationEmailRetryResult,
  InvitationEmailResendResult,
  InvitationCommand,
  InvitationInput,
  InvitationUpdateInput,
  InvitationImportResult,
  InvitationMetadata,
  InvitationPreview,
  LedgerEntry,
  LoginCommand,
  GroupPreference,
  GroupNotificationSettings,
  GroupNotificationSettingsUpdate,
  GroupSettings,
  GroupSettingsUpdateInput,
  InstanceCapabilities,
  TransactionSettings,
  Membership,
  MemberReactivationCommand,
  Notification,
  NotificationDestination,
  NotificationPreferences,
  NotificationPreferencesUpdate,
  NotificationPage,
  NotificationReadResult,
  NotificationSummary,
  Payment,
  PaymentCollectionQuery,
  PaymentCommand,
  SelfPaymentCommand,
  Period,
  PermissionDefinition,
  PermissionUpdate,
  ProblemDetails,
  AuditCollectionQuery,
  Product,
  PushSubscriptionDevice,
  PushSubscriptionRegistration,
  ProductCreateCommand,
  ProductUpdateCommand,
  PublicJoinLink,
  PublicJoinLinkUpdate,
  PublicJoinPreview,
  PublicJoinRegistrationInput,
  Role,
  RoleAssignment,
  RoleInput,
  Session,
  Settlement,
  StatisticsQuery,
  StatisticsDashboard,
  SystemAccount,
  SystemAuditEntry,
  SystemAuditCollectionQuery,
  SystemGroup,
  SystemGroupCreateInput,
  SystemGroupInvitationResult,
  SystemGroupPurgeInput,
  SystemGroupDeletionImpact,
  ResettableSystemSettingKey,
  SystemSettings,
  SystemSettingsUpdate,
  SystemSmtpSettingsUpdate,
  SystemWebPushSettingsUpdate,
  TableExportCommand,
  ThemeId,
  ThemePreference,
  ColorMode,
  User,
} from './types';
import i18n from '@/i18n';
import { IdempotencyReservationManager, type IdempotencyReservation } from './idempotency';

const API_BASE = '/api/v1';
const DEMO_ENABLED = import.meta.env.DEV && import.meta.env.VITE_DEMO_MODE === 'true';
const MONEY_FIELDS = new Set(['price', 'unitPrice', 'unit_price', 'total', 'amount', 'balance', 'openBalance', 'open_balance', 'paidAmount', 'paid_amount']);
const idempotencyReservations = new IdempotencyReservationManager(window.sessionStorage);
let demoTransportPromise: Promise<import('@/demo/transport').DemoTransport> | undefined;

async function requestDevelopmentDemo<T>(path: string, init: RequestInit): Promise<T> {
  demoTransportPromise ??= import('@/demo/transport').then(({ DemoTransport }) => new DemoTransport());
  return (await demoTransportPromise).request<T>(path, init);
}

/**
 * Exposes RFC 9457 problem details to route components.
 *
 * @example
 * ```ts
 * if (error instanceof ApiError && error.problem.status === 401) {
 *   // Redirect to login.
 * }
 * ```
 */
export class ApiError extends Error {
  /**
   * Creates an API error.
   *
   * @param problem - Parsed server problem details.
   */
  constructor(public readonly problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
  }
}

function normalizeApiValue(value: unknown, fieldName?: string): unknown {
  if (fieldName && MONEY_FIELDS.has(fieldName) && (typeof value === 'number' || typeof value === 'string')) {
    return normalizeMoney(value);
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeApiValue(entry));
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  if (('minorUnits' in record || 'minor_units' in record) && ('currency' in record || fieldName && MONEY_FIELDS.has(fieldName))) {
    return normalizeMoney(record as Parameters<typeof normalizeMoney>[0]);
  }

  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, normalizeApiValue(entry, key)]));
}

function csrfToken(): string | undefined {
  const match = document.cookie.match(/(?:^|; )teamtaler_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

async function parseProblem(response: Response): Promise<ProblemDetails> {
  try {
    return await response.json() as ProblemDetails;
  } catch {
    return { title: i18n.t('errors.requestFailed'), status: response.status, detail: response.statusText };
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await requestWithMetadata<T>(path, init)).data;
}

async function requestBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'image/jpeg, image/png, image/webp, application/pdf, text/csv, application/zip, application/octet-stream');
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const csrf = csrfToken();
  if (csrf) headers.set('X-CSRF-Token', csrf);
  try {
    const response = await fetch(`${API_BASE}${path}`, { ...init, credentials: 'include', headers });
    if (!response.ok) {
      if (DEMO_ENABLED && (response.status === 404 || response.status >= 500)) return requestDevelopmentDemo<Blob>(path, init);
      throw new ApiError(await parseProblem(response));
    }
    return response.blob();
  } catch (error) {
    if (DEMO_ENABLED && !(error instanceof ApiError)) return requestDevelopmentDemo<Blob>(path, {});
    throw error;
  }
}

async function requestWithMetadata<T>(path: string, init: RequestInit = {}): Promise<{ data: T; headers: Headers }> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const csrf = csrfToken();
  if (csrf) headers.set('X-CSRF-Token', csrf);

  try {
    const response = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: 'include' });
    if (!response.ok) {
      if (DEMO_ENABLED && (response.status === 404 || response.status >= 500)) {
        return { data: await requestDevelopmentDemo<T>(path, init), headers: new Headers() };
      }
      throw new ApiError(await parseProblem(response));
    }
    if (response.status === 204) return { data: undefined as T, headers: response.headers };
    const text = await response.text();
    return { data: (text ? normalizeApiValue(JSON.parse(text)) : undefined) as T, headers: response.headers };
  } catch (error) {
    if (DEMO_ENABLED && !(error instanceof ApiError)) {
      return { data: await requestDevelopmentDemo<T>(path, init), headers: new Headers() };
    }
    throw error;
  }
}

const groupPath = (groupId: string, resource: string) => `/groups/${encodeURIComponent(groupId)}/${resource}`;
const groupRootPath = (groupId: string) => `/groups/${encodeURIComponent(groupId)}`;
const systemGroupPath = (groupId: string, resource = '') => `/system/groups/${encodeURIComponent(groupId)}${resource ? `/${resource}` : ''}`;
const json = (value: unknown) => JSON.stringify(value);

async function fileSha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function paymentMultipart(payload: unknown, attachment: File): FormData {
  const form = new FormData();
  form.append('command', new Blob([json(payload)], { type: 'application/json' }), 'command.json');
  form.append('attachment', attachment, attachment.name);
  return form;
}
const versionHeaders = (version: number): HeadersInit => ({ 'If-Match': `"v${version}"` });

/**
 * Encodes defined collection-query values without leaking empty filters into cacheable URLs.
 *
 * @param query - Typed collection search, filter, sorting, and cursor values.
 * @returns URL parameters containing only meaningful values.
 */
function collectionQueryParameters(query: object): URLSearchParams {
  const parameters = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item !== undefined && item !== null && item !== '') parameters.append(key, String(item));
      });
      return;
    }
    parameters.set(key, String(value));
  });
  return parameters;
}

/**
 * Appends a normalized collection query to an API resource path.
 *
 * @param path - API path without the shared base prefix.
 * @param query - Typed collection query values.
 * @returns The unchanged path for an empty query or a query-string path otherwise.
 */
function collectionPath(path: string, query: object): string {
  const parameters = collectionQueryParameters(query);
  return parameters.size > 0 ? `${path}?${parameters.toString()}` : path;
}

/**
 * Combines an array response with cursor metadata exposed through response headers.
 *
 * @param items - Adapted collection items from the response body.
 * @param headers - Response headers containing pagination metadata.
 * @param requestedLimit - Client-requested page size used when the server omits metadata.
 * @returns A stable page model for React Query infinite collections.
 */
function collectionPage<Item>(items: Item[], headers: Headers, requestedLimit?: number): CollectionPage<Item> {
  const nextCursor = headers.get('X-Next-Cursor') ?? undefined;
  const parsedLimit = Number(headers.get('X-Page-Limit'));
  return {
    items,
    nextCursor,
    hasMore: headers.get('X-Has-More') === 'true' || Boolean(nextCursor),
    limit: Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : requestedLimit ?? 100,
  };
}
const systemSettingKeys: Record<ResettableSystemSettingKey, string> = {
  instanceName: 'instance.name',
  defaultCurrency: 'instance.default_currency',
  mediaUploadMaxBytes: 'media.upload_max_bytes',
  attachmentUploadMaxBytes: 'attachment.upload_max_bytes',
  publicJoinEnabled: 'access.public_join_enabled',
  maintenanceMode: 'maintenance.enabled',
  maintenanceMessage: 'maintenance.message',
};

function setSessionActor(session: Session): Session {
  idempotencyReservations.setActor(session.user.id);
  return session;
}

/** Clears browser-owned state that must never cross authenticated sessions. */
export function clearAuthenticatedClientState(): void {
  idempotencyReservations.clearAll();
}

function invitationCategoryGrants(categoryPermissions: InvitationInput['categoryPermissions']): Record<string, string[]> {
  return Object.fromEntries(categoryPermissions.flatMap((permission) => {
    const grants = [permission.assignToOthers ? 'ASSIGN_TO_OTHERS' : null, permission.voidBookings ? 'VOID_BOOKINGS' : null].filter((value): value is string => Boolean(value));
    return grants.length > 0 ? [[permission.categoryId, grants]] : [];
  }));
}

function adaptInvitation(input: unknown): InvitationMetadata {
  const source = input as Record<string, unknown>;
  const grants = (source.categoryGrants ?? {}) as Record<string, string[]>;
  const categoryPermissions = Array.isArray(source.categoryPermissions)
    ? source.categoryPermissions as InvitationMetadata['categoryPermissions']
    : Object.entries(grants).map(([categoryId, permissions]) => ({
      categoryId,
      assignToOthers: permissions.includes('ASSIGN_TO_OTHERS'),
      voidBookings: permissions.includes('VOID_BOOKINGS'),
    }));
  return {
    id: String(source.id ?? ''),
    email: String(source.email ?? ''),
    displayName: typeof source.displayName === 'string' && source.displayName ? source.displayName : undefined,
    roles: [...((source.roles as InvitationMetadata['roles'] | undefined) ?? []).filter((role) => role !== 'MEMBER'), 'MEMBER'],
    groupPermissions: (source.groupPermissions as InvitationMetadata['groupPermissions'] | undefined) ?? [],
    categoryPermissions,
    ...(Array.isArray(source.roleIds) ? { roleIds: source.roleIds.map(String) } : {}),
    roleAssignmentsVersion: Number(source.roleAssignmentsVersion ?? source.version ?? 1),
    ...(typeof source.etag === 'string' ? { etag: source.etag } : {}),
    expiresAt: String(source.expiresAt ?? ''),
    ...(typeof source.acceptedAt === 'string' ? { acceptedAt: source.acceptedAt } : {}),
    ...(typeof source.revokedAt === 'string' ? { revokedAt: source.revokedAt } : {}),
    emailDeliveryStatus: (source.emailDeliveryStatus as EmailDeliveryStatus | undefined) ?? 'NOT_REQUESTED',
    emailSentAt: typeof source.emailSentAt === 'string' ? source.emailSentAt : undefined,
    ...(typeof source.emailFailureCode === 'string' && source.emailFailureCode ? { emailFailureCode: source.emailFailureCode } : {}),
    ...(typeof source.targetMembershipId === 'string' && source.targetMembershipId ? { targetMembershipId: source.targetMembershipId } : {}),
  };
}

function isDefinitiveClientError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.problem.status >= 400 && error.problem.status < 500 && ![408, 425, 429].includes(error.problem.status);
}

async function idempotentRequest<T>(groupId: string, operation: string, path: string, payload: unknown, init: Omit<RequestInit, 'headers'> & { headers?: HeadersInit } = {}): Promise<T> {
  let reservation: IdempotencyReservation;
  try {
    reservation = await idempotencyReservations.reserve({ groupId, operation, path, payload });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Authenticated actor')) {
      throw new Error(i18n.t('errors.actorMissing'), { cause: error });
    }
    throw error;
  }
  const headers = new Headers(init.headers);
  headers.set('Idempotency-Key', reservation.key);
  try {
    const result = await request<T>(path, { ...init, headers });
    idempotencyReservations.complete(reservation);
    return result;
  } catch (error) {
    if (isDefinitiveClientError(error)) idempotencyReservations.complete(reservation);
    throw error;
  }
}

/**
 * Typed facade for TeamTaler's `/api/v1` resources.
 *
 * Read methods normalize backend wire values. Financial and high-risk mutation
 * methods reserve scoped idempotency keys and may throw {@link ApiError}, network
 * errors, validation errors, or an actor-state error.
 *
 * @example
 * ```ts
 * const session = await api.getSession();
 * if (session.activeGroupId) await api.getCategories(session.activeGroupId);
 * ```
 *
 * System-administration wire contract:
 * - settings and capabilities are direct camelCase documents; list endpoints
 *   return `{ items: [...] }`;
 * - settings, SMTP, invitation resend, archive, restore, and purge mutations require a strong
 *   `If-Match: "v{revision}"` header;
 * - scalar reset posts `{ keys: [coreSettingKey] }`, SMTP PUT never returns a
 *   password, and an omitted SMTP password preserves the stored secret;
 * - purge posts the exact current group name and returns the final
 *   deletion-impact receipt.
 */
export const api = {
  getSession: async (): Promise<Session> => setSessionActor(adaptSession(await request<unknown>('/session'))),
  getInstanceCapabilities: async (): Promise<InstanceCapabilities> => adaptInstanceCapabilities(await request<unknown>('/instance/capabilities')),
  getAuthenticationCapabilities: async (): Promise<AuthenticationCapabilities> => request<AuthenticationCapabilities>('/auth/capabilities'),
  /**
   * Reads the direct or `{ settings }` system document from `GET /system/settings`.
   * Mutations below send camelCase JSON and require `If-Match: "v{revision}"`.
   */
  getSystemSettings: async (): Promise<SystemSettings> => adaptSystemSettings(await request<unknown>('/system/settings')),
  updateSystemSettings: async (update: SystemSettingsUpdate, revision: number): Promise<SystemSettings> => adaptSystemSettings(await request<unknown>('/system/settings', {
    method: 'PATCH',
    headers: versionHeaders(revision),
    body: json(update),
  })),
  resetSystemSettings: async (keys: ResettableSystemSettingKey[], revision: number): Promise<SystemSettings> => adaptSystemSettings(await request<unknown>('/system/settings/reset', {
    method: 'POST',
    headers: versionHeaders(revision),
    body: json({ keys: keys.map((key) => systemSettingKeys[key]) }),
  })),
  updateSystemSmtp: async (update: SystemSmtpSettingsUpdate, revision: number): Promise<SystemSettings> => adaptSystemSettings(await request<unknown>('/system/settings/smtp', {
    method: 'PUT',
    headers: versionHeaders(revision),
    body: json(update),
  })),
  resetSystemSmtp: async (revision: number): Promise<SystemSettings> => adaptSystemSettings(await request<unknown>('/system/settings/smtp', {
    method: 'DELETE',
    headers: versionHeaders(revision),
  })),
  testSystemSmtp: async (revision: number): Promise<SystemSettings> => adaptSystemSettings(await request<unknown>('/system/settings/smtp/test', {
    method: 'POST',
    headers: versionHeaders(revision),
  })),
  updateSystemWebPush: async (update: SystemWebPushSettingsUpdate, revision: number): Promise<SystemSettings> => adaptSystemSettings(await request<unknown>('/system/settings/web-push', {
    method: 'PUT',
    headers: versionHeaders(revision),
    body: json(update),
  })),
  resetSystemWebPush: async (revision: number): Promise<SystemSettings> => adaptSystemSettings(await request<unknown>('/system/settings/web-push', {
    method: 'DELETE',
    headers: versionHeaders(revision),
  })),
  generateSystemWebPushKey: async (revision: number): Promise<SystemSettings> => adaptSystemSettings(await request<unknown>('/system/settings/web-push/generate-key', {
    method: 'POST',
    headers: versionHeaders(revision),
    body: json({ confirmRotation: true }),
  })),
  testSystemWebPush: async (revision: number, subscriptionId?: string): Promise<SystemSettings> => adaptSystemSettings(await request<unknown>('/system/settings/web-push/test', {
    method: 'POST',
    headers: versionHeaders(revision),
    ...(subscriptionId ? { body: json({ subscriptionId }) } : {}),
  })),
  searchSystemAccounts: async (query = ''): Promise<SystemAccount[]> => {
    const parameters = new URLSearchParams();
    if (query.trim()) parameters.set('q', query.trim());
    const suffix = parameters.size > 0 ? `?${parameters.toString()}` : '';
    return adaptSystemAccounts(await request<unknown>(`/system/accounts${suffix}`));
  },
  getSystemAdministrators: async (): Promise<SystemAccount[]> => adaptSystemAccounts(await request<unknown>('/system/administrators')),
  getSystemGroups: async (): Promise<SystemGroup[]> => adaptSystemGroups(await request<unknown>('/system/groups')),
  getSystemGroupDeletionImpact: async (groupId: string): Promise<SystemGroupDeletionImpact> => adaptSystemGroupDeletionImpact(await request<unknown>(systemGroupPath(groupId, 'deletion-impact'))),
  createSystemGroup: async (input: SystemGroupCreateInput): Promise<SystemGroupInvitationResult> => adaptSystemGroupInvitationResult(await request<unknown>('/system/groups', { method: 'POST', body: json({ name: input.name, currency: input.currency, initialAdministratorEmail: input.administratorEmail }) })),
  archiveSystemGroup: async (groupId: string, version: number): Promise<SystemGroup> => adaptSystemGroups([await request<unknown>(systemGroupPath(groupId, 'archive'), {
    method: 'POST',
    headers: versionHeaders(version),
  })])[0],
  restoreSystemGroup: async (groupId: string, version: number): Promise<SystemGroup> => adaptSystemGroups([await request<unknown>(systemGroupPath(groupId, 'restore'), {
    method: 'POST',
    headers: versionHeaders(version),
  })])[0],
  resendSystemGroupInvitation: async (groupId: string, version: number): Promise<SystemGroupInvitationResult> => adaptSystemGroupInvitationResult(await request<unknown>(systemGroupPath(groupId, 'invitation/resend'), {
    method: 'POST',
    headers: versionHeaders(version),
  })),
  purgeSystemGroup: async (groupId: string, version: number, input: SystemGroupPurgeInput): Promise<SystemGroupDeletionImpact> => adaptSystemGroupDeletionImpact(await request<unknown>(systemGroupPath(groupId, 'purge'), {
    method: 'POST',
    headers: versionHeaders(version),
    body: json(input),
  })),
  getSystemAudit: async (): Promise<SystemAuditEntry[]> => adaptSystemAudit(await request<unknown>('/system/audit')),
  getSystemAuditFilterOptions: (): Promise<AuditFilterOptions> => request<AuditFilterOptions>('/system/audit/filter-options'),
  getSystemAuditPage: async (query: SystemAuditCollectionQuery = {}): Promise<CollectionPage<SystemAuditEntry>> => {
    const response = await requestWithMetadata<unknown>(collectionPath('/system/audit', query));
    return collectionPage(adaptSystemAudit(response.data), response.headers, query.limit);
  },
  exportSystemTable: (command: TableExportCommand): Promise<Blob> => requestBlob('/system/table-exports', { method: 'POST', body: json(command) }),
  requestPasswordReset: async (email: string): Promise<void> => request<void>('/auth/password-reset/request', { method: 'POST', body: json({ email }) }),
  confirmPasswordReset: async (token: string, newPassword: string): Promise<void> => {
    await request<void>('/auth/password-reset/confirm', { method: 'POST', body: json({ token, newPassword }) });
    clearAuthenticatedClientState();
  },
  confirmEmailChange: async (token: string): Promise<void> => {
    await request<void>('/auth/email-change/confirm', { method: 'POST', body: json({ token }) });
    clearAuthenticatedClientState();
  },
  updateProfile: async (displayName: string): Promise<User> => adaptUser(await request<unknown>('/me/profile', { method: 'PATCH', body: json({ displayName }) })),
  updateAppearance: async (colorMode: ColorMode): Promise<AppearancePreference> => adaptAppearancePreference(await request<unknown>('/me/appearance', { method: 'PUT', body: json({ colorMode }) })),
  updateDefaultGroup: async (defaultGroupId: string | null): Promise<GroupPreference> => request<GroupPreference>('/me/group-preference', { method: 'PUT', body: json({ defaultGroupId }) }),
  recordLastUsedGroup: async (groupId: string): Promise<void> => request<void>('/me/group-preference/last-used', { method: 'PUT', body: json({ groupId }) }),
  changePassword: async (currentPassword: string, newPassword: string): Promise<void> => {
    await request<void>('/me/password', { method: 'PUT', body: json({ currentPassword, newPassword }) });
    clearAuthenticatedClientState();
  },
  requestEmailChange: async (newEmail: string, currentPassword: string): Promise<EmailChangeRequestResult> => request<EmailChangeRequestResult>('/me/email-change', { method: 'POST', body: json({ newEmail, currentPassword }) }),
  uploadProfileAvatar: async (image: File): Promise<{ avatarUrl: string }> => {
    const form = new FormData();
    form.set('image', image);
    return request<{ avatarUrl: string }>('/me/avatar', { method: 'POST', body: form });
  },
  removeProfileAvatar: async (): Promise<void> => request<void>('/me/avatar', { method: 'DELETE' }),
  getPushSubscriptions: async (): Promise<PushSubscriptionDevice[]> => adaptPushSubscriptions(await request<unknown>('/me/push-subscriptions')),
  registerPushSubscription: async (input: PushSubscriptionRegistration): Promise<PushSubscriptionDevice> => adaptPushSubscriptions([await request<unknown>('/me/push-subscriptions', {
    method: 'POST',
    body: json(input),
  })])[0],
  renamePushSubscription: async (subscriptionId: string, label: string): Promise<PushSubscriptionDevice> => adaptPushSubscriptions([await request<unknown>(`/me/push-subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'PATCH',
    body: json({ label }),
  })])[0],
  deletePushSubscription: async (subscriptionId: string): Promise<void> => request<void>(`/me/push-subscriptions/${encodeURIComponent(subscriptionId)}`, { method: 'DELETE' }),
  login: async (command: LoginCommand): Promise<Session> => setSessionActor(adaptSession(await request<unknown>('/auth/login', { method: 'POST', body: json(command) }))),
  logout: async (): Promise<void> => {
    try {
      await request('/auth/logout', { method: 'POST' });
    } finally {
      clearAuthenticatedClientState();
    }
  },
  previewInvitation: async (token: string): Promise<InvitationPreview> => request<InvitationPreview>('/invitations/preview', { method: 'POST', body: json({ token }) }),
  acceptInvitation: async (command: InvitationCommand): Promise<Session> => setSessionActor(adaptSession(await request<unknown>('/invitations/accept', { method: 'POST', body: json(command) }))),
  previewPublicJoinLink: async (token: string): Promise<PublicJoinPreview> => request<PublicJoinPreview>('/public-join-links/preview', { method: 'POST', body: json({ token }) }),
  startPublicJoinRegistration: async (input: PublicJoinRegistrationInput): Promise<{ verificationRequired: true }> => request<{ verificationRequired: true }>('/public-join-links/registrations', { method: 'POST', body: json(input) }),
  resendPublicJoinVerification: async (joinToken: string, email: string): Promise<{ verificationRequired: true }> => request<{ verificationRequired: true }>('/public-join-links/registrations/resend', { method: 'POST', body: json({ joinToken, email }) }),
  confirmPublicJoinRegistration: async (token: string): Promise<Session> => setSessionActor(adaptSession(await request<unknown>('/public-join-links/registrations/confirm', { method: 'POST', body: json({ token }) }))),
  acceptPublicJoinLink: async (token: string): Promise<Session> => setSessionActor(adaptSession(await request<unknown>('/public-join-links/accept', { method: 'POST', body: json({ token }) }))),
  createInvitation: async (groupId: string, input: InvitationInput): Promise<CreatedInvitation> => {
    const roleBased = input.roleIds !== undefined;
    const response = await request<unknown>(groupPath(groupId, 'invitations'), {
      method: 'POST',
      body: json(roleBased
        ? { email: input.email, displayName: input.displayName, roleIds: input.roleIds }
        : {
          email: input.email,
          displayName: input.displayName,
          roles: input.roles.filter((role) => role !== 'MEMBER'),
          groupPermissions: input.groupPermissions,
          categoryGrants: invitationCategoryGrants(input.categoryPermissions),
        }),
    });
    const source = response as { invitation?: unknown; acceptUrl?: string };
    const invitation = adaptInvitation(source.invitation ?? response);
    return {
      ...invitation,
      email: invitation.email || input.email,
      acceptUrl: source.acceptUrl ?? '',
    };
  },
  getInvitations: async (groupId: string): Promise<InvitationMetadata[]> => (await request<unknown[]>(groupPath(groupId, 'invitations'))).map(adaptInvitation),
  updateInvitation: async (groupId: string, invitationId: string, input: InvitationUpdateInput): Promise<InvitationMetadata> => {
    const roleBased = input.roleIds !== undefined;
    return adaptInvitation(await request<unknown>(groupPath(groupId, `invitations/${encodeURIComponent(invitationId)}`), {
      method: 'PATCH',
      headers: { 'If-Match': `"v${input.roleAssignmentsVersion}"` },
      body: json(roleBased
        ? { displayName: input.displayName, roleIds: input.roleIds }
        : {
          displayName: input.displayName,
          roles: input.roles.filter((role) => role !== 'MEMBER'),
          groupPermissions: input.groupPermissions,
          categoryGrants: invitationCategoryGrants(input.categoryPermissions),
        }),
    }));
  },
  revokeInvitation: async (groupId: string, invitationId: string): Promise<void> => request<void>(groupPath(groupId, `invitations/${encodeURIComponent(invitationId)}`), { method: 'DELETE' }),
  importInvitations: async (groupId: string, file: File, roleIds: string[] = []): Promise<InvitationImportResult> => {
    const query = new URLSearchParams();
    roleIds.forEach((roleId) => query.append('roleId', roleId));
    const queryString = query.toString();
    const path = `${groupPath(groupId, 'invitations/import')}${queryString ? `?${queryString}` : ''}`;
    let csv: string;
    try {
      csv = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      throw new Error(i18n.t('members.csvImport.invalidUtf8'));
    }
    return idempotentRequest<InvitationImportResult>(groupId, 'invitation.import', path, csv, {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv; charset=utf-8' },
      body: csv,
    });
  },
  retryInvitationEmail: async (groupId: string, invitationId: string): Promise<InvitationEmailRetryResult> => {
    const path = groupPath(groupId, `invitations/${encodeURIComponent(invitationId)}/email/retry`);
    return idempotentRequest<InvitationEmailRetryResult>(groupId, 'invitation.email.retry', path, { invitationId }, { method: 'POST' });
  },
  resendInvitationEmail: async (groupId: string, invitationId: string): Promise<InvitationEmailResendResult> => {
    const path = groupPath(groupId, `invitations/${encodeURIComponent(invitationId)}/email/resend`);
    return idempotentRequest<InvitationEmailResendResult>(groupId, 'invitation.email.resend', path, { invitationId }, { method: 'POST' });
  },
  updateGroupName: async (groupId: string, name: string): Promise<{ name: string }> => request<{ name: string }>(groupRootPath(groupId), { method: 'PATCH', body: json({ name }) }),
  getGroupSettings: async (groupId: string): Promise<GroupSettings> => adaptGroupSettings(await request<unknown>(groupPath(groupId, 'settings'))),
  getGroupNotificationSettings: async (groupId: string): Promise<GroupNotificationSettings> => adaptGroupNotificationSettings(await request<unknown>(groupPath(groupId, 'notification-settings'))),
  updateGroupNotificationSettings: async (groupId: string, settings: GroupNotificationSettingsUpdate): Promise<GroupNotificationSettings> => adaptGroupNotificationSettings(await request<unknown>(groupPath(groupId, 'notification-settings'), {
    method: 'PUT',
    headers: versionHeaders(settings.version),
    body: json({
      timezone: settings.timezone,
      dueSoonLeadDays: settings.dueSoonLeadDays,
      overdueRepeatDays: settings.overdueRepeatDays,
      events: settings.events.map((event) => ({ type: event.eventType, enabled: event.enabled })),
    }),
  })),
  getNotificationPreferences: async (groupId: string): Promise<NotificationPreferences> => adaptNotificationPreferences(await request<unknown>(groupPath(groupId, 'notification-preferences'))),
  updateNotificationPreferences: async (groupId: string, preferences: NotificationPreferencesUpdate): Promise<NotificationPreferences> => adaptNotificationPreferences(await request<unknown>(groupPath(groupId, 'notification-preferences'), {
    method: 'PUT',
    headers: versionHeaders(preferences.version),
    body: json({ events: preferences.events.map((event) => ({
      type: event.eventType,
      ...(event.email !== undefined ? { email: event.email } : {}),
      ...(event.push !== undefined ? { push: event.push } : {}),
    })) }),
  })),
  getTransactionSettings: async (groupId: string): Promise<TransactionSettings> => adaptTransactionSettings(await request<unknown>(groupPath(groupId, 'transaction-settings'))),
  updateGroupSettings: async (groupId: string, settings: GroupSettingsUpdateInput): Promise<GroupSettings> => adaptGroupSettings(await request<unknown>(groupPath(groupId, 'settings'), {
    method: 'PATCH',
    body: json(settings),
  })),
  updateThemePreference: async (groupId: string, themeOverride: ThemeId | null): Promise<ThemePreference> => adaptThemePreference(await request<unknown>(groupPath(groupId, 'theme-preference'), {
    method: 'PUT',
    body: json({ themeOverride }),
  })),
  getPublicJoinLink: async (groupId: string): Promise<PublicJoinLink> => request<PublicJoinLink>(groupPath(groupId, 'public-join-link')),
  updatePublicJoinLink: async (groupId: string, update: PublicJoinLinkUpdate, version: number): Promise<PublicJoinLink> => request<PublicJoinLink>(groupPath(groupId, 'public-join-link'), {
    method: 'PUT',
    headers: version > 0 ? { 'If-Match': `"v${version}"` } : undefined,
    body: json(update),
  }),
  rotatePublicJoinLink: async (groupId: string, version: number): Promise<PublicJoinLink> => request<PublicJoinLink>(groupPath(groupId, 'public-join-link/rotate'), {
    method: 'POST',
    headers: { 'If-Match': `"v${version}"` },
  }),
  uploadGroupLogo: async (groupId: string, image: File): Promise<{ logoUrl: string }> => {
    const form = new FormData();
    form.set('image', image);
    return request<{ logoUrl: string }>(groupPath(groupId, 'logo'), { method: 'POST', body: form });
  },
  removeGroupLogo: async (groupId: string): Promise<void> => request<void>(groupPath(groupId, 'logo'), { method: 'DELETE' }),
  getDashboard: async (groupId: string): Promise<Dashboard> => adaptDashboard(await request<unknown>(groupPath(groupId, 'dashboard'))),
  getStatistics: async (groupId: string, query: StatisticsQuery): Promise<StatisticsDashboard> => adaptStatisticsDashboard(await request<unknown>(collectionPath(groupPath(groupId, 'statistics'), query))),
  exportGroupTable: (groupId: string, command: TableExportCommand): Promise<Blob> => requestBlob(groupPath(groupId, 'table-exports'), { method: 'POST', body: json(command) }),
  createGroupDataExport: (groupId: string, currentPassword: string, idempotencyKey: string = crypto.randomUUID()): Promise<DataExportJob> => request<DataExportJob>(groupPath(groupId, 'exports'), {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: json({ currentPassword }),
  }),
  createPersonalDataExport: (groupId: string, currentPassword: string, idempotencyKey: string = crypto.randomUUID()): Promise<DataExportJob> => request<DataExportJob>(groupPath(groupId, 'me/exports'), {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: json({ currentPassword }),
  }),
  getDataExports: async (groupId: string): Promise<DataExportJob[]> => {
    const response = await request<DataExportJob[] | { items: DataExportJob[] }>(`/exports?${new URLSearchParams({ groupId }).toString()}`);
    return Array.isArray(response) ? response : response.items;
  },
  getDataExport: (exportId: string): Promise<DataExportJob> => request<DataExportJob>(`/exports/${encodeURIComponent(exportId)}`),
  getDataExportDownloadURL: (exportId: string): string => `${API_BASE}/exports/${encodeURIComponent(exportId)}/download`,
  deleteDataExport: (exportId: string): Promise<void> => request<void>(`/exports/${encodeURIComponent(exportId)}`, { method: 'DELETE' }),
  getBookingContext: async (groupId: string, currency: string): Promise<BookingContext> => adaptBookingContext(await request<unknown>(groupPath(groupId, 'booking-context')), currency),
  getCategories: async (groupId: string): Promise<Category[]> => adaptCategories(await request<unknown>(groupPath(groupId, 'categories'))),
  getMembers: async (groupId: string): Promise<Membership[]> => adaptMemberships(await request<unknown>(groupPath(groupId, 'members'))),
  renameMember: async (groupId: string, membershipId: string, displayName: string): Promise<Membership> => adaptMembership(await request<unknown>(groupPath(groupId, `members/${encodeURIComponent(membershipId)}`), {
    method: 'PATCH',
    body: json({ displayName }),
  })),
  createTemporaryGuestClaimInvitation: async (groupId: string, membershipId: string, email: string, roleIds: string[]): Promise<CreatedInvitation> => {
    const response = await request<unknown>(groupPath(groupId, `members/${encodeURIComponent(membershipId)}/claim-invitation`), {
      method: 'POST',
      body: json({ email, roleIds }),
    });
    const source = response as { invitation?: unknown; acceptUrl?: string };
    const invitation = adaptInvitation(source.invitation ?? response);
    return { ...invitation, email: invitation.email || email, acceptUrl: source.acceptUrl ?? '' };
  },
  archiveMember: async (groupId: string, membershipId: string, confirmSelf: boolean): Promise<void> => request<void>(`${groupPath(groupId, `members/${encodeURIComponent(membershipId)}`)}${confirmSelf ? '?confirmSelf=true' : ''}`, { method: 'DELETE' }),
  reactivateMember: async (groupId: string, membershipId: string, command: MemberReactivationCommand): Promise<Membership> => adaptMembership(await request<unknown>(groupPath(groupId, `members/${encodeURIComponent(membershipId)}/reactivate`), {
    method: 'POST',
    body: json(command),
  })),
  permanentlyDeleteMember: async (groupId: string, membershipId: string): Promise<void> => request<void>(groupPath(groupId, `members/${encodeURIComponent(membershipId)}/permanent`), { method: 'DELETE' }),
  getBookings: async (groupId: string): Promise<Booking[]> => (await request<unknown[]>(groupPath(groupId, 'bookings'))).map((booking) => adaptBooking(booking)),
  getActivityFilterOptions: (groupId: string): Promise<ActivityFilterOptions> => request<ActivityFilterOptions>(groupPath(groupId, 'activities/filter-options')),
  getActivitiesPage: async (groupId: string, query: ActivityCollectionQuery = {}): Promise<CollectionPage<ActivityEntry>> => {
    const response = await requestWithMetadata<unknown[]>(collectionPath(groupPath(groupId, 'activities'), query));
    return collectionPage(response.data.map(adaptActivity), response.headers, query.limit);
  },
  getBookingFilterOptions: (groupId: string): Promise<BookingFilterOptions> => request<BookingFilterOptions>(groupPath(groupId, 'bookings/filter-options')),
  getBookingsPage: async (groupId: string, query: BookingCollectionQuery = {}): Promise<CollectionPage<Booking>> => {
    const response = await requestWithMetadata<unknown[]>(collectionPath(groupPath(groupId, 'bookings'), query));
    return collectionPage(response.data.map((booking) => adaptBooking(booking)), response.headers, query.limit);
  },
  createBooking: async (groupId: string, command: BookingCommand): Promise<Booking> => {
    const path = groupPath(groupId, 'bookings');
    const payload = {
      ...command,
      unitPriceMinor: command.unitPrice ? minorUnitsToSafeNumber(command.unitPrice.minorUnits) : undefined,
      unitPrice: undefined,
    };
    return adaptBooking(await idempotentRequest<unknown>(groupId, 'booking.create', path, payload, { method: 'POST', body: json(payload) }));
  },
  createBookings: async (groupId: string, command: BookingBatchCommand): Promise<Booking[]> => {
    const path = groupPath(groupId, 'bookings/batch');
    const payload = {
      ...command,
      unitPriceMinor: command.unitPrice ? minorUnitsToSafeNumber(command.unitPrice.minorUnits) : undefined,
      unitPrice: undefined,
    };
    const response = await idempotentRequest<unknown[]>(groupId, 'booking.batch.create', path, payload, { method: 'POST', body: json(payload) });
    return response.map((booking) => adaptBooking(booking));
  },
  createBulkBookings: async (groupId: string, command: BookingBulkCommand): Promise<Booking[]> => {
    const path = groupPath(groupId, 'bookings/bulk');
    const payload = {
      ...command,
      items: command.items.map((item) => ({
        ...item,
        unitPriceMinor: item.unitPrice ? minorUnitsToSafeNumber(item.unitPrice.minorUnits) : undefined,
        unitPrice: undefined,
      })),
    };
    const response = await idempotentRequest<unknown[]>(groupId, 'booking.bulk.create', path, payload, { method: 'POST', body: json(payload) });
    return response.map((booking) => adaptBooking(booking));
  },
  reverseBooking: async (groupId: string, bookingId: string, reason: string): Promise<Booking> => {
    const path = groupPath(groupId, `bookings/${bookingId}/void`);
    const payload = { reason };
    return adaptBooking(await idempotentRequest<unknown>(groupId, 'booking.void', path, payload, { method: 'POST', body: json(payload) }));
  },
  getLedger: async (groupId: string): Promise<LedgerEntry[]> => adaptLedger(await request<unknown>(groupPath(groupId, 'accounts/me'))),
  getAccountSummaries: async (groupId: string): Promise<AccountSummary[]> => adaptAccountSummaries(await request<unknown>(groupPath(groupId, 'accounts'))),
  getPayments: async (groupId: string): Promise<Payment[]> => (await request<unknown[]>(groupPath(groupId, 'payments'))).map(adaptPayment),
  getPaymentsPage: async (groupId: string, query: PaymentCollectionQuery = {}): Promise<CollectionPage<Payment>> => {
    const response = await requestWithMetadata<unknown[]>(collectionPath(groupPath(groupId, 'payments'), query));
    return collectionPage(response.data.map(adaptPayment), response.headers, query.limit);
  },
  createPayment: async (groupId: string, command: PaymentCommand, attachment?: File): Promise<Payment> => {
    const path = groupPath(groupId, 'payments');
    const payload = { ...command, amountMinor: minorUnitsToSafeNumber(command.amount.minorUnits), amount: undefined, receivedAt: new Date(command.receivedAt).toISOString() };
    const fingerprint = attachment ? { command: payload, attachmentSha256: await fileSha256(attachment) } : payload;
    return adaptPayment(await idempotentRequest<unknown>(groupId, 'payment.create', path, fingerprint, { method: 'POST', body: attachment ? paymentMultipart(payload, attachment) : json(payload) }));
  },
  createOwnPayment: async (groupId: string, command: SelfPaymentCommand, attachment?: File): Promise<Payment> => {
    const path = groupPath(groupId, 'payments/self');
    const payload = { ...command, amountMinor: minorUnitsToSafeNumber(command.amount.minorUnits), amount: undefined, receivedAt: new Date(command.receivedAt).toISOString() };
    const fingerprint = attachment ? { command: payload, attachmentSha256: await fileSha256(attachment) } : payload;
    return adaptPayment(await idempotentRequest<unknown>(groupId, 'payment.self.create', path, fingerprint, { method: 'POST', body: attachment ? paymentMultipart(payload, attachment) : json(payload) }));
  },
  getPaymentAttachment: (groupId: string, paymentId: string): Promise<Blob> => requestBlob(groupPath(groupId, `payments/${paymentId}/attachment`)),
  reversePayment: (groupId: string, paymentId: string, reason: string): Promise<void> => {
    const path = groupPath(groupId, `payments/${paymentId}/reverse`);
    const payload = { reason };
    return idempotentRequest<void>(groupId, 'payment.reverse', path, payload, { method: 'POST', body: json(payload) });
  },
  getPeriods: async (groupId: string): Promise<Period[]> => (await request<unknown[]>(groupPath(groupId, 'periods'))).map(adaptPeriod),
  closePeriod: async (groupId: string, periodId: string, command: { label: string; dueAt: string }): Promise<Period> => {
    const path = groupPath(groupId, `periods/${periodId}/close`);
    const payload = { ...command, nextPeriodLabel: i18n.t('periods.defaultOpenLabel') };
    const result = await idempotentRequest<unknown>(groupId, 'period.close', path, payload, { method: 'POST', body: json(payload) });
    const source = result as { closedPeriod?: unknown };
    return adaptPeriod(source.closedPeriod ?? result);
  },
  getSettlements: async (groupId: string): Promise<Settlement[]> => {
    const [statements, periods] = await Promise.all([request<unknown[]>(groupPath(groupId, 'settlements')), request<unknown[]>(groupPath(groupId, 'periods'))]);
    const adaptedPeriods = periods.map(adaptPeriod);
    return statements.map((statement) => adaptSettlement(statement, adaptedPeriods));
  },
  getNotifications: async (groupId: string): Promise<Notification[]> => (await request<unknown[]>(groupPath(groupId, 'notifications'))).map(adaptNotification),
  getNotificationsPage: async (groupId: string, cursor?: string): Promise<NotificationPage> => {
    const query = new URLSearchParams({ limit: '50' });
    if (cursor) query.set('cursor', cursor);
    const response = await requestWithMetadata<unknown[]>(`${groupPath(groupId, 'notifications')}?${query.toString()}`);
    return { items: response.data.map(adaptNotification), nextCursor: response.headers.get('X-Next-Cursor') ?? undefined };
  },
  getNotificationDestination: async (notificationId: string): Promise<NotificationDestination> => adaptNotificationDestination(
    await request<unknown>(`/me/notifications/${encodeURIComponent(notificationId)}/destination`),
  ),
  getNotificationSummary: (groupId: string): Promise<NotificationSummary> => request<NotificationSummary>(groupPath(groupId, 'notifications/summary')),
  markNotificationsRead: (groupId: string, notificationIds: string[]): Promise<NotificationReadResult> => request<NotificationReadResult>(groupPath(groupId, 'notifications/read'), { method: 'PATCH', body: json({ notificationIds }) }),
  markNotificationRead: async (groupId: string, notificationId: string): Promise<Notification> => adaptNotification(await request<unknown>(groupPath(groupId, `notifications/${notificationId}`), { method: 'PATCH', body: json({ read: true }) })),
  getAudit: async (groupId: string): Promise<AuditEntry[]> => {
    const [entries, members] = await Promise.all([request<unknown[]>(groupPath(groupId, 'audit')), request<unknown>(groupPath(groupId, 'members'))]);
    const adaptedMembers = adaptMemberships(members);
    return entries.map((entry) => adaptAuditEntry(entry, adaptedMembers));
  },
  getAuditFilterOptions: (groupId: string): Promise<AuditFilterOptions> => request<AuditFilterOptions>(groupPath(groupId, 'audit/filter-options')),
  getAuditPage: async (groupId: string, query: AuditCollectionQuery = {}): Promise<CollectionPage<AuditEntry>> => {
    const [response, members] = await Promise.all([
      requestWithMetadata<unknown[]>(collectionPath(groupPath(groupId, 'audit'), query)),
      request<unknown>(groupPath(groupId, 'members')),
    ]);
    const adaptedMembers = adaptMemberships(members);
    return collectionPage(response.data.map((entry) => adaptAuditEntry(entry, adaptedMembers)), response.headers, query.limit);
  },
  getPermissionDefinitions: async (): Promise<PermissionDefinition[]> => {
    const response = await request<unknown>('/permission-definitions');
    const entries = Array.isArray(response) ? response : (response as { permissions?: unknown[] }).permissions ?? [];
    return entries.map(adaptPermissionDefinition);
  },
  getRoles: async (groupId: string): Promise<Role[]> => {
    const response = await request<unknown>(groupPath(groupId, 'roles'));
    const entries = Array.isArray(response) ? response : (response as { roles?: unknown[] }).roles ?? [];
    return entries.map(adaptRole);
  },
  getRole: async (groupId: string, roleId: string): Promise<Role> => adaptRole(await request<unknown>(groupPath(groupId, `roles/${encodeURIComponent(roleId)}`))),
  createRole: async (groupId: string, input: RoleInput): Promise<Role> => adaptRole(await request<unknown>(groupPath(groupId, 'roles'), {
    method: 'POST',
    body: json(input),
  })),
  updateRole: async (groupId: string, roleId: string, input: RoleInput, version: number): Promise<Role> => adaptRole(await request<unknown>(groupPath(groupId, `roles/${encodeURIComponent(roleId)}`), {
    method: 'PUT',
    headers: { 'If-Match': `"v${version}"` },
    body: json(input),
  })),
  deleteRole: async (groupId: string, roleId: string, version: number): Promise<void> => request<void>(groupPath(groupId, `roles/${encodeURIComponent(roleId)}`), {
    method: 'DELETE',
    headers: { 'If-Match': `"v${version}"` },
  }),
  getRoleAssignments: async (groupId: string): Promise<RoleAssignment[]> => {
    const response = await request<unknown>(groupPath(groupId, 'role-assignments'));
    const entries = Array.isArray(response) ? response : (response as { assignments?: unknown[] }).assignments ?? [];
    return entries.map(adaptRoleAssignment);
  },
  updateMemberRoles: async (groupId: string, membershipId: string, roleIds: string[], version: number): Promise<RoleAssignment> => adaptRoleAssignment(await request<unknown>(groupPath(groupId, `members/${encodeURIComponent(membershipId)}/roles`), {
    method: 'PUT',
    headers: { 'If-Match': `"v${version}"` },
    body: json({ roleIds }),
  })),
  updateInvitationRoles: async (groupId: string, invitationId: string, roleIds: string[], version: number): Promise<RoleAssignment> => adaptRoleAssignment(await request<unknown>(groupPath(groupId, `invitations/${encodeURIComponent(invitationId)}/roles`), {
    method: 'PUT',
    headers: { 'If-Match': `"v${version}"` },
    body: json({ roleIds }),
  })),
  updatePermissions: async (groupId: string, membershipId: string, update: PermissionUpdate, version: number): Promise<void> => {
    const categoryGrants = Object.fromEntries(update.categoryPermissions.map((permission) => [permission.categoryId, [permission.assignToOthers ? 'ASSIGN_TO_OTHERS' : null, permission.voidBookings ? 'VOID_BOOKINGS' : null].filter(Boolean)]));
    await request<void>(groupPath(groupId, `members/${membershipId}/permissions`), { method: 'PATCH', headers: { 'If-Match': `"v${version}"` }, body: json({ roles: update.roles.filter((role) => role !== 'MEMBER'), groupPermissions: update.groupPermissions, categoryGrants }) });
  },
  createCategory: async (groupId: string, input: CategoryCreateCommand): Promise<Category> => adaptCategories([await request<unknown>(groupPath(groupId, 'categories'), { method: 'POST', body: json({ ...input, sortOrder: 0 }) })])[0],
  updateCategory: async (groupId: string, categoryId: string, input: CategoryUpdateCommand): Promise<Category> => adaptCategories([await request<unknown>(groupPath(groupId, `categories/${encodeURIComponent(categoryId)}`), {
    method: 'PATCH',
    headers: { 'If-Match': `"v${input.version}"` },
    body: json(input),
  })])[0],
  deleteCategory: async (groupId: string, categoryId: string, version: number): Promise<void> => request<void>(groupPath(groupId, `categories/${encodeURIComponent(categoryId)}`), {
    method: 'DELETE',
    headers: { 'If-Match': `"v${version}"` },
  }),
  reorderCatalog: async (groupId: string, input: CatalogOrderCommand): Promise<Category[]> => adaptCategories(await request<unknown[]>(groupPath(groupId, 'catalog/order'), {
    method: 'PUT',
    body: json(input),
  })),
  createProduct: async (groupId: string, input: ProductCreateCommand): Promise<Product> => {
    const path = groupPath(groupId, `categories/${input.categoryId}/products`);
    const payload = {
      name: input.name,
      pricingMode: input.pricingMode,
      priceMinor: input.price ? minorUnitsToSafeNumber(input.price.minorUnits) : undefined,
      sortOrder: 0,
    };
    return adaptProduct(await idempotentRequest<unknown>(groupId, 'product.create', path, payload, { method: 'POST', body: json(payload) }));
  },
  updateProduct: async (groupId: string, productId: string, input: ProductUpdateCommand): Promise<Product> => {
    const payload = {
      name: input.name,
      pricingMode: input.pricingMode,
      priceMinor: input.price ? minorUnitsToSafeNumber(input.price.minorUnits) : undefined,
      active: input.active,
      sortOrder: input.sortOrder,
      version: input.version,
    };
    return adaptProduct(await request<unknown>(groupPath(groupId, `products/${encodeURIComponent(productId)}`), {
      method: 'PATCH',
      headers: { 'If-Match': `"v${input.version}"` },
      body: json(payload),
    }));
  },
  deleteProduct: async (groupId: string, productId: string, version: number): Promise<void> => request<void>(groupPath(groupId, `products/${encodeURIComponent(productId)}`), {
    method: 'DELETE',
    headers: { 'If-Match': `"v${version}"` },
  }),
  uploadProductImage: async (groupId: string, productId: string, image: File): Promise<{ imageUrl: string }> => {
    const form = new FormData();
    form.set('image', image);
    return request<{ imageUrl: string }>(groupPath(groupId, `products/${productId}/image`), { method: 'POST', body: form });
  },
};

/** Whether development requests may use the clearly labeled, lazy-loaded in-memory fallback. */
export const isDevelopmentDemoEnabled = DEMO_ENABLED;
