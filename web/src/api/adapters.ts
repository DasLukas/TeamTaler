import type {
  AccountSummary,
  AuditEntry,
  Booking,
  BookingContext,
  BookingTarget,
  Category,
  Dashboard,
  Group,
  GroupSettings,
  GroupRole,
  LedgerEntry,
  Membership,
  Notification,
  PermissionDefinition,
  PermissionGrant,
  Payment,
  Period,
  Product,
  Role,
  RoleAssignment,
  Session,
  Settlement,
} from './types';
import { isCategoryIcon, isPermissionKey } from './types';
import { formatMoney } from './money';
import i18n from '@/i18n';

type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord => value as JsonRecord;
const money = (minorUnits: unknown, currency: unknown) => ({ minorUnits: String(minorUnits ?? 0), currency: String(currency || 'EUR') });
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
const categoryIcon = (value: unknown): Category['icon'] => isCategoryIcon(value) ? value : 'other';
const memberName = (membershipId: string, members?: Membership[], fallback = i18n.t('common.member')) => members?.find((member) => member.id === membershipId)?.displayName ?? fallback;
const memberAvatarUrl = (membershipId: string, members?: Membership[]) => members?.find((member) => member.id === membershipId)?.avatarUrl;
const PAYMENT_DESCRIPTION_PREFIX = 'Payment received';
const REVERSAL_DESCRIPTION_PREFIX = 'Reversal: ';
const NOTIFICATION_EVENT_TYPES: Notification['eventType'][] = ['BOOKING_ASSIGNED', 'BOOKING_REVERSED', 'PAYMENT_RECORDED', 'PAYMENT_REVERSED', 'SETTLEMENT_CREATED'];

/**
 * Adapts administrator-managed group settings and applies safe feature defaults.
 *
 * @param input - Group-settings response from the API.
 * @returns Complete canonical settings.
 */
export function adaptGroupSettings(input: unknown): GroupSettings {
  const source = asRecord(input);
  return {
    notificationEmailsEnabled: source.notificationEmailsEnabled === true,
    notificationEmailDeliveryAvailable: source.notificationEmailDeliveryAvailable === true,
    defaultRoleId: typeof source.defaultRoleId === 'string' && source.defaultRoleId ? source.defaultRoleId : null,
  };
}

/**
 * Adapts allow grants and drops unsupported scopes or permission keys.
 *
 * @param input - Grant array returned by session, role, or membership endpoints.
 * @returns Unique, group-scoped permission grants.
 */
export function adaptPermissionGrants(input: unknown): PermissionGrant[] {
  if (!Array.isArray(input)) return [];
  const permissions = new Set<PermissionGrant['permission']>();
  for (const entry of input) {
    if (typeof entry !== 'string' && (!entry || typeof entry !== 'object')) continue;
    const source = typeof entry === 'string' ? { permission: entry } : asRecord(entry);
    const permission = source.permission ?? source.permissionKey ?? source.key;
    const scope = source.scope && typeof source.scope === 'object' ? asRecord(source.scope) : undefined;
    const scopeType = scope?.type ?? source.scopeType ?? 'GROUP';
    if (scopeType === 'GROUP'
      && source.categoryId === undefined
      && source.productId === undefined
      && scope?.categoryId === undefined
      && scope?.productId === undefined
      && isPermissionKey(permission)) permissions.add(permission);
  }
  return [...permissions].map((permission) => ({ permission, scope: { type: 'GROUP' } }));
}

/**
 * Adapts one server-owned permission definition.
 *
 * @param input - Permission registry entry from the API.
 * @returns Canonical metadata for the role editor.
 * @throws TypeError when the entry contains an unknown permission key.
 */
