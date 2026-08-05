/** A monetary amount represented in minor units to avoid floating-point errors. */
export interface Money {
  minorUnits: string;
  currency: string;
}

/** Determines whether a product price is fixed by the catalog or chosen per booking. */
export type ProductPricingMode = 'FIXED' | 'USER_DEFINED';

/** Roles that can be assigned to a group membership. */
export type GroupRole = 'ADMIN' | 'FINANCE_MANAGER' | 'CATALOG_MANAGER' | 'MEMBER';

/** Rights that can be granted for one category. */
export type CategoryPermissionName = 'ASSIGN_TO_OTHERS' | 'VOID_BOOKINGS';

/** Closed set of visual markers supported for product categories. */
export const CATEGORY_ICON_VALUES = ['other', 'drink', 'food', 'penalty', 'sport', 'event', 'transport', 'money'] as const;

/** Visual marker persisted for a product category. */
export type CategoryIcon = typeof CATEGORY_ICON_VALUES[number];

/**
 * Determines whether an untrusted value is a supported category icon.
 *
 * @param value - Wire or user-provided value to validate.
 * @returns Whether the value belongs to the supported icon set.
 */
export function isCategoryIcon(value: unknown): value is CategoryIcon {
  return typeof value === 'string' && CATEGORY_ICON_VALUES.some((icon) => icon === value);
}

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
  pricingMode: ProductPricingMode;
  currency: string;
  price?: Money;
  imageUrl?: string;
  active: boolean;
  sortOrder: number;
}

/** Command used by catalog managers to create one product. */
export interface ProductCreateCommand {
  categoryId: string;
  name: string;
  pricingMode: ProductPricingMode;
  price?: Money;
}

/** Command used by catalog managers to update one product optimistically. */
export interface ProductUpdateCommand {
  name: string;
  pricingMode: ProductPricingMode;
  price?: Money;
  active: boolean;
  sortOrder: number;
  version: number;
}

/** A category and its currently available products. */
export interface Category {
  id: string;
  version: number;
  name: string;
  icon: CategoryIcon;
  active: boolean;
  sortOrder: number;
  products: Product[];
}

/** Command used by catalog managers to create one category. */
export interface CategoryCreateCommand {
  name: string;
  icon: CategoryIcon;
}

/** Command used by catalog managers to update one category optimistically. */
export interface CategoryUpdateCommand {
  name: string;
  icon: CategoryIcon;
  active: boolean;
  sortOrder: number;
  version: number;
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
  memberAvatarUrl?: string;
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
  bookedByAvatarUrl?: string;
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
  unitPrice?: Money;
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

/** Consolidated group account balance for one active or archived membership. */
export interface AccountSummary {
  membershipId: string;
  displayName: string;
  avatarUrl?: string;
  status: 'ACTIVE' | 'ARCHIVED';
  currency: string;
  balance: Money;
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

/** Safe onboarding hints resolved from a valid invitation token. */
export interface InvitationPreview {
  displayName: string;
  existingAccount: boolean;
}

/** Outbound email lifecycle state for a group invitation. */
export type EmailDeliveryStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'CANCELLED' | 'NOT_REQUESTED';

/** Result of attempting to create one invitation from an imported CSV row. */
export type InvitationImportStatus = 'CREATED' | 'INVALID' | 'SKIPPED_ALREADY_MEMBER' | 'SKIPPED_ALREADY_INVITED';

/** Non-secret invitation metadata returned by invitation list endpoints. */
export interface InvitationMetadata {
  id: string;
  email: string;
  displayName?: string;
  roles: GroupRole[];
  categoryPermissions: CategoryPermission[];
  expiresAt: string;
  acceptedAt?: string;
  revokedAt?: string;
  emailDeliveryStatus: EmailDeliveryStatus;
  emailSentAt?: string;
  emailFailureCode?: string;
}

/** A newly created one-time invitation including its one-time acceptance URL. */
export interface CreatedInvitation {
  id: string;
  email: string;
  displayName?: string;
  roles: GroupRole[];
  categoryPermissions: CategoryPermission[];
  expiresAt: string;
  acceptUrl: string;
  emailDeliveryStatus: EmailDeliveryStatus;
}

/** Editable defaults assigned to a manual group invitation. */
export interface InvitationInput {
  email: string;
  displayName: string;
  roles: GroupRole[];
  categoryPermissions: CategoryPermission[];
}

/** Result of rotating and resending an invitation email. */
export interface InvitationEmailResendResult {
  invitationId: string;
  emailDeliveryStatus: 'PENDING';
  expiresAt: string;
  acceptUrl: string;
}

/** Aggregate counters returned after processing one member invitation CSV. */
export interface InvitationImportSummary {
  totalRows: number;
  created: number;
  invalid: number;
  skipped: number;
}

/** Outcome for one data row in a member invitation CSV. */
export interface InvitationImportRow {
  row: number;
  email?: string;
  displayName?: string;
  invitationId?: string;
  invitationStatus: InvitationImportStatus;
  emailDeliveryStatus?: EmailDeliveryStatus;
  code?: string;
}

/** Complete row-level response returned by the member invitation import. */
export interface InvitationImportResult {
  summary: InvitationImportSummary;
  rows: InvitationImportRow[];
}

/** Delivery state returned after an administrator retries one invitation email. */
export interface InvitationEmailRetryResult {
  invitationId: string;
  emailDeliveryStatus: 'PENDING';
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
