/** A monetary amount represented in minor units to avoid floating-point errors. */
export interface Money {
  minorUnits: string;
  currency: string;
}

/** Determines whether a product price is fixed by the catalog or chosen per booking. */
export type ProductPricingMode = 'FIXED' | 'USER_DEFINED';

/** Roles that can be assigned to a group membership. */
export type GroupRole = 'ADMIN' | 'FINANCE_MANAGER' | 'CATALOG_MANAGER' | 'MEMBER';

/** Narrow group-scoped rights that do not grant a management workspace. */
export type GroupPermission = 'SELF_RECORD_PAYMENT';

/** Stable authorization keys understood by the API and every client. */
export type PermissionKey =
  | 'GROUP_ADMINISTRATION'
  | 'ROLE_MANAGEMENT'
  | 'FINANCE_MANAGEMENT'
  | 'CATALOG_MANAGEMENT'
  | 'VIEW_MEMBER_DIRECTORY'
  | 'VIEW_GROUP_STATISTICS'
  | 'VIEW_ALL_BOOKING_ACTIVITY'
  | 'RECORD_OWN_PAYMENT'
  | 'CREATE_OWN_BOOKING'
  | 'VOID_OWN_BOOKING'
  | 'VOID_ANY_BOOKING'
  | 'BOOK_FOR_OTHERS'
  | 'BOOK_FOR_GUESTS';

/** Complete permission-key registry in stable display order. */
export const PERMISSION_KEYS = [
  'GROUP_ADMINISTRATION',
  'ROLE_MANAGEMENT',
  'FINANCE_MANAGEMENT',
  'CATALOG_MANAGEMENT',
  'VIEW_MEMBER_DIRECTORY',
  'VIEW_GROUP_STATISTICS',
  'VIEW_ALL_BOOKING_ACTIVITY',
  'RECORD_OWN_PAYMENT',
  'CREATE_OWN_BOOKING',
  'VOID_OWN_BOOKING',
  'VOID_ANY_BOOKING',
  'BOOK_FOR_OTHERS',
  'BOOK_FOR_GUESTS',
] as const satisfies readonly PermissionKey[];

/**
 * Determines whether an untrusted value is a supported permission key.
 *
 * @param value - Wire value to validate.
 * @returns Whether the value belongs to the stable permission registry.
 */
export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === 'string' && PERMISSION_KEYS.some((permission) => permission === value);
}

/** Group-wide scope used by the first dynamic-permission release. */
export interface GroupPermissionScope {
  type: 'GROUP';
}

/** One allow-only permission attached to a role. */
export interface PermissionGrant {
  permission: PermissionKey;
  scope: GroupPermissionScope;
}

/** Server-owned permission metadata used by the role editor. */
export interface PermissionDefinition {
  key: PermissionKey;
  name?: string;
  description?: string;
  impliedPermissions?: PermissionKey[];
  allowedScopes?: Array<'GROUP' | 'CATEGORY' | 'PRODUCT'>;
}

/** Reserved role identities whose behavior is protected by the server. */
export type RolePresetKey = 'GROUP_ADMINISTRATOR' | 'MEMBER' | 'FINANCE_MANAGER' | 'CATALOG_MANAGER';

/** A group-owned role containing reusable permission grants. */
export interface Role {
  id: string;
  groupId?: string;
  presetKey?: RolePresetKey;
  name: string;
  description?: string;
  nameLocked?: boolean;
  deletable?: boolean;
  grants: PermissionGrant[];
  version: number;
  memberCount: number;
  pendingInvitationCount: number;
  createdAt?: string;
  updatedAt?: string;
}

/** Editable role fields accepted by create and update endpoints. */
export interface RoleInput {
  name: string;
  description?: string;
  grants: PermissionGrant[];
}

/** One member or pending invitation and all assigned group role IDs. */
export interface RoleAssignment {
  subjectType: 'MEMBERSHIP' | 'INVITATION';
  subjectId: string;
  roleIds: string[];
  version: number;
  etag?: string;
}

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

/** Operational lifecycle state of one group membership. */
export type MembershipStatus = 'ACTIVE' | 'ARCHIVED' | 'DELETED';