export function adaptPermissionDefinition(input: unknown): PermissionDefinition {
  const source = asRecord(input);
  const key = source.key ?? source.permission;
  if (!isPermissionKey(key)) throw new TypeError(`Unsupported permission definition: ${String(key)}`);
  const implied = source.impliedPermissions ?? source.implies;
  const allowedScopes = Array.isArray(source.allowedScopes)
    ? source.allowedScopes.filter((scope): scope is 'GROUP' | 'CATEGORY' | 'PRODUCT' => scope === 'GROUP' || scope === 'CATEGORY' || scope === 'PRODUCT')
    : undefined;
  return {
    key,
    name: typeof source.name === 'string' && source.name ? source.name : undefined,
    description: typeof source.description === 'string' && source.description ? source.description : undefined,
    impliedPermissions: Array.isArray(implied) ? implied.filter(isPermissionKey) : [],
    allowedScopes,
  };
}

/**
 * Adapts one group-owned role and its assignment counters.
 *
 * @param input - Role response from the API.
 * @returns Canonical role used by role management.
 */
export function adaptRole(input: unknown): Role {
  const source = asRecord(input);
  return {
    id: String(source.id ?? ''),
    groupId: typeof source.groupId === 'string' ? source.groupId : undefined,
    presetKey: typeof source.presetKey === 'string' ? source.presetKey as Role['presetKey'] : undefined,
    name: typeof source.name === 'string' ? source.name : '',
    description: typeof source.description === 'string' && source.description ? source.description : undefined,
    nameLocked: typeof source.nameLocked === 'boolean' ? source.nameLocked : undefined,
    deletable: typeof source.deletable === 'boolean' ? source.deletable : undefined,
    grants: adaptPermissionGrants(source.grants),
    version: Number(source.version ?? 1),
    memberCount: Number(source.memberCount ?? 0),
    pendingInvitationCount: Number(source.pendingInvitationCount ?? 0),
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : undefined,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : undefined,
  };
}

/**
 * Adapts one role assignment for a member or pending invitation.
 *
 * @param input - Assignment response from the API.
 * @returns Canonical role assignment with optimistic-concurrency metadata.
 */
export function adaptRoleAssignment(input: unknown): RoleAssignment {
  const source = asRecord(input);
  return {
    subjectType: source.subjectType === 'INVITATION' ? 'INVITATION' : 'MEMBERSHIP',
    subjectId: String(source.subjectId ?? source.membershipId ?? source.invitationId ?? ''),
    roleIds: Array.isArray(source.roleIds) ? source.roleIds.map(String) : [],
    version: Number(source.version ?? 1),
    etag: typeof source.etag === 'string' ? source.etag : undefined,
  };
}

/**
 * Extracts the user-provided reference from a structured payment description.
 *
 * @param description - Backend ledger description for a payment or its reversal.
 * @returns The preserved payment reference, or `undefined` when none is present.
 */
function paymentReference(description: string): string | undefined {
  const original = description.startsWith(REVERSAL_DESCRIPTION_PREFIX)
    ? description.slice(REVERSAL_DESCRIPTION_PREFIX.length)
    : description;
  const referencePrefix = `${PAYMENT_DESCRIPTION_PREFIX}: `;
  return original.startsWith(referencePrefix) ? original.slice(referencePrefix.length).trim() || undefined : undefined;
}

/**
 * Produces localized copy for a structured backend ledger movement.
 *
 * Product, category, and payment-reference values remain untouched because they
 * are group-authored business data; backend-owned English labels are replaced.
 *
 * @param wire - Untrusted ledger wire entry.
 * @returns A localized description suitable for the account table and CSV export.
 */
