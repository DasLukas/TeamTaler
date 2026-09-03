/** A monetary amount represented in minor units to avoid floating-point errors. */
export interface Money {
  minorUnits: string;
  currency: string;
}

/** Sort direction accepted by every server-backed collection endpoint. */
export type CollectionSortDirection = 'asc' | 'desc';

/** Shared search, sorting, and cursor options for an immutable collection. */
export interface CollectionQuery<SortKey extends string> {
  q?: string;
  limit?: number;
  cursor?: string;
  sort?: SortKey;
  direction?: CollectionSortDirection;
}

/** One cursor-based collection page while preserving the API's array response body. */
export interface CollectionPage<Item> {
  items: Item[];
  nextCursor?: string;
  hasMore: boolean;
  limit: number;
}

/** Stable identifiers for server-rendered table exports. */
export type TableExportId =
  | 'ACTIVITIES'
  | 'PAYMENTS'
  | 'ACCOUNT_BALANCES'
  | 'GROUP_SETTLEMENTS'
  | 'SETTLEMENT_STATEMENT'
  | 'PERSONAL_SETTLEMENTS'
  | 'ACTIVE_MEMBERS'
  | 'ARCHIVED_MEMBERS'
  | 'GROUP_AUDIT'
  | 'SYSTEM_AUDIT';

/** File formats supported by the synchronous table-export endpoint. */
export type TableExportFormat = 'CSV' | 'PDF';

/** Normalized request for exporting the complete filtered and sorted table. */
export interface TableExportCommand {
  table: TableExportId;
  format: TableExportFormat;
  timeZone: string;
  query: Record<string, unknown>;
}

/** Scope of an asynchronous structured-data export. */
export type DataExportScope = 'GROUP' | 'PERSONAL';

/** Lifecycle states exposed by structured-data export jobs. */
export type DataExportStatus = 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED' | 'CANCELLED' | 'EXPIRED';

/** Optional determinate progress reported by a structured-data export worker. */
export interface DataExportProgress {
  completed: number;
  total: number;
}

/** Sensitive structured-data export owned by the current actor. */
export interface DataExportJob {
  id: string;
  scope: DataExportScope;
  status: DataExportStatus;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  expiresAt?: string;
  sizeBytes?: string;
  sha256?: string;
  progress?: DataExportProgress;
  downloadUrl?: string;
  errorCode?: string;
}

/** Server-backed unified account-activity search, filter, and sort options. */
export interface ActivityCollectionQuery extends CollectionQuery<'kind' | 'targetName' | 'actorName' | 'detailName' | 'categoryName' | 'occurredAt' | 'amount' | 'status'> {
  /** Stable activity ID used to request a permission-scoped context window around one row. */
  anchorId?: string;
  /** One or more repeated transaction kinds combined with OR semantics. */
  kind?: ActivityKind | readonly ActivityKind[];
  targetMembershipId?: string;
  /** One or more repeated category IDs; matching is booking-specific. */
  categoryId?: string | readonly string[];
  /** One or more repeated product IDs; matching is booking-specific. */
  productId?: string | readonly string[];
  status?: 'POSTED' | 'REVERSED';
  occurredFrom?: string;
  occurredTo?: string;
  /** Inclusive signed lower amount in minor units. */
  amountMin?: string;
  /** Inclusive signed upper amount in minor units. */
  amountMax?: string;
}

/** Server-backed activity search, filter, and sort options. */
export interface BookingCollectionQuery extends CollectionQuery<'createdAt' | 'amount' | 'targetName' | 'actorName' | 'productName' | 'categoryName' | 'status'> {
  periodId?: string;
  actorMembershipId?: string;
  targetMembershipId?: string;
  /** One or more repeated categoryId query values combined with OR semantics. */
  categoryId?: string | readonly string[];
  /** One or more repeated productId query values combined with OR semantics. */
  productId?: string | readonly string[];
  status?: 'POSTED' | 'VOIDED';
  createdFrom?: string;
  createdTo?: string;
  amountMin?: string;
  amountMax?: string;
}

/** Privacy-minimized member identity exposed to member filter controls. */
export interface MemberFilterOption {
  membershipId: string;
  displayName: string;
  avatarUrl?: string;
}

/** Complete member catalog available to the authorized activity viewer. */
export interface BookingFilterOptions {
  members: MemberFilterOption[];
}

/** Booking category present in the authorized unified activity feed. */
export interface ActivityCategoryFilterOption {
  categoryId: string;
  name: string;
  icon: CategoryIcon;
}