/** A signed-in user account. */
export interface User {
  id: string;
  displayName: string;
  email: string;
  avatarUrl?: string;
}

/** Public availability of account-recovery features for the current deployment. */
export interface AuthenticationCapabilities {
  passwordResetAvailable: boolean;
  emailChangeAvailable: boolean;
}

/** Confirmation returned after an email-change request has been accepted. */
export interface EmailChangeRequestResult {
  verificationRequired: true;
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
    groupPermissions: GroupPermission[];
    roleIds?: string[];
    effectiveGrants?: PermissionGrant[];
    roleAssignmentsVersion?: number;
  };
}

/** Administrator-managed notification behavior shared by one group. */
export interface GroupSettings {
  notificationEmailsEnabled: boolean;
  notificationEmailDeliveryAvailable: boolean;
  defaultRoleId: string | null;
}

/**
 * Group notification-settings update accepted by the API.
 */
export interface GroupSettingsUpdateInput {
  notificationEmailsEnabled?: boolean;
  defaultRoleId?: string;
}

/** Administrator-visible state of the group's single public join link. */
export interface PublicJoinLink {
  enabled: boolean;
  expired: boolean;
  expiresAt: string | null;
  acceptUrl?: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
  emailVerificationAvailable: boolean;
}

/** Full desired public join-link configuration. A null expiry is unlimited. */
export interface PublicJoinLinkUpdate {
  enabled: boolean;
  expiresAt: string | null;
}

/** Safe group metadata resolved from a valid public join-link token. */
export interface PublicJoinPreview {
  groupName: string;
  expiresAt: string | null;
}