function ledgerDescription(wire: JsonRecord): string {
  const description = String(wire.description ?? '');
  const reversed = Boolean(wire.reversalOf);
  if (wire.paymentId) {
    const reference = paymentReference(description);
    if (reversed) {
      return reference
        ? i18n.t('ledger.paymentReversedWithReference', { reference })
        : i18n.t('ledger.paymentReversed');
    }
    return reference
      ? i18n.t('ledger.paymentReceivedWithReference', { reference })
      : i18n.t('ledger.paymentReceived');
  }
  if (wire.bookingId) {
    const original = description.startsWith(REVERSAL_DESCRIPTION_PREFIX)
      ? description.slice(REVERSAL_DESCRIPTION_PREFIX.length)
      : description;
    const localized = original.replace(/^(\d+)\s+x\s+/, '$1 × ');
    return reversed ? i18n.t('ledger.bookingReversed', { description: localized }) : localized;
  }
  return reversed ? i18n.t('ledger.reversal') : i18n.t('ledger.adjustment');
}

/**
 * Adapts the session wire model to the stable frontend session.
 *
 * @param input - Untrusted session response from `/api/v1/session` or authentication.
 * @returns A session with a deterministic active group identifier.
 */
export function adaptSession(input: unknown): Session {
  const source = asRecord(input);
  const user = asRecord(source.user);
  const groups = (source.groups as unknown[] ?? []).map((entry) => {
    const group = asRecord(entry);
    const membership = group.membership && typeof group.membership === 'object' ? asRecord(group.membership) : undefined;
    return {
      id: String(group.id),
      name: String(group.name),
      currency: String(group.currency || 'EUR'),
      logoUrl: typeof group.logoUrl === 'string' ? group.logoUrl : undefined,
      membership: membership ? {
        id: String(membership.id),
        roles: [...(membership.roles as GroupRole[] ?? []), 'MEMBER'],
        groupPermissions: (membership.groupPermissions as Membership['groupPermissions'] | undefined) ?? [],
        roleIds: Array.isArray(membership.roleIds) ? membership.roleIds.map(String) : [],
        effectiveGrants: adaptPermissionGrants(membership.effectiveGrants),
        roleAssignmentsVersion: Number(membership.roleAssignmentsVersion ?? 1),
      } : undefined,
    } satisfies Group;
  });
  return {
    user: {
      id: String(user.id),
      displayName: String(user.displayName),
      email: String(user.email),
      avatarUrl: typeof user.avatarUrl === 'string' && user.avatarUrl ? user.avatarUrl : undefined,
    },
    groups,
    activeGroupId: typeof source.activeGroupId === 'string' ? source.activeGroupId : groups[0]?.id ?? '',
    demo: source.demo === true,
  };
}

/**
 * Adapts one catalogue product and its integer minor-unit price.
 *
 * @param input - Product wire or canonical product value.
 * @returns Canonical frontend product.
 */
export function adaptProduct(input: unknown): Product {
  const source = asRecord(input);
  const sourcePrice = source.price && typeof source.price === 'object' ? asRecord(source.price) : undefined;
  const currency = String(source.currency || sourcePrice?.currency || 'EUR');
  const pricingMode = source.pricingMode === 'USER_DEFINED' ? 'USER_DEFINED' : 'FIXED';
  return {
    id: String(source.id),
    categoryId: String(source.categoryId),
    version: Number(source.version ?? 1),
    name: String(source.name),
    pricingMode,
    currency,
    price: pricingMode === 'FIXED' ? sourcePrice ? money(sourcePrice.minorUnits, sourcePrice.currency || currency) : money(source.priceMinor, currency) : undefined,
    imageUrl: typeof source.imageUrl === 'string' && source.imageUrl ? source.imageUrl : undefined,
    active: source.active !== false,
    sortOrder: Number(source.sortOrder ?? 0),
  };
}

/**
 * Adapts catalogue categories and nested products.
 *
 * @param input - Category array returned by the group catalogue endpoint.
 * @returns Canonical categories sorted by the backend.
 */
export function adaptCategories(input: unknown): Category[] {
  return (input as unknown[] ?? []).map((entry) => {
    const source = asRecord(entry);
    const name = String(source.name);
    return {
      id: String(source.id),
      version: Number(source.version ?? 1),
      name,
      icon: categoryIcon(source.icon),
      active: source.active !== false,
      sortOrder: Number(source.sortOrder ?? 0),
      products: (source.products as unknown[] ?? []).map(adaptProduct),
    };
  });
}

