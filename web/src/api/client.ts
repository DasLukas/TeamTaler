import { minorUnitsToSafeNumber, normalizeMoney } from './money';
import {
  adaptAccountSummaries,
  adaptAuditEntry,
  adaptBooking,
  adaptCategories,
  adaptDashboard,
  adaptLedger,
  adaptMemberships,
  adaptNotification,
  adaptPayment,
  adaptPeriod,
  adaptProduct,
  adaptSession,
  adaptSettlement,
} from './adapters';
import type {
  AccountSummary,
  AuditEntry,
  Booking,
  BookingCommand,
  CatalogOrderCommand,
  Category,
  CategoryCreateCommand,
  CategoryUpdateCommand,
  CreatedInvitation,
  Dashboard,
  EmailDeliveryStatus,
  InvitationEmailRetryResult,
  InvitationEmailResendResult,
  InvitationCommand,
  InvitationInput,
  InvitationImportResult,
  InvitationMetadata,
  InvitationPreview,
  LedgerEntry,
  LoginCommand,
  GroupSettings,
  Membership,
  Notification,
  NotificationPage,
  NotificationReadResult,
  NotificationSummary,
  Payment,
  PaymentCommand,
  SelfPaymentCommand,
  Period,
  PermissionUpdate,
  ProblemDetails,
  Product,
  ProductCreateCommand,
  ProductUpdateCommand,
  Session,
  Settlement,
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
    return { data: normalizeApiValue(await response.json()) as T, headers: response.headers };
  } catch (error) {
    if (DEMO_ENABLED && !(error instanceof ApiError)) {
      return { data: await requestDevelopmentDemo<T>(path, init), headers: new Headers() };
    }
    throw error;
  }
}

const groupPath = (groupId: string, resource: string) => `/groups/${encodeURIComponent(groupId)}/${resource}`;
const groupRootPath = (groupId: string) => `/groups/${encodeURIComponent(groupId)}`;
const json = (value: unknown) => JSON.stringify(value);