/** Booking product present in the authorized unified activity feed. */
export interface ActivityProductFilterOption {
  productId: string;
  categoryId: string;
  name: string;
  imageUrl?: string;
}

/** Complete transaction-kind, member, and booking catalog derived from the authorized unified feed. */
export interface ActivityFilterOptions {
  kinds: ActivityKind[];
  members: MemberFilterOption[];
  categories: ActivityCategoryFilterOption[];
  products: ActivityProductFilterOption[];
}

/** Server-backed incoming-payment search, filter, and sort options. */
export interface PaymentCollectionQuery extends CollectionQuery<'receivedAt' | 'amount' | 'memberName' | 'actorName' | 'method' | 'status'> {
  membershipId?: string;
  method?: string;
  status?: 'POSTED' | 'REVERSED';
  receivedFrom?: string;
  receivedTo?: string;
  amountMin?: string;
  amountMax?: string;
}

/** Server-backed group-audit search, filter, and sort options. */
export interface AuditCollectionQuery extends CollectionQuery<'occurredAt' | 'actorName' | 'action' | 'resourceType'> {
  actorUserId?: string;
  actorMembershipId?: string;
  /** One or more repeated action query values combined with OR semantics. */
  action?: string | readonly string[];
  /** One or more repeated resourceType query values combined with OR semantics. */
  resourceType?: string | readonly string[];
  occurredFrom?: string;
  occurredTo?: string;
}

/** Server-backed system-audit search, filter, and sort options. */
export type SystemAuditCollectionQuery = Omit<AuditCollectionQuery, 'actorMembershipId'>;