/**
 * Adapts member roles and the backend's category-grant map.
 *
 * @param input - Membership wire or canonical membership value.
 * @param etag - Optional strong collection ETag used for optimistic updates.
 * @returns Canonical membership with boolean category permissions.
 */
export function adaptMembership(input: unknown, etag?: string): Membership {
  const source = asRecord(input);
  if ('categoryPermissions' in source) return {
    ...(source as unknown as Membership),
    userId: String(source.userId ?? ''),
    email: typeof source.email === 'string' && source.email ? source.email : null,
    isTemporaryGuest: source.isTemporaryGuest === true,
    groupPermissions: (source.groupPermissions as Membership['groupPermissions'] | undefined) ?? [],
    roleIds: Array.isArray(source.roleIds) ? source.roleIds.map(String) : [],
    effectiveGrants: adaptPermissionGrants(source.effectiveGrants),
    roleAssignmentsVersion: Number(source.roleAssignmentsVersion ?? 1),
    etag: etag ?? source.etag as string | undefined,
  };
  const grants = (source.categoryGrants ?? {}) as Record<string, string[]>;
  const roles = (source.roles as GroupRole[] ?? []).filter((role) => role !== 'MEMBER');
  return {
    id: String(source.id),
    userId: String(source.userId ?? ''),
    displayName: String(source.displayName),
    email: typeof source.email === 'string' && source.email ? source.email : null,
    initials: initials(String(source.displayName)),
    avatarUrl: typeof source.avatarUrl === 'string' && source.avatarUrl ? source.avatarUrl : undefined,
    isTemporaryGuest: source.isTemporaryGuest === true,
    roles: [...roles, 'MEMBER'],
    groupPermissions: (source.groupPermissions as Membership['groupPermissions'] | undefined) ?? [],
    categoryPermissions: Object.entries(grants).map(([categoryId, permissions]) => ({
      categoryId,
      assignToOthers: permissions.includes('ASSIGN_TO_OTHERS'),
      voidBookings: permissions.includes('VOID_BOOKINGS'),
    })),
    roleIds: Array.isArray(source.roleIds) ? source.roleIds.map(String) : [],
    effectiveGrants: adaptPermissionGrants(source.effectiveGrants),
    roleAssignmentsVersion: Number(source.roleAssignmentsVersion ?? 1),
    active: source.status ? source.status === 'ACTIVE' : source.active !== false,
    etag,
  };
}

/**
 * Adapts a member collection.
 *
 * @param input - Membership array from the API.
 * @param etag - Shared strong ETag from the collection response.
 * @returns Canonical memberships.
 */
export function adaptMemberships(input: unknown, etag?: string): Membership[] {
  return (input as unknown[] ?? []).map((entry) => adaptMembership(entry, etag));
}

/**
 * Adapts one privacy-reduced booking target.
 *
 * @param input - Target returned by the booking-context endpoint.
 * @returns Stable booking-target identity without member-directory details.
 */
export function adaptBookingTarget(input: unknown): BookingTarget {
  const source = asRecord(input);
  return {
    membershipId: String(source.membershipId ?? source.id ?? ''),
    displayName: String(source.displayName ?? ''),
    avatarUrl: typeof source.avatarUrl === 'string' && source.avatarUrl ? source.avatarUrl : undefined,
    isTemporaryGuest: source.isTemporaryGuest === true,
  };
}

/**
 * Adapts the permission-filtered data required to create product bookings.
 *
 * @param input - Booking-context response from the active group.
 * @param currency - Active group currency used for its minor-unit balance.
 * @returns Canonical booking context with normalized period, balance, and targets.
 */
