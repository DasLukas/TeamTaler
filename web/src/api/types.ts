/** A monetary amount represented in minor units to avoid floating-point errors. */
export interface Money {
  minorUnits: string;
  currency: string;
}

/** Roles that can be assigned to a group membership. */
export type GroupRole = 'ADMIN' | 'FINANCE_MANAGER' | 'CATALOG_MANAGER' | 'MEMBER';

/** Rights that can be granted for one category. */
export type CategoryPermissionName = 'ASSIGN_TO_OTHERS' | 'VOID_BOOKINGS';

/** Supported product category behaviors. */
export type CategoryType = 'STANDARD' | 'PENALTY';

/** Lifecycle state of an accounting period. */
export type PeriodStatus = 'OPEN' | 'CLOSED';

/** Settlement payment status. */
export type SettlementStatus = 'OPEN' | 'PARTIAL' | 'PAID' | 'CREDIT';

/** A signed-in user account. */
export interface User {
  id: string;
  displayName: string;
  email: string;
  avatarUrl?: string;
}

/** A group available to the signed-in user. */
export interface Group {
  id: string;
  name: string;
  currency: string;
  logoUrl?: string;
  membership?: {
    id: string;
    roles: GroupRole[];
  };
}

/** Authentication and active-group state returned by the API. */
export interface Session {
  user: User;
  groups: Group[];
  activeGroupId: string;
  demo?: boolean;
}

/** A product that can be booked against a member account. */
export interface Product {
  id: string;
  categoryId: string;
  version: number;
  name: string;
  price: Money;
  imageUrl?: string;
  active: boolean;
  sortOrder: number;
}

/** A category and its currently available products. */
export interface Category {
  id: string;
  name: string;
  type: CategoryType;
  icon: 'drink' | 'penalty' | 'other';
  active: boolean;
  products: Product[];
}

/** Per-category permissions assigned to a member. */
export interface CategoryPermission {
  categoryId: string;
  assignToOthers: boolean;
  voidBookings: boolean;
}

/** A member and all effective group permissions. */
export interface Membership {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  initials: string;
  avatarUrl?: string;
  roles: GroupRole[];
  categoryPermissions: CategoryPermission[];
  active: boolean;
  etag?: string;
}

/** A booking displayed in activity feeds and account statements. */
export interface Booking {
  id: string;
  memberId: string;
  memberName: string;
  productId: string;
  productName: string;
  categoryId: string;
  categoryName: string;
  quantity: number;
  unitPrice: Money;
  total: Money;
  bookedAt: string;
  bookedByName: string;
  bookedByMemberId?: string;
  reason?: string;
  status: 'POSTED' | 'REVERSED';
  undoUntil?: string;
  canVoid?: boolean;
}

/** Aggregated category amount shown on the dashboard. */
export interface CategoryTotal {
  categoryId: string;
  categoryName: string;
  icon: Category['icon'];
  total: Money;
  quantity?: number;
}

/** Dashboard data for the active group and member. */
export interface Dashboard {
  openBalance: Money;
  currentPeriod: Period;
  categoryTotals: CategoryTotal[];
  groupCategoryTotals: CategoryTotal[];
  recentBookings: Booking[];
}

/** Command used to create an immutable booking. */
export interface BookingCommand {
  productId: string;
  productVersion: number;
  expectedPeriodId: string;
  quantity: number;
  targetMembershipId?: string;
  reason?: string;
}

/** One immutable row in a member account statement. */
export interface LedgerEntry {
  id: string;
  occurredAt: string;
  kind: 'BOOKING' | 'PAYMENT' | 'REVERSAL' | 'CREDIT';
  description: string;
  amount: Money;
  balance: Money;
  referenceId: string;
}

/** A payment received for a member account. */
export interface Payment {
  id: string;
  membershipId: string;
  memberName: string;
  amount: Money;
  receivedAt: string;
  method: 'CASH' | 'BANK_TRANSFER' | 'OTHER';
  reference?: string;
  note?: string;
  status: 'POSTED' | 'REVERSED';
}

/** Command used by finance managers to record an incoming payment. */
export interface PaymentCommand {
  membershipId: string;
  amount: Money;
  receivedAt: string;
  method: Payment['method'];
  reference?: string;
  note?: string;
}

/** An accounting period that groups bookings and payments. */
export interface Period {
  id: string;
  label: string;
  status: PeriodStatus;
  startsAt: string;
  closedAt?: string;
  dueAt?: string;
}

/** A fixed member balance created when a period closes. */
export interface Settlement {
  id: string;
  periodId: string;
  periodLabel: string;
  membershipId: string;
  memberName: string;
  amount: Money;
  paidAmount: Money;
  openAmount?: Money;
  dueAt: string;
  status: SettlementStatus;
}

/** An in-app notification addressed to the signed-in user. */
export interface Notification {
  id: string;
  title: string;
  message: string;
  createdAt: string;
  readAt?: string;
  kind: 'BOOKING' | 'PAYMENT' | 'SETTLEMENT' | 'SYSTEM';
}

/** A security-relevant, append-only audit record. */
export interface AuditEntry {
  id: string;
  occurredAt: string;
  actorName: string;
  action: string;
  subject: string;
  details: string;
}

/** Permission update payload for one membership. */
export interface PermissionUpdate {
  roles: GroupRole[];
  categoryPermissions: CategoryPermission[];
}

/** Login credentials accepted by the local identity provider. */
export interface LoginCommand {
  email: string;
  password: string;
}

/** Invitation acceptance fields submitted by a new member. */
export interface InvitationCommand {
  token: string;
  displayName: string;
  password: string;
}

/** A newly created one-time group invitation. */
export interface Invitation {
  id: string;
  email?: string;
  expiresAt: string;
  acceptUrl: string;
}

/** RFC 9457 problem details returned by failed API requests. */
export interface ProblemDetails {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: Record<string, string[]>;
}