/** New-account registration started from a reusable public join link. */
export interface PublicJoinRegistrationInput {
  joinToken: string;
  email: string;
  displayName: string;
  password: string;
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

/**
 * Complete catalog order used to atomically persist category and product
 * positions without allowing products to change their owning category.
 */
export interface CatalogOrderCommand {
  categoryIds: string[];
  productIdsByCategory: Record<string, string[]>;
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
  email: string | null;
  initials: string;
  avatarUrl?: string;
  isTemporaryGuest: boolean;
  roles: GroupRole[];
  groupPermissions: GroupPermission[];
  categoryPermissions: CategoryPermission[];
  roleIds?: string[];
  effectiveGrants?: PermissionGrant[];
  roleAssignmentsVersion?: number;
  status: MembershipStatus;
  active: boolean;
  etag?: string;
}

/** A booking displayed in activity feeds and account statements. */
export interface Booking {
  id: string;
  memberId: string;
  memberName: string;
  memberStatus: MembershipStatus;
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
  bookedByStatus: MembershipStatus;
  bookedByMemberId?: string;
  bookedByAvatarUrl?: string;
  reason?: string;
  status: 'POSTED' | 'REVERSED';
  undoUntil?: string;
  canVoid?: boolean;
  voidReasonRequired?: boolean;
  voidWithoutReasonUntil?: string;
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

/** Command used to atomically create the same booking for multiple members. */
export interface BookingBatchCommand {
  productId: string;
  productVersion: number;
  expectedPeriodId: string;
  quantity: number;
  unitPrice?: Money;
  targetMembershipIds?: string[];
  temporaryGuestDisplayNames?: string[];
  reason?: string;
}

/** Minimal member identity exposed as a selectable booking target. */
export interface BookingTarget {
  membershipId: string;
  displayName: string;
  avatarUrl?: string;
  isTemporaryGuest: boolean;
}

/** Permission-filtered read model required by the product booking page. */
export interface BookingContext {
  openPeriod: Period;
  ownBalance: Money;
  currentMembership: Membership;
  targets: BookingTarget[];
  canBookForGuests: boolean;
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

/** Consolidated group account balance for one operational or non-zero deleted membership. */
export interface AccountSummary {
  membershipId: string;
  displayName: string;
  avatarUrl?: string;
  isTemporaryGuest: boolean;
  status: MembershipStatus;
  currency: string;
  balance: Money;
}

/** A payment received for a member account. */
export interface Payment {
  id: string;
  membershipId: string;
  memberName: string;
  membershipStatus: MembershipStatus;
  amount: Money;
  receivedAt: string;
  method: 'CASH' | 'BANK_TRANSFER' | 'PAYPAL' | 'OTHER';
  reference?: string;
  note?: string;
  status: 'POSTED' | 'REVERSED';
}

/** Complete command for restoring one archived group membership. */
export interface MemberReactivationCommand {
  displayName?: string;
  roleIds: string[];
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

/** Command for recording a payment against the authenticated member account. */
export interface SelfPaymentCommand {
  amount: Money;
  receivedAt: string;
  method: Payment['method'];
  reference: string;
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
  email: string | null;
  amount: Money;
  paidAmount: Money;
  openAmount?: Money;
  dueAt: string;
  status: SettlementStatus;
}

/** Stable event types emitted by the financial notification system. */
export type NotificationEventType = 'BOOKING_ASSIGNED' | 'BOOKING_REVERSED' | 'PAYMENT_RECORDED' | 'PAYMENT_REVERSED' | 'SETTLEMENT_CREATED' | 'SYSTEM';

/** Safe structured details used to localize one notification. */
export interface NotificationContext {
  actorName?: string;
  itemName?: string;
  quantity?: number;
  amountMinor?: string;
  currency?: string;
  periodLabel?: string;
  dueAt?: string;
}

/** An in-app notification addressed to the signed-in user. */
export interface Notification {
  id: string;
  title: string;
  message: string;
  createdAt: string;
  readAt?: string;
  kind: 'BOOKING' | 'PAYMENT' | 'SETTLEMENT' | 'SYSTEM';
  eventType: NotificationEventType;
  context: NotificationContext;
}

/** One cursor-backed notification page. */
export interface NotificationPage {
  items: Notification[];
  nextCursor?: string;
}

/** Exact unread count returned by the lightweight navigation endpoint. */
export interface NotificationSummary {
  unreadCount: number;
}

/** Result of acknowledging visible notifications. */
export interface NotificationReadResult extends NotificationSummary {
  readAt: string;
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
  groupPermissions: GroupPermission[];
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
  groupPermissions: GroupPermission[];
  categoryPermissions: CategoryPermission[];
  roleIds?: string[];
  roleAssignmentsVersion: number;
  etag?: string;
  expiresAt: string;
  acceptedAt?: string;
  revokedAt?: string;
  emailDeliveryStatus: EmailDeliveryStatus;
  emailSentAt?: string;
  emailFailureCode?: string;
  targetMembershipId?: string;
}

/** A newly created one-time invitation including its one-time acceptance URL. */
export interface CreatedInvitation {
  id: string;
  email: string;
  displayName?: string;
  roles: GroupRole[];
  groupPermissions: GroupPermission[];
  categoryPermissions: CategoryPermission[];
  roleIds?: string[];
  roleAssignmentsVersion: number;
  expiresAt: string;
  acceptUrl: string;
  emailDeliveryStatus: EmailDeliveryStatus;
  targetMembershipId?: string;
}

/** Editable defaults assigned to a manual group invitation. */
export interface InvitationInput {
  email: string;
  displayName: string;
  roles: GroupRole[];
  groupPermissions: GroupPermission[];
  categoryPermissions: CategoryPermission[];
  roleIds?: string[];
}

/**
 * Complete editable state for an open invitation.
 *
 * Every update uses the assignment version for optimistic concurrency.
 * Role-based updates intentionally exclude all deprecated permission fields;
 * legacy updates remain available when `roleIds` is omitted.
 */
export type InvitationUpdateInput =
  | {
    displayName: string;
    roleIds: string[];
    roleAssignmentsVersion: number;
    roles?: never;
    groupPermissions?: never;
    categoryPermissions?: never;
  }
  | {
    displayName: string;
    roleIds?: never;
    roleAssignmentsVersion: number;
    roles: GroupRole[];
    groupPermissions: GroupPermission[];
    categoryPermissions: CategoryPermission[];
  };

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
  existingMembershipId?: string;
  errors?: Record<string, string[]>;
}