export function adaptBookingContext(input: unknown, currency: string): BookingContext {
  const source = asRecord(input);
  return {
    openPeriod: adaptPeriod(source.openPeriod),
    ownBalance: money(source.ownBalanceMinor, currency),
    currentMembership: adaptMembership(source.currentMembership),
    targets: (source.targets as unknown[] ?? []).map(adaptBookingTarget),
    canBookForGuests: source.canBookForGuests === true,
  };
}

/**
 * Adapts an immutable booking snapshot.
 *
 * @param input - Booking wire or canonical value.
 * @param members - Optional member directory used to resolve display names.
 * @param fallbackMemberName - Name used when the target is the current account.
 * @returns Canonical booking.
 */
export function adaptBooking(input: unknown, members?: Membership[], fallbackMemberName = i18n.t('common.member')): Booking {
  const source = asRecord(input);
  if ('bookedAt' in source) {
    const booking = source as unknown as Booking;
    const target = members?.find((member) => member.id === booking.memberId);
    const actor = members?.find((member) => booking.bookedByMemberId
      ? member.id === booking.bookedByMemberId
      : member.displayName === booking.bookedByName);
    return {
      ...booking,
      memberName: target?.displayName ?? booking.memberName,
      memberAvatarUrl: target?.avatarUrl ?? booking.memberAvatarUrl,
      bookedByName: actor?.displayName ?? booking.bookedByName,
      bookedByAvatarUrl: actor?.avatarUrl ?? booking.bookedByAvatarUrl,
    };
  }
  const targetId = String(source.targetMembershipId ?? '');
  const actorId = String(source.actorMembershipId ?? '');
  const createdAt = String(source.createdAt);
  return {
    id: String(source.id),
    memberId: targetId,
    memberName: typeof source.targetDisplayName === 'string' && source.targetDisplayName
      ? source.targetDisplayName
      : memberName(targetId, members, fallbackMemberName),
    memberAvatarUrl: memberAvatarUrl(targetId, members),
    productId: String(source.productId),
    productName: String(source.productName),
    categoryId: String(source.categoryId),
    categoryName: String(source.categoryName),
    quantity: Number(source.quantity ?? 1),
    unitPrice: money(source.unitPriceMinor, source.currency),
    total: money(source.totalMinor, source.currency),
    bookedAt: createdAt,
    bookedByName: typeof source.actorDisplayName === 'string' && source.actorDisplayName
      ? source.actorDisplayName
      : memberName(actorId, members, actorId === targetId ? fallbackMemberName : i18n.t('common.member')),
    bookedByMemberId: actorId || undefined,
    bookedByAvatarUrl: memberAvatarUrl(actorId, members),
    reason: typeof source.reason === 'string' && source.reason ? source.reason : undefined,
    status: source.voidedAt ? 'REVERSED' : 'POSTED',
    undoUntil: typeof source.voidWithoutReasonUntil === 'string' ? source.voidWithoutReasonUntil : typeof source.undoUntil === 'string' ? source.undoUntil : undefined,
    canVoid: source.canVoid === true,
    voidReasonRequired: source.voidReasonRequired === true,
    voidWithoutReasonUntil: typeof source.voidWithoutReasonUntil === 'string' ? source.voidWithoutReasonUntil : undefined,
  };
}

/**
 * Adapts the grouped dashboard read model.
 *
 * @param input - Dashboard response containing account, period, and recent bookings.
 * @returns Canonical dashboard consumed by dashboard and booking views.
 */