/** Complete data-derived option catalog for one authorized audit scope. */
export interface AuditFilterOptions {
  actions: string[];
  resourceTypes: string[];
  /** Persisted resource types observed for each action. */
  actionResourceTypes?: Record<string, string[]>;
  /** Group-membership actors present in the authorized audit scope. */
  actors?: MemberFilterOption[];
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
  | 'MEMBER_MANAGEMENT'
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
  | 'BOOK_FOR_GUESTS'
  | 'USE_PLANNING'
  | 'CREATE_PLANNING_EVENTS'
  | 'VIEW_PLANNING_PARTICIPANTS'
  | 'MANAGE_PLANNING_EVENTS';

/** Complete permission-key registry in stable display order. */
export const PERMISSION_KEYS = [
  'GROUP_ADMINISTRATION',
  'MEMBER_MANAGEMENT',
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
  'USE_PLANNING',
  'CREATE_PLANNING_EVENTS',
  'VIEW_PLANNING_PARTICIPANTS',
  'MANAGE_PLANNING_EVENTS',
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
export type RolePresetKey = 'GROUP_ADMINISTRATOR';

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

/** Supported account-level color-scheme preferences. */
export const COLOR_MODE_VALUES = ['SYSTEM', 'LIGHT', 'DARK'] as const;

/** Account preference controlling how light and dark palettes are resolved. */
export type ColorMode = typeof COLOR_MODE_VALUES[number];

/** Stable identifiers for every predefined group color theme. */
export const THEME_ID_VALUES = ['TEAMTALER', 'NRW', 'TIEF_IM_WESTEN', 'FIRE'] as const;

/** One predefined group color theme. */
export type ThemeId = typeof THEME_ID_VALUES[number];

/**
 * Determines whether an untrusted value is a supported color-mode preference.
 *
 * @param value - Wire or user-provided value to validate.
 * @returns Whether the value belongs to the supported color-mode registry.
 */
export function isColorMode(value: unknown): value is ColorMode {
  return typeof value === 'string' && COLOR_MODE_VALUES.some((mode) => mode === value);
}

/**
 * Determines whether an untrusted value is a supported predefined theme.
 *
 * @param value - Wire or user-provided value to validate.
 * @returns Whether the value belongs to the predefined theme registry.
 */
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEME_ID_VALUES.some((theme) => theme === value);
}

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

/** Global roles assigned outside every group and managed exclusively by the host CLI. */
export type SystemRole = 'SYSTEM_ADMINISTRATOR';

/** Browser fallback used only while public instance capabilities are unavailable. */
export const DEFAULT_MEDIA_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/** Browser fallback for immutable payment attachments. */
export const DEFAULT_ATTACHMENT_UPLOAD_MAX_BYTES = 15 * 1024 * 1024;

/** Public, non-sensitive instance behavior required before authenticated features render. */
export interface InstanceCapabilities {
  instanceName: string;
  maintenanceMode: boolean;
  maintenanceMessage: string;
  publicJoinEnabled: boolean;
  mediaUploadMaxBytes: number;
  attachmentUploadMaxBytes: number;
  /** Whether SMTP-backed optional notifications can currently be delivered. */
  emailNotificationsAvailable: boolean;
  /** Whether this deployment exposes a complete, active Web Push configuration. */
  webPushAvailable: boolean;
  /** URL-safe VAPID public key used only by the browser subscription API. */
  webPushPublicKey: string | null;
  /** Opaque VAPID revision used to reconcile subscriptions after key rotation. */
  webPushKeyId: string | null;
}

/** Confirmation returned after an email-change request has been accepted. */
export interface EmailChangeRequestResult {
  verificationRequired: true;
}

/** Current user's group membership projected into the authenticated session. */
export interface SessionMembership {
  id: string;
  roles: GroupRole[];
  groupPermissions: GroupPermission[];
  roleIds?: string[];
  effectiveGrants?: PermissionGrant[];
  roleAssignmentsVersion?: number;
  themeOverride: ThemeId | null;
}

/** A group available to the signed-in user. */
export interface Group {
  id: string;
  name: string;
  currency: string;
  logoUrl?: string;
  defaultTheme: ThemeId;
  planningEnabled?: boolean;
  membership?: SessionMembership;
}

/** Supported behavioral models for a planning event. */
export type PlanningEventType = 'APPOINTMENT' | 'APPOINTMENT_POLL' | 'APPOINTMENT_REGISTRATION';

/** Lifecycle state of a planning event. */
export type PlanningEventStatus = 'PUBLISHED' | 'CLOSED' | 'COMPLETED' | 'CANCELLED';

/** Audience selector persisted for an event or event series. */
export type PlanningAudienceType = 'ALL_ACTIVE_MEMBERS' | 'SELECTED_ROLES' | 'SELECTED_MEMBERS' | 'SELECTED_TARGETS';

/** RFC 5545 weekday identifiers accepted by planning recurrence rules. */
export type PlanningWeekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

/** Supported recurrence frequencies for a planning series. */
export type PlanningRecurrenceFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

/** Supported monthly recurrence strategies. */
export type PlanningMonthlyMode = 'DAY_OF_MONTH' | 'NTH_WEEKDAY' | 'LAST_DAY';

/** End condition for a recurrence rule. */
export type PlanningRecurrenceRange =
  | { type: 'NEVER' }
  | { type: 'COUNT'; count: number }
  | { type: 'UNTIL'; until: string };

/** Structured, validated recurrence rule used instead of accepting raw RRULE text. */
export interface PlanningRecurrenceInput {
  frequency: PlanningRecurrenceFrequency;
  interval: number;
  weekdays?: PlanningWeekday[];
  monthlyMode?: PlanningMonthlyMode;
  range: PlanningRecurrenceRange;
}

/** Mutation scope offered when changing one occurrence in an event series. */
export type PlanningSeriesScope = 'THIS' | 'THIS_AND_FOLLOWING' | 'ALL';

/** Response states shared by appointment polls and appointment registrations. */
export type PlanningParticipationStatus = 'ATTENDING' | 'MAYBE' | 'DECLINED' | 'WAITLISTED';
export type PlanningParticipationWireStatus = 'YES' | 'MAYBE' | 'NO' | 'REGISTERED' | 'WAITLISTED' | 'WITHDRAWN';

/** Group-owned planning module state. */
export interface PlanningSettings {
  enabled: boolean;
  version: number;
  timeZone: string;
  updatedAt?: string;
}

/** One audience definition used by events and recurring series. */
export interface PlanningAudience {
  type: PlanningAudienceType;
  roleIds: string[];
  memberIds: string[];
}

/** Current-user participation projection. */
export interface PlanningViewerParticipation {
  status: PlanningParticipationStatus | 'WITHDRAWN';
  wireStatus?: PlanningParticipationWireStatus;
  updatedAt?: string;
}

/** Aggregated response counts that never reveal participant identities. */
export interface PlanningParticipationSummary {
  invited: number;
  attending: number;
  maybe: number;
  declined: number;
  unanswered: number;
  waitlisted: number;
  capacity?: number;
  /** Deprecated compatibility field. New servers always return zero. */
  reconfirmationRequired: number;
}

/** Shared planning-event fields returned independently of its timing model. */
export interface PlanningEventBase {
  id: string;
  version: number;
  eventType: PlanningEventType;
  status: PlanningEventStatus;
  title: string;
  description: string;
  location: string;
  /** Legacy instant used for sorting and compatibility, including all-day events. */
  startsAt: string;
  /** Legacy end instant used for sorting and compatibility, including all-day events. */
  endsAt?: string;
  responseDeadline?: string;
  responseDeadlineMinutesBefore?: number;
  capacity?: number;
  waitlistEnabled: boolean;
  confirmationRevision: number;
  audience: PlanningAudience;
  participation: PlanningParticipationSummary;
  viewerParticipation?: PlanningViewerParticipation;
  createdByName?: string;
  canEdit: boolean;
  canCancel: boolean;
  canRespond: boolean;
  canViewParticipants: boolean;
  seriesId?: string;
  originalStartAt?: string;
  originalStartDate?: string;
  isSeriesException?: boolean;
}

/** Timed event values interpreted in the group's pinned time zone. */
export interface PlanningTimedEventTiming {
  allDay: false;
  startsAt: string;
  endsAt?: string;
  startDate?: never;
  endDateExclusive?: never;
  timeZone: string;
}

/** All-day event values whose exclusive end avoids ambiguous midnight instants. */
export interface PlanningAllDayEventTiming {
  allDay: true;
  startDate: string;
  endDateExclusive: string;
  timeZone: string;
  startsAt: string;
  endsAt?: string;
}

/** Planning event returned by list and detail endpoints. */
export type PlanningEvent = PlanningEventBase & (PlanningTimedEventTiming | PlanningAllDayEventTiming);

/** Shared editable planning-event fields accepted by create and update endpoints. */
export interface PlanningEventInputBase {
  eventType: PlanningEventType;
  title: string;
  description?: string;
  location?: string;
  responseDeadlineMinutesBefore?: number;
  capacity?: number;
  waitlistEnabled?: boolean;
  audience: PlanningAudience;
}

/** Timed input sent without date-only fields. */
export interface PlanningTimedEventInput {
  allDay?: false;
  startsAt: string;
  endsAt?: string;
  startDate?: never;
  endDateExclusive?: never;
}

/** All-day input sent without timestamp fields. */
export interface PlanningAllDayEventInput {
  allDay: true;
  startDate: string;
  endDateExclusive: string;
  startsAt?: never;
  endsAt?: never;
}

/** Editable planning-event command with a discriminated timing model. */
export type PlanningEventInput = PlanningEventInputBase & (PlanningTimedEventInput | PlanningAllDayEventInput);

/** Cursor-backed page of planning events. */
export interface PlanningEventPage {
  items: PlanningEvent[];
  nextCursor?: string;
}

/** Shared recurrence definition fields independent of its timing model. */
export interface PlanningSeriesBase {
  id: string;
  version: number;
  status: 'PUBLISHED' | 'CANCELLED';
  timeZone: string;
  eventType: PlanningEventType;
  title: string;
  description: string;
  location: string;
  responseDeadlineMinutesBefore?: number;
  capacity?: number;
  waitlistEnabled: boolean;
  audience: PlanningAudience;
  recurrence: PlanningRecurrenceInput;
  createdAt?: string;
  updatedAt?: string;
}

/** Timed recurrence duration measured in wall-clock minutes. */
export interface PlanningTimedSeriesTiming {
  allDay: false;
  durationMinutes: number;
  startDate?: never;
  durationDays?: never;
}

/** All-day recurrence duration measured in complete calendar days. */
export interface PlanningAllDaySeriesTiming {
  allDay: true;
  startDate: string;
  durationDays: number;
  durationMinutes?: never;
}

/** Group-owned recurrence definition shared by materialized event occurrences. */
export type PlanningSeries = PlanningSeriesBase & (PlanningTimedSeriesTiming | PlanningAllDaySeriesTiming);

/** Response returned by series creation and mutations that materialize an occurrence. */
export interface PlanningSeriesResult {
  series: PlanningSeries;
  firstOccurrence?: PlanningEvent;
}

/** Flat command for creating a recurring planning event. */
export type PlanningSeriesCreateInput = PlanningEventInput & {
  recurrence: PlanningRecurrenceInput;
};

/** Flat command for changing an entire series or its future segment. */
export type PlanningSeriesUpdateInput = PlanningEventInput & {
  recurrence: PlanningRecurrenceInput;
  scope: Exclude<PlanningSeriesScope, 'THIS'>;
  fromOriginalStartAt: string;
};

/** One named participant visible only to authorized viewers. */
export interface PlanningParticipant {
  membershipId: string;
  displayName: string;
  avatarUrl?: string;
  status?: PlanningParticipationStatus | 'WITHDRAWN';
  effectiveStatus?: PlanningParticipationStatus | 'WITHDRAWN';
  confirmedRevision: number;
  version: number;
  updatedAt?: string;
}

/** Cursor-backed participant page. */
export interface PlanningParticipantPage {
  items: PlanningParticipant[];
  nextCursor?: string;
}

/** Compact planning item embedded in the dashboard response. */
export interface DashboardPlanningItem {
  event: PlanningEvent;
  actionRequired: boolean;
}

/** One stable, ordered, administrator-managed transaction form option. */
export interface ConfigurableItem {
  id: string;
  label: string;
}

/** Controls whether one payment method accepts or requires a receipt. */
export type AttachmentMode = 'OFF' | 'OPTIONAL' | 'REQUIRED';

/** A PayPal.Me account configured as the external destination of a payment method. */
export interface PaypalMePaymentTarget {
  type: 'PAYPAL_ME';
  paypalMeHandle: string;
}

/** A SEPA credit-transfer account configured as the external destination of a payment method. */
export interface SepaTransferPaymentTarget {
  type: 'SEPA_TRANSFER';
  recipientName: string;
  iban: string;
  bic?: string;
}

/** Supported external payment destinations associated with one payment method. */
export type PaymentTarget = PaypalMePaymentTarget | SepaTransferPaymentTarget;

/** One stable, ordered payment method, receipt policy, and optional external destination. */
export interface PaymentMethod extends ConfigurableItem {
  attachmentMode: AttachmentMode;
  paymentTarget: PaymentTarget | null;
}

/** One payment-method update with tri-state external-destination semantics. */
export interface PaymentMethodUpdate extends ConfigurableItem {
  attachmentMode: AttachmentMode;
  paymentTarget?: PaymentTarget | null;
}

/** Visibility and validation policy for one transaction-reason context. */
export type ReasonMode = 'OFF' | 'OPTIONAL' | 'REQUIRED';

/** Member-visible operational behavior and payment destinations used by transaction surfaces. */
export interface TransactionSettings {
  settlementsEnabled: boolean;
  ownBookingReasonMode: ReasonMode;
  foreignBookingReasonMode: ReasonMode;
  ownPaymentReasonMode: ReasonMode;
  otherPaymentReasonMode: ReasonMode;
  foreignBookingReasonRequired: boolean;
  ownPaymentReasonRequired: boolean;
  otherPaymentReasonRequired: boolean;
  paymentMethods: PaymentMethod[];
  bookingReasons: ConfigurableItem[];
  paymentReasons: ConfigurableItem[];
}

/** Administrator-managed group behavior shared by one group. */
export interface GroupSettings {
  defaultTheme: ThemeId;
  settlementsEnabled: boolean;
  settlementDueSoonDays: number;
  settlementOverdueRepeatDays: number;
  defaultRoleId: string | null;
  ownBookingReasonMode: ReasonMode;
  foreignBookingReasonMode: ReasonMode;
  ownPaymentReasonMode: ReasonMode;
  otherPaymentReasonMode: ReasonMode;
  foreignBookingReasonRequired: boolean;
  ownPaymentReasonRequired: boolean;
  otherPaymentReasonRequired: boolean;
  paymentMethods: PaymentMethod[];
  bookingReasons: ConfigurableItem[];
  paymentReasons: ConfigurableItem[];
}

/**
 * Partial group-settings update accepted by the API.
 */
export interface GroupSettingsUpdateInput {
  defaultTheme?: ThemeId;
  settlementsEnabled?: boolean;
  settlementDueSoonDays?: number;
  settlementOverdueRepeatDays?: number;
  defaultRoleId?: string;
  ownBookingReasonMode?: ReasonMode;
  foreignBookingReasonMode?: ReasonMode;
  ownPaymentReasonMode?: ReasonMode;
  otherPaymentReasonMode?: ReasonMode;
  foreignBookingReasonRequired?: boolean;
  ownPaymentReasonRequired?: boolean;
  otherPaymentReasonRequired?: boolean;
  paymentMethods?: PaymentMethodUpdate[];
  bookingReasons?: ConfigurableItem[];
  paymentReasons?: ConfigurableItem[];
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
  activeGroupId: string | null;
  defaultGroupId: string | null;
  colorMode: ColorMode;
  systemRoles: SystemRole[];
  demo?: boolean;
}

/** Persisted account-level appearance preference. */
export interface AppearancePreference {
  colorMode: ColorMode;
}

/** Persisted group-scoped theme override for the signed-in membership. */
export interface ThemePreference {
  themeOverride: ThemeId | null;
}

/** Provenance of one effective instance-setting value. */
export type SystemSettingSource = 'CODE' | 'ENVIRONMENT' | 'DATABASE';

/** Effective value and provenance returned for one instance setting. */
export interface SystemSetting<T> {
  value: T;
  source: SystemSettingSource;
  overrideVersion: number | null;
  updatedAt: string | null;
}

/** Supported transport-security policies for outgoing SMTP connections. */
export type SmtpTlsMode = 'starttls' | 'tls';

/** Verification state of the currently persisted SMTP revision. */
export type SmtpTestStatus = 'UNTESTED' | 'VERIFIED' | 'FAILED';

/** Redacted, effective SMTP configuration exposed to system administrators. */
export interface SystemSmtpSettings {
  enabled: SystemSetting<boolean>;
  host: SystemSetting<string>;
  port: SystemSetting<number>;
  tlsMode: SystemSetting<SmtpTlsMode>;
  username: SystemSetting<string>;
  fromAddress: SystemSetting<string>;
  fromName: SystemSetting<string>;
  passwordConfigured: boolean;
  passwordSource: SystemSettingSource;
  passwordUpdatedAt: string | null;
  testStatus: SmtpTestStatus;
  testedRevision: number | null;
  testedAt: string | null;
  revision: number;
  requiresTest: boolean;
  configurationValid: boolean;
  active: boolean;
}

/** Redacted, effective Web Push configuration exposed to system administrators. */
export interface SystemWebPushSettings {
  enabled: SystemSetting<boolean>;
  subject: SystemSetting<string>;
  privateKeyConfigured: boolean;
  privateKeySource: SystemSettingSource;
  privateKeyUpdatedAt: string | null;
  storageKeyConfigured: boolean;
  publicKey: string | null;
  keyId: string | null;
  configurationValid: boolean;
  active: boolean;
  revision: number;
}

/** Complete effective, versioned instance settings document. */
export interface SystemSettings {
  revision: number;
  instanceName: SystemSetting<string>;
  defaultCurrency: SystemSetting<string>;
  timeZone: SystemSetting<string>;
  mediaUploadMaxBytes: SystemSetting<number>;
  attachmentUploadMaxBytes: SystemSetting<number>;
  publicJoinEnabled: SystemSetting<boolean>;
  maintenanceMode: SystemSetting<boolean>;
  maintenanceMessage: SystemSetting<string>;
  smtp: SystemSmtpSettings;
  webPush: SystemWebPushSettings;
  mediaUploadHardLimitBytes: number;
  attachmentUploadHardLimitBytes: number;
  updatedAt: string;
  updatedByUserId: string | null;
}

/** Scalar instance-setting keys that can be reset to their host-defined default. */
export type ResettableSystemSettingKey =
  | 'instanceName'
  | 'defaultCurrency'
  | 'timeZone'
  | 'mediaUploadMaxBytes'
  | 'attachmentUploadMaxBytes'
  | 'publicJoinEnabled'
  | 'maintenanceMode'
  | 'maintenanceMessage';

/** Partial scalar update accepted by the versioned system-settings endpoint. */
export interface SystemSettingsUpdate {
  instanceName?: string;
  defaultCurrency?: string;
  timeZone?: string;
  mediaUploadMaxBytes?: number;
  attachmentUploadMaxBytes?: number;
  publicJoinEnabled?: boolean;
  maintenanceMode?: boolean;
  maintenanceMessage?: string;
}

/** Complete SMTP update; an omitted password preserves the configured secret. */
export interface SystemSmtpSettingsUpdate {
  enabled?: boolean;
  host?: string;
  port?: number;
  tlsMode?: SmtpTlsMode;
  username?: string;
  fromAddress?: string;
  fromName?: string;
  password?: string;
}

/** Partial Web Push update; private material is generated and never accepted by this client. */
export interface SystemWebPushSettingsUpdate {
  enabled?: boolean;
  subject?: string;
}

/** Non-sensitive account projection available to system administrators. */
export interface SystemAccount {
  id: string;
  displayName: string;
  email: string;
  active: boolean;
}

/** Public lifecycle states used by the system group-management surface. */
export type SystemGroupStatus = 'PROVISIONING' | 'ACTIVE' | 'ARCHIVED';

/** Deletion-impact counters calculated by the server for one group. */
export interface SystemGroupImpact {
  members: number;
  invitations: number;
  bookings: number;
  financialRecords: number;
  auditEntries: number;
  mediaFiles: number;
}

/** Current, versioned impact document required immediately before purge. */
export interface SystemGroupDeletionImpact extends SystemGroupImpact {
  groupId: string;
  groupName: string;
  version: number;
  openBalance: Money;
}

/** System-administrator projection of one group and its lifecycle metadata. */
export interface SystemGroup {
  id: string;
  name: string;
  currency: string;
  status: SystemGroupStatus;
  version: number;
  administratorEmail: string | null;
  archivedAt: string | null;
  createdAt: string;
  logoUrl?: string;
  impact: SystemGroupImpact;
}

/** Input used to create an active or provisioning group. */
export interface SystemGroupCreateInput {
  name: string;
  currency: string;
  administratorEmail: string;
}

/** Immediate result of creating or replacing a first-administrator invitation. */
export interface SystemGroupInvitationResult {
  group: SystemGroup;
  acceptUrl: string | null;
  emailDeliveryStatus: EmailDeliveryStatus | null;
  expiresAt: string | null;
}

/** Immutable global system-audit entry. */
export interface SystemAuditEntry {
  id: string;
  action: string;
  actorUserId: string;
  actorDisplayName: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  createdAt: string;
}

/** Confirmation payload required to permanently purge one archived group. */
export interface SystemGroupPurgeInput {
  groupName: string;
}

/** Persisted account preference controlling the group selected after login. */
export interface GroupPreference {
  defaultGroupId: string | null;
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
  themeOverride: ThemeId | null;
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

/** Transaction source represented by the unified account activity feed. */
export type ActivityKind = 'BOOKING' | 'PAYMENT' | 'REVERSAL' | 'ADJUSTMENT';

/** Original transaction kind whose financial effect is cancelled by a reversal activity. */
export type ActivityReversalSourceKind = 'BOOKING' | 'PAYMENT';

/** One permission-scoped transaction in the unified account activity feed. */
export interface ActivityEntry {
  id: string;
  sourceId: string;
  periodId?: string;
  kind: ActivityKind;
  targetMembershipId: string;
  targetDisplayName: string;
  targetMembershipStatus: MembershipStatus;
  targetAvatarUrl?: string;
  actorMembershipId?: string;
  actorDisplayName?: string;
  actorMembershipStatus?: MembershipStatus;
  actorAvatarUrl?: string;
  detailName: string;
  detailNote?: string;
  paymentMethod?: Payment['method'];
  categoryId?: string;
  categoryName?: string;
  productId?: string;
  quantity?: number;
  amount: Money;
  occurredAt: string;
  status: 'POSTED' | 'REVERSED';
  /** Stable feed ID of the corresponding original or reversal entry. */
  relatedActivityId?: string;
  /** Original transaction kind; present for every `REVERSAL` activity. */
  reversalSourceKind?: ActivityReversalSourceKind;
  attachment?: PaymentAttachmentSummary;
  canReverse: boolean;
  reversalReasonRequired: boolean;
  reversalWithoutReasonUntil?: string;
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
  groupOutstanding?: Money;
  currentPeriod: Period;
  categoryTotals: CategoryTotal[];
  groupCategoryTotals: CategoryTotal[];
  recentBookings: Booking[];
  planning?: DashboardPlanningItem;
  planningEnabled?: boolean;
  openPlanningActionCount?: number;
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

/** One product line submitted as part of an atomic multi-product booking. */
export interface BookingBulkItemCommand {
  productId: string;
  productVersion: number;
  quantity: number;
  unitPrice?: Money;
}

/** Command used to atomically book multiple product lines for shared targets. */
export interface BookingBulkCommand {
  expectedPeriodId: string;
  items: BookingBulkItemCommand[];
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
  ownBookingReasonMode: ReasonMode;
  foreignBookingReasonMode: ReasonMode;
  foreignBookingReasonRequired: boolean;
  bookingReasons: ConfigurableItem[];
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
  attachment?: PaymentAttachmentSummary;
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
  memberAvatarUrl?: string;
  actorMembershipId?: string;
  actorName?: string;
  actorStatus?: MembershipStatus;
  actorAvatarUrl?: string;
  amount: Money;
  receivedAt: string;
  createdAt?: string;
  method: string;
  methodLabel: string;
  reference?: string;
  note?: string;
  status: 'POSTED' | 'REVERSED';
  attachment?: PaymentAttachmentSummary;
}

/** Safe payment-receipt metadata exposed without its internal storage key. */
export interface PaymentAttachmentSummary {
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  url: string;
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
  reference?: string;
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
  membershipStatus: MembershipStatus;
  memberName: string;
  email: string | null;
  amount: Money;
  paidAmount: Money;
  openAmount?: Money;
  dueAt: string;
  status: SettlementStatus;
}

/** Stable event types emitted by the financial notification system. */
export type NotificationEventType =
  | 'BOOKING_ASSIGNED'
  | 'BOOKING_REVERSED'
  | 'PAYMENT_RECORDED'
  | 'PAYMENT_REVERSED'
  | 'SETTLEMENT_CREATED'
  | 'SETTLEMENT_DUE_SOON'
  | 'SETTLEMENT_OVERDUE'
  | 'PLANNING_EVENT_PUBLISHED'
  | 'PLANNING_EVENT_UPDATED'
  | 'PLANNING_EVENT_CANCELLED'
  | 'PLANNING_WAITLIST_PROMOTED'
  | 'PLANNING_SERIES_PUBLISHED'
  | 'PLANNING_SERIES_UPDATED'
  | 'PLANNING_SERIES_CANCELLED'
  | 'DATA_EXPORT_READY'
  | 'DATA_EXPORT_FAILED'
  | 'SYSTEM';

/** Notification events whose optional external channels are user-configurable. */
export type ConfigurableNotificationEventType = Exclude<NotificationEventType, 'DATA_EXPORT_READY' | 'DATA_EXPORT_FAILED' | 'SYSTEM'>;

/** Optional external delivery channels controlled by system and member policy. */
export type NotificationChannel = 'EMAIL' | 'PUSH';

/** User-facing metadata for one event from the server-owned notification catalog. */
export interface NotificationEventDefinition {
  eventType: ConfigurableNotificationEventType;
  category: string;
  name: string;
  description: string;
  supportedChannels: NotificationChannel[];
}

/** Runtime availability of optional external delivery channels. */
export interface NotificationChannelAvailability {
  email: boolean;
  push: boolean;
}

/** One member's effective preferences for a group event. */
export interface NotificationPreference extends NotificationEventDefinition {
  email: boolean;
  push: boolean;
  emailAvailable: boolean;
  pushAvailable: boolean;
}

/** Versioned preference matrix for the current membership. */
export interface NotificationPreferences {
  version: number;
  channels: NotificationChannelAvailability;
  events: NotificationPreference[];
}

/** Editable external-channel choices for the current membership. */
export interface NotificationPreferencesUpdate {
  version: number;
  events: Array<{
    eventType: ConfigurableNotificationEventType;
    email?: boolean;
    push?: boolean;
  }>;
}

/** Public metadata for one account-owned browser subscription. */
export interface PushSubscriptionDevice {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  keyId: string;
  current: boolean;
}

/** Browser Push API material accepted only during subscription reconciliation. */
export interface BrowserPushSubscriptionInput {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    auth: string;
    p256dh: string;
  };
}

/** Registration command that combines safe device metadata with browser key material. */
export interface PushSubscriptionRegistration {
  label: string;
  keyId: string;
  subscription: BrowserPushSubscriptionInput;
}

/** Safe structured details used to localize one notification. */
export interface NotificationContext {
  actorName?: string;
  itemName?: string;
  quantity?: number;
  amountMinor?: string;
  currency?: string;
  periodLabel?: string;
  dueAt?: string;
  exportId?: string;
  exportScope?: DataExportScope;
  planningEventId?: string;
}

/** An in-app notification addressed to the signed-in user. */
export interface Notification {
  id: string;
  title: string;
  message: string;
  createdAt: string;
  readAt?: string;
  kind: 'BOOKING' | 'PAYMENT' | 'SETTLEMENT' | 'PLANNING' | 'SYSTEM';
  eventType: NotificationEventType;
  context: NotificationContext;
}

/** One cursor-backed notification page. */
export interface NotificationPage {
  items: Notification[];
  nextCursor?: string;
}

/** Active group resolved from an account-owned opaque notification identifier. */
export interface NotificationDestination {
  groupId: string;
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
  resourceType: string;
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
  expectedAccountState: InvitationAccountState;
}

/** Credential state bound to an invitation at preview time. */
export type InvitationAccountState = 'NEW' | 'EXISTING';

/** Safe onboarding hints resolved from a valid invitation token. */
export interface InvitationPreview {
  displayName: string;
  accountState: InvitationAccountState;
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
  emailDeliveryStatus: EmailDeliveryStatus;
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