function setSessionActor(session: Session): Session {
  idempotencyReservations.setActor(session.user.id);
  return session;
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
    expiresAt: String(source.expiresAt ?? ''),
    acceptedAt: typeof source.acceptedAt === 'string' ? source.acceptedAt : undefined,
    revokedAt: typeof source.revokedAt === 'string' ? source.revokedAt : undefined,
    emailDeliveryStatus: (source.emailDeliveryStatus as EmailDeliveryStatus | undefined) ?? 'NOT_REQUESTED',
    emailSentAt: typeof source.emailSentAt === 'string' ? source.emailSentAt : undefined,
    emailFailureCode: typeof source.emailFailureCode === 'string' && source.emailFailureCode ? source.emailFailureCode : undefined,
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
    if (error instanceof Error && error.message.startsWith('Authenticated actor')) throw new Error(i18n.t('errors.actorMissing'));
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
 * const categories = await api.getCategories(session.activeGroupId);
 * ```
 */
export const api = {
  getSession: async (): Promise<Session> => setSessionActor(adaptSession(await request<unknown>('/session'))),
  uploadProfileAvatar: async (image: File): Promise<{ avatarUrl: string }> => {
    const form = new FormData();
    form.set('image', image);
    return request<{ avatarUrl: string }>('/me/avatar', { method: 'POST', body: form });
  },
  removeProfileAvatar: async (): Promise<void> => request<void>('/me/avatar', { method: 'DELETE' }),
  login: async (command: LoginCommand): Promise<Session> => setSessionActor(adaptSession(await request<unknown>('/auth/login', { method: 'POST', body: json(command) }))),
  logout: async (): Promise<void> => {
    try {
      await request('/auth/logout', { method: 'POST' });
    } finally {
      idempotencyReservations.clearAll();
    }
  },
  previewInvitation: async (token: string): Promise<InvitationPreview> => request<InvitationPreview>('/invitations/preview', { method: 'POST', body: json({ token }) }),
  acceptInvitation: async (command: InvitationCommand): Promise<Session> => setSessionActor(adaptSession(await request<unknown>('/invitations/accept', { method: 'POST', body: json(command) }))),
  createInvitation: async (groupId: string, input: InvitationInput): Promise<CreatedInvitation> => {
  const response = await request<unknown>(groupPath(groupId, 'invitations'), { method: 'POST', body: json({ email: input.email, displayName: input.displayName, roles: input.roles.filter((role) => role !== 'MEMBER'), groupPermissions: input.groupPermissions, categoryGrants: invitationCategoryGrants(input.categoryPermissions) }) });
  const source = response as { invitation?: unknown; acceptUrl?: string };
  const invitation = adaptInvitation(source.invitation ?? response);
  return {
    ...invitation,
    email: invitation.email || input.email,
    acceptUrl: source.acceptUrl ?? '',
  };
  },
  getInvitations: async (groupId: string): Promise<InvitationMetadata[]> => (await request<unknown[]>(groupPath(groupId, 'invitations'))).map(adaptInvitation),
  updateInvitation: async (groupId: string, invitationId: string, input: Omit<InvitationInput, 'email'>): Promise<InvitationMetadata> => adaptInvitation(await request<unknown>(groupPath(groupId, `invitations/${encodeURIComponent(invitationId)}`), {
    method: 'PATCH',
    body: json({ displayName: input.displayName, roles: input.roles.filter((role) => role !== 'MEMBER'), groupPermissions: input.groupPermissions, categoryGrants: invitationCategoryGrants(input.categoryPermissions) }),
  })),
  revokeInvitation: async (groupId: string, invitationId: string): Promise<void> => request<void>(groupPath(groupId, `invitations/${encodeURIComponent(invitationId)}`), { method: 'DELETE' }),
  importInvitations: async (groupId: string, file: File): Promise<InvitationImportResult> => {
    const path = groupPath(groupId, 'invitations/import');
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
  getGroupSettings: async (groupId: string): Promise<GroupSettings> => request<GroupSettings>(groupPath(groupId, 'settings')),
  updateGroupSettings: async (groupId: string, settings: Pick<GroupSettings, 'membersCanViewAllBookings' | 'notificationEmailsEnabled'>): Promise<GroupSettings> => request<GroupSettings>(groupPath(groupId, 'settings'), { method: 'PATCH', body: json(settings) }),
  uploadGroupLogo: async (groupId: string, image: File): Promise<{ logoUrl: string }> => {
    const form = new FormData();
    form.set('image', image);
    return request<{ logoUrl: string }>(groupPath(groupId, 'logo'), { method: 'POST', body: form });
  },
  removeGroupLogo: async (groupId: string): Promise<void> => request<void>(groupPath(groupId, 'logo'), { method: 'DELETE' }),
  getDashboard: async (groupId: string): Promise<Dashboard> => adaptDashboard(await request<unknown>(groupPath(groupId, 'dashboard'))),
  getCategories: async (groupId: string): Promise<Category[]> => adaptCategories(await request<unknown>(groupPath(groupId, 'categories'))),
  getMembers: async (groupId: string): Promise<Membership[]> => adaptMemberships(await request<unknown>(groupPath(groupId, 'members'))),
  archiveMember: async (groupId: string, membershipId: string, confirmSelf: boolean): Promise<void> => request<void>(`${groupPath(groupId, `members/${encodeURIComponent(membershipId)}`)}${confirmSelf ? '?confirmSelf=true' : ''}`, { method: 'DELETE' }),
  getBookings: async (groupId: string): Promise<Booking[]> => {
    const [bookings, members] = await Promise.all([request<unknown>(groupPath(groupId, 'bookings')), request<unknown>(groupPath(groupId, 'members'))]);
    const adaptedMembers = adaptMemberships(members);
    return (bookings as unknown[]).map((booking) => adaptBooking(booking, adaptedMembers));
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
  reverseBooking: async (groupId: string, bookingId: string, reason: string): Promise<Booking> => {
    const path = groupPath(groupId, `bookings/${bookingId}/void`);
    const payload = { reason };
    return adaptBooking(await idempotentRequest<unknown>(groupId, 'booking.void', path, payload, { method: 'POST', body: json(payload) }));
  },
  getLedger: async (groupId: string): Promise<LedgerEntry[]> => adaptLedger(await request<unknown>(groupPath(groupId, 'accounts/me'))),
  getAccountSummaries: async (groupId: string): Promise<AccountSummary[]> => adaptAccountSummaries(await request<unknown>(groupPath(groupId, 'accounts'))),
  getPayments: async (groupId: string): Promise<Payment[]> => (await request<unknown[]>(groupPath(groupId, 'payments'))).map(adaptPayment),
  createPayment: async (groupId: string, command: PaymentCommand): Promise<Payment> => {
    const path = groupPath(groupId, 'payments');
    const payload = { ...command, amountMinor: minorUnitsToSafeNumber(command.amount.minorUnits), amount: undefined, receivedAt: new Date(command.receivedAt).toISOString() };
    return adaptPayment(await idempotentRequest<unknown>(groupId, 'payment.create', path, payload, { method: 'POST', body: json(payload) }));
  },
  createOwnPayment: async (groupId: string, command: SelfPaymentCommand): Promise<Payment> => {
    const path = groupPath(groupId, 'payments/self');
    const payload = { ...command, amountMinor: minorUnitsToSafeNumber(command.amount.minorUnits), amount: undefined, receivedAt: new Date(command.receivedAt).toISOString() };
    return adaptPayment(await idempotentRequest<unknown>(groupId, 'payment.self.create', path, payload, { method: 'POST', body: json(payload) }));
  },
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
  getNotificationSummary: (groupId: string): Promise<NotificationSummary> => request<NotificationSummary>(groupPath(groupId, 'notifications/summary')),
  markNotificationsRead: (groupId: string, notificationIds: string[]): Promise<NotificationReadResult> => request<NotificationReadResult>(groupPath(groupId, 'notifications/read'), { method: 'PATCH', body: json({ notificationIds }) }),
  markNotificationRead: async (groupId: string, notificationId: string): Promise<Notification> => adaptNotification(await request<unknown>(groupPath(groupId, `notifications/${notificationId}`), { method: 'PATCH', body: json({ read: true }) })),
  getAudit: async (groupId: string): Promise<AuditEntry[]> => {
    const [entries, members] = await Promise.all([request<unknown[]>(groupPath(groupId, 'audit')), request<unknown>(groupPath(groupId, 'members'))]);
    const adaptedMembers = adaptMemberships(members);
    return entries.map((entry) => adaptAuditEntry(entry, adaptedMembers));
  },
  updatePermissions: async (groupId: string, membershipId: string, update: PermissionUpdate, etag?: string): Promise<void> => {
    const categoryGrants = Object.fromEntries(update.categoryPermissions.map((permission) => [permission.categoryId, [permission.assignToOthers ? 'ASSIGN_TO_OTHERS' : null, permission.voidBookings ? 'VOID_BOOKINGS' : null].filter(Boolean)]));
    await request<void>(groupPath(groupId, `members/${membershipId}/permissions`), { method: 'PATCH', headers: etag ? { 'If-Match': etag } : undefined, body: json({ roles: update.roles.filter((role) => role !== 'MEMBER'), groupPermissions: update.groupPermissions, categoryGrants }) });
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