export function adaptDashboard(input: unknown): Dashboard {
  const source = asRecord(input);
  if ('openBalance' in source) return source as unknown as Dashboard;
  const account = asRecord(source.account);
  const currentPeriod = adaptPeriod(source.openPeriod);
  return {
    openBalance: money(account.balanceMinor, account.currency),
    currentPeriod,
    categoryTotals: (account.categoryStatistics as unknown[] ?? []).map((entry) => {
      const statistic = asRecord(entry);
      const name = String(statistic.categoryName);
      return { categoryId: String(statistic.categoryId), categoryName: name, icon: categoryIcon(statistic.icon), total: money(statistic.netMinor, account.currency) };
    }),
    groupCategoryTotals: (account.groupCategoryStatistics as unknown[] ?? []).map((entry) => {
      const statistic = asRecord(entry);
      const name = String(statistic.categoryName);
      return { categoryId: String(statistic.categoryId), categoryName: name, icon: categoryIcon(statistic.icon), quantity: Number(statistic.quantity ?? 0), total: money(statistic.netMinor, account.currency) };
    }),
    recentBookings: (source.recentBookings as unknown[] ?? []).map((entry) => adaptBooking(entry)),
  };
}

/**
 * Adapts one accounting period.
 *
 * @param input - Period wire or canonical value.
 * @returns Canonical period with nullable timestamps normalized to undefined.
 */
export function adaptPeriod(input: unknown): Period {
  const source = asRecord(input);
  return {
    id: String(source.id),
    label: String(source.label),
    status: source.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
    startsAt: String(source.startsAt),
    closedAt: typeof source.closedAt === 'string' ? source.closedAt : undefined,
    dueAt: typeof source.dueAt === 'string' ? source.dueAt : undefined,
  };
}

/**
 * Adapts an account read model into a running ledger statement.
 *
 * @param input - Account response or existing canonical ledger array.
 * @returns Newest-first ledger entries with reconstructed running balances.
 */
export function adaptLedger(input: unknown): LedgerEntry[] {
  if (Array.isArray(input)) return input as LedgerEntry[];
  const source = asRecord(input);
  let runningBalance = BigInt(String(source.balanceMinor ?? 0));
  const currency = String(source.currency || 'EUR');
  return (source.recentEntries as unknown[] ?? []).map((entry) => {
    const wire = asRecord(entry);
    const amountMinor = BigInt(String(wire.amountMinor ?? 0));
    const balance = runningBalance;
    runningBalance -= amountMinor;
    return {
      id: String(wire.id),
      occurredAt: String(wire.createdAt),
      kind: wire.reversalOf ? 'REVERSAL' : wire.paymentId ? 'PAYMENT' : wire.bookingId ? 'BOOKING' : 'CREDIT',
      description: ledgerDescription(wire),
      amount: money(amountMinor.toString(), currency),
      balance: money(balance.toString(), currency),
      referenceId: String(wire.bookingId ?? wire.paymentId ?? wire.id),
    };
  });
}

/**
 * Adapts consolidated group account balances without numeric precision loss.
 *
 * @param input - Account-summary array returned by the finance endpoint.
 * @returns Canonical account summaries with exact money values.
 */
export function adaptAccountSummaries(input: unknown): AccountSummary[] {
  return (input as unknown[] ?? []).map((entry) => {
    const source = asRecord(entry);
    const sourceBalance = source.balance && typeof source.balance === 'object' ? asRecord(source.balance) : undefined;
    const currency = String(source.currency || sourceBalance?.currency || 'EUR');
    return {
      membershipId: String(source.membershipId),
      displayName: String(source.displayName),
      avatarUrl: typeof source.avatarUrl === 'string' && source.avatarUrl ? source.avatarUrl : undefined,
      isTemporaryGuest: source.isTemporaryGuest === true,
      status: source.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
      currency,
      balance: sourceBalance ? money(sourceBalance.minorUnits, sourceBalance.currency || currency) : money(source.balanceMinor, currency),
    };
  });
}

/**
 * Adapts a payment with member display data.
 *
 * @param input - Payment wire or canonical value.
 * @returns Canonical payment.
 */
export function adaptPayment(input: unknown): Payment {
  const source = asRecord(input);
  if ('amount' in source) return source as unknown as Payment;
  return {
    id: String(source.id),
    membershipId: String(source.membershipId),
    memberName: String(source.memberName ?? i18n.t('common.member')),
    amount: money(source.amountMinor, source.currency),
    receivedAt: String(source.receivedAt),
    method: source.method as Payment['method'],
    reference: typeof source.reference === 'string' && source.reference ? source.reference : undefined,
    note: typeof source.note === 'string' && source.note ? source.note : undefined,
    status: source.status === 'REVERSED' || source.reversedAt ? 'REVERSED' : 'POSTED',
  };
}

/**
 * Adapts an immutable statement into the settlement UI model.
 *
 * @param input - Statement wire or canonical settlement value.
 * @param periods - Periods used to resolve labels and due dates.
 * @returns Canonical settlement.
 */
export function adaptSettlement(input: unknown, periods: Period[]): Settlement {
  const source = asRecord(input);
  if ('periodLabel' in source) return {
    ...source as unknown as Settlement,
    email: typeof source.email === 'string' ? source.email : null,
  };
  const period = periods.find((entry) => entry.id === source.periodId);
  const obligationMinor = (BigInt(String(source.chargesMinor ?? 0)) + BigInt(String(source.adjustmentsProvidedMinor ?? 0))).toString();
  const settledMinor = (BigInt(String(source.paymentsAllocatedMinor ?? 0)) + BigInt(String(source.adjustmentsAppliedMinor ?? 0))).toString();
  return {
    id: String(source.id),
    periodId: String(source.periodId),
    periodLabel: period?.label ?? i18n.t('common.settlementFallback'),
    membershipId: String(source.membershipId),
    memberName: String(source.displayName ?? i18n.t('common.member')),
    email: typeof source.email === 'string' ? source.email : null,
    amount: money(obligationMinor, source.currency),
    paidAmount: money(settledMinor, source.currency),
    openAmount: money(source.amountDueMinor, source.currency),
    dueAt: period?.dueAt ?? '',
    status: source.status as Settlement['status'],
  };
}

/**
 * Adapts an in-app notification.
 *
 * @param input - Notification wire or canonical value.
 * @returns Canonical notification.
 */
export function adaptNotification(input: unknown): Notification {
  const source = asRecord(input);
  const type = String(source.type ?? '').toUpperCase();
  const canonicalKind = typeof source.kind === 'string' ? source.kind : undefined;
  const kind: Notification['kind'] = type.includes('PAYMENT') ? 'PAYMENT' : type.includes('SETTLEMENT') || type.includes('PERIOD') ? 'SETTLEMENT' : type.includes('BOOK') || type.includes('PENAL') ? 'BOOKING' : 'SYSTEM';
  const eventType: Notification['eventType'] = NOTIFICATION_EVENT_TYPES.includes(type as Notification['eventType']) ? type as Notification['eventType'] : 'SYSTEM';
  const rawContext = source.context && typeof source.context === 'object' ? asRecord(source.context) : {};
  const context: Notification['context'] = {
    actorName: typeof rawContext.actorName === 'string' ? rawContext.actorName : undefined,
    itemName: typeof rawContext.itemName === 'string' ? rawContext.itemName : undefined,
    quantity: typeof rawContext.quantity === 'number' ? rawContext.quantity : undefined,
    amountMinor: typeof rawContext.amountMinor === 'string' || typeof rawContext.amountMinor === 'number' ? String(rawContext.amountMinor) : undefined,
    currency: typeof rawContext.currency === 'string' ? rawContext.currency : undefined,
    periodLabel: typeof rawContext.periodLabel === 'string' ? rawContext.periodLabel : undefined,
    dueAt: typeof rawContext.dueAt === 'string' ? rawContext.dueAt : undefined,
  };
  const localizedCopy: Record<Notification['kind'], { title: string; message: string }> = {
    PAYMENT: { title: i18n.t('notifications.fallback.paymentTitle'), message: i18n.t('notifications.fallback.paymentMessage') },
    SETTLEMENT: { title: i18n.t('notifications.fallback.settlementTitle'), message: i18n.t('notifications.fallback.settlementMessage') },
    BOOKING: { title: i18n.t('notifications.fallback.bookingTitle'), message: i18n.t('notifications.fallback.bookingMessage') },
    SYSTEM: { title: i18n.t('notifications.fallback.systemTitle'), message: i18n.t('notifications.fallback.systemMessage') },
  };
  const amount = context.amountMinor !== undefined && context.currency ? formatMoney({ minorUnits: context.amountMinor, currency: context.currency }) : undefined;
  let copy = localizedCopy[kind];
  if (eventType === 'BOOKING_ASSIGNED' && context.actorName && context.itemName && context.quantity && amount) {
    copy = { title: i18n.t('notifications.events.bookingAssignedTitle'), message: i18n.t('notifications.events.bookingAssignedMessage', { actor: context.actorName, quantity: context.quantity, item: context.itemName, amount }) };
  } else if (eventType === 'BOOKING_REVERSED' && context.actorName && context.itemName && context.quantity && amount) {
    copy = { title: i18n.t('notifications.events.bookingReversedTitle'), message: i18n.t('notifications.events.bookingReversedMessage', { actor: context.actorName, quantity: context.quantity, item: context.itemName, amount }) };
  } else if (eventType === 'PAYMENT_RECORDED' && context.actorName && amount) {
    copy = { title: i18n.t('notifications.events.paymentRecordedTitle'), message: i18n.t('notifications.events.paymentRecordedMessage', { actor: context.actorName, amount }) };
  } else if (eventType === 'PAYMENT_REVERSED' && context.actorName && amount) {
    copy = { title: i18n.t('notifications.events.paymentReversedTitle'), message: i18n.t('notifications.events.paymentReversedMessage', { actor: context.actorName, amount }) };
  } else if (eventType === 'SETTLEMENT_CREATED' && context.periodLabel && context.amountMinor !== undefined && context.currency) {
    const rawAmount = BigInt(context.amountMinor);
    const settlementAmount = formatMoney({ minorUnits: (rawAmount < 0n ? -rawAmount : rawAmount).toString(), currency: context.currency });
    const message = rawAmount > 0n
      ? i18n.t('notifications.events.settlementDueMessage', { period: context.periodLabel, amount: settlementAmount, dueAt: context.dueAt ?? '–' })
      : rawAmount < 0n
        ? i18n.t('notifications.events.settlementCreditMessage', { period: context.periodLabel, amount: settlementAmount })
        : i18n.t('notifications.events.settlementPaidMessage', { period: context.periodLabel });
    copy = { title: i18n.t('notifications.events.settlementTitle'), message };
  } else if ('message' in source && typeof source.title === 'string' && typeof source.message === 'string') {
    copy = { title: source.title, message: source.message };
  }
  return { id: String(source.id), ...copy, createdAt: String(source.createdAt), readAt: typeof source.readAt === 'string' ? source.readAt : undefined, kind: (canonicalKind as Notification['kind'] | undefined) ?? kind, eventType, context };
}

/**
 * Adapts an append-only audit event and resolves its actor when possible.
 *
 * @param input - Audit wire or canonical value.
 * @param members - Group directory used for actor names.
 * @returns Canonical audit entry.
 */
export function adaptAuditEntry(input: unknown, members: Membership[]): AuditEntry {
  const source = asRecord(input);
  if ('actorName' in source) return source as unknown as AuditEntry;
  const metadata = source.metadata && typeof source.metadata === 'object' ? JSON.stringify(source.metadata) : '';
  return {
    id: String(source.id),
    occurredAt: String(source.occurredAt),
    actorName: memberName(String(source.actorMembershipId ?? ''), members, i18n.t('common.system')),
    action: String(source.action),
    subject: `${String(source.resourceType ?? '')}${source.resourceId ? ` · ${String(source.resourceId)}` : ''}`,
    details: metadata,
  };
}
