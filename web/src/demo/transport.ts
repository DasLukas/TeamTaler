import type {
  AccountSummary,
  ActivityEntry,
  ActivityFilterOptions,
  AuditFilterOptions,
  Booking,
  BookingBatchCommand,
  BookingBulkCommand,
  BookingCommand,
  CatalogOrderCommand,
  Category,
  CreatedInvitation,
  InvitationEmailResendResult,
  InvitationEmailRetryResult,
  InvitationImportResult,
  InvitationImportRow,
  InvitationCommand,
  InvitationInput,
  InvitationMetadata,
  InvitationPreview,
  LoginCommand,
  GroupSettings,
  GroupSettingsUpdateInput,
  MemberReactivationCommand,
  Membership,
  Notification,
  Payment,
  PaymentCommand,
  PaymentMethod,
  PermissionGrant,
  PermissionKey,
  SelfPaymentCommand,
  StatisticsBucket,
  Period,
  PermissionUpdate,
  Product,
  PublicJoinLink,
  PublicJoinPreview,
  Role,
  RoleAssignment,
  RoleInput,
  ReasonMode,
  Session,
} from '@/api/types';
import { isCategoryIcon, isColorMode, isStatisticsRange, isThemeId } from '@/api/types';
import { can } from '@/app/permissions';
import { MAX_PRODUCT_PRICE_MINOR } from '@/api/money';
import { zonedDateTimeInputToIso } from '@/features/planning/planningDate';
import {
  demoAccountSummaries,
  demoAudit,
  demoBookings,
  demoCategories,
  demoDashboard,
  demoLedger,
  demoStatisticsWire,
  demoMembers,
  demoNotifications,
  demoPayments,
  demoPermissionDefinitions,
  demoPeriods,
  demoPlanningEvents,
  demoRoles,
  demoSession,
  demoSettlements,
} from './data';
import i18n from '@/i18n';

type DemoRequestInit = RequestInit;

const ADMIN_CORE: readonly PermissionKey[] = ['GROUP_ADMINISTRATION', 'MEMBER_MANAGEMENT', 'ROLE_MANAGEMENT'];

interface DemoRoutePolicy {
  methods: readonly string[];
  resource: RegExp;
  anyOf: readonly PermissionKey[];
}

/** Development-only metadata required to project one immutable reversal event. */
interface DemoActivityReversal {
  actorAvatarUrl?: string;
  actorDisplayName: string;
  actorMembershipId: string;
  actorMembershipStatus: Membership['status'];
  occurredAt: string;
  reason?: string;
}

const DEMO_ROUTE_POLICIES: readonly DemoRoutePolicy[] = [
  { methods: ['GET', 'PATCH'], resource: /^settings$/, anyOf: ['GROUP_ADMINISTRATION', 'MEMBER_MANAGEMENT', 'ROLE_MANAGEMENT', 'FINANCE_MANAGEMENT'] },
  { methods: ['GET'], resource: /^statistics$/, anyOf: ['VIEW_STATISTICS'] },
  { methods: ['POST', 'DELETE'], resource: /^logo$/, anyOf: ['GROUP_ADMINISTRATION'] },
  { methods: ['GET'], resource: /^members$/, anyOf: ['VIEW_MEMBER_DIRECTORY'] },
  { methods: ['PATCH', 'DELETE'], resource: /^members\/[^/]+$/, anyOf: ['MEMBER_MANAGEMENT'] },
  { methods: ['POST'], resource: /^members\/[^/]+\/reactivate$/, anyOf: ['MEMBER_MANAGEMENT'] },
  { methods: ['DELETE'], resource: /^members\/[^/]+\/permanent$/, anyOf: ['MEMBER_MANAGEMENT'] },
  { methods: ['POST'], resource: /^members\/[^/]+\/claim-invitation$/, anyOf: ['MEMBER_MANAGEMENT'] },
  { methods: ['GET', 'PUT'], resource: /^public-join-link$/, anyOf: ['MEMBER_MANAGEMENT'] },
  { methods: ['POST'], resource: /^public-join-link\/rotate$/, anyOf: ['MEMBER_MANAGEMENT'] },
  { methods: ['PATCH'], resource: /^members\/[^/]+\/permissions$/, anyOf: ['MEMBER_MANAGEMENT'] },
  { methods: ['GET'], resource: /^accounts$/, anyOf: ['FINANCE_MANAGEMENT'] },
  { methods: ['GET'], resource: /^accounts\/(?!me$)[^/]+$/, anyOf: ['FINANCE_MANAGEMENT'] },
  { methods: ['GET', 'POST'], resource: /^payments$/, anyOf: ['FINANCE_MANAGEMENT'] },
  { methods: ['POST'], resource: /^payments\/self$/, anyOf: ['RECORD_OWN_PAYMENT'] },
  { methods: ['POST'], resource: /^payments\/[^/]+\/reverse$/, anyOf: ['FINANCE_MANAGEMENT'] },
  { methods: ['GET'], resource: /^periods$/, anyOf: ['FINANCE_MANAGEMENT'] },
  { methods: ['POST'], resource: /^periods\/[^/]+\/close$/, anyOf: ['FINANCE_MANAGEMENT'] },
  { methods: ['GET'], resource: /^periods\/[^/]+\/statements$/, anyOf: ['FINANCE_MANAGEMENT'] },
  { methods: ['GET'], resource: /^settlements$/, anyOf: ['FINANCE_MANAGEMENT'] },
  { methods: ['GET'], resource: /^audit$/, anyOf: ['GROUP_ADMINISTRATION'] },
  { methods: ['GET'], resource: /^audit\/filter-options$/, anyOf: ['GROUP_ADMINISTRATION'] },
  { methods: ['GET'], resource: /^roles$/, anyOf: ['MEMBER_MANAGEMENT', 'ROLE_MANAGEMENT'] },
  { methods: ['GET'], resource: /^roles\/[^/]+$/, anyOf: ['ROLE_MANAGEMENT'] },
  { methods: ['GET'], resource: /^role-assignments$/, anyOf: ['MEMBER_MANAGEMENT'] },
  { methods: ['GET', 'POST'], resource: /^invitations$/, anyOf: ['MEMBER_MANAGEMENT'] },
  { methods: ['POST'], resource: /^invitations\/import$/, anyOf: ['MEMBER_MANAGEMENT'] },
  { methods: ['PATCH', 'DELETE'], resource: /^invitations\/[^/]+$/, anyOf: ['MEMBER_MANAGEMENT'] },
  { methods: ['PUT'], resource: /^invitations\/[^/]+\/roles$/, anyOf: ['MEMBER_MANAGEMENT'] },
  { methods: ['POST'], resource: /^invitations\/[^/]+\/email\/(?:retry|resend)$/, anyOf: ['MEMBER_MANAGEMENT'] },
  { methods: ['POST'], resource: /^categories$/, anyOf: ['CATALOG_MANAGEMENT'] },
  { methods: ['PUT'], resource: /^catalog\/order$/, anyOf: ['CATALOG_MANAGEMENT'] },
  { methods: ['PATCH', 'DELETE'], resource: /^categories\/[^/]+$/, anyOf: ['CATALOG_MANAGEMENT'] },
  { methods: ['POST'], resource: /^categories\/[^/]+\/products$/, anyOf: ['CATALOG_MANAGEMENT'] },
  { methods: ['PATCH', 'DELETE'], resource: /^products\/[^/]+$/, anyOf: ['CATALOG_MANAGEMENT'] },
  { methods: ['POST'], resource: /^products\/[^/]+\/image$/, anyOf: ['CATALOG_MANAGEMENT'] },
];

const clone = <T,>(value: T): T => structuredClone(value);
const identifier = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

interface DemoStatisticsBucketPoint {
  periodStart: string;
  isPartial: boolean;
}

const demoDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses a stable calendar-only demo date without depending on the host timezone. */
function parseDemoCalendarDate(value: string): Date {
  const match = demoDatePattern.exec(value);
  if (!match) throw new Error('A valid demo calendar date is required.');
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

/** Returns the calendar start used by one statistics bucket. */
function floorDemoStatisticsBucket(value: Date, bucket: StatisticsBucket): Date {
  const result = new Date(value);
  if (bucket === 'WEEK') result.setUTCDate(result.getUTCDate() - ((result.getUTCDay() + 6) % 7));
  if (bucket === 'MONTH' || bucket === 'YEAR') result.setUTCDate(1);
  if (bucket === 'YEAR') result.setUTCMonth(0);
  return result;
}

/** Advances one calendar-aligned statistics bucket. */
function nextDemoStatisticsBucket(value: Date, bucket: StatisticsBucket): Date {
  const result = new Date(value);
  if (bucket === 'DAY') result.setUTCDate(result.getUTCDate() + 1);
  if (bucket === 'WEEK') result.setUTCDate(result.getUTCDate() + 7);
  if (bucket === 'MONTH') result.setUTCMonth(result.getUTCMonth() + 1);
  if (bucket === 'YEAR') result.setUTCFullYear(result.getUTCFullYear() + 1);
  return result;
}

/** Returns the last Sunday in a month as a calendar-only UTC value. */
function lastDemoSunday(year: number, month: number): Date {
  const result = new Date(Date.UTC(year, month + 1, 0));
  result.setUTCDate(result.getUTCDate() - result.getUTCDay());
  return result;
}

/** Formats a Europe/Berlin local midnight with its seasonal offset. */
function formatDemoPeriodStart(value: Date): string {
  const year = value.getUTCFullYear();
  const springTransition = lastDemoSunday(year, 2);
  const autumnTransition = lastDemoSunday(year, 9);
  const summerTime = value > springTransition && value <= autumnTransition;
  return `${value.toISOString().slice(0, 10)}T00:00:00${summerTime ? '+02:00' : '+01:00'}`;
}

/** Builds at most 60 aligned buckets and marks clipped boundaries as partial. */
function buildDemoStatisticsBuckets(fromDate: string, toExclusiveDate: string, bucket: StatisticsBucket, endsAtGeneratedTime: boolean): DemoStatisticsBucketPoint[] {
  const from = parseDemoCalendarDate(fromDate);
  const end = parseDemoCalendarDate(toExclusiveDate);
  if (endsAtGeneratedTime) end.setUTCHours(12, 30);
  const points: DemoStatisticsBucketPoint[] = [];
  let cursor = floorDemoStatisticsBucket(from, bucket);
  while (cursor < end && points.length < 60) {
    const next = nextDemoStatisticsBucket(cursor, bucket);
    points.push({
      periodStart: formatDemoPeriodStart(cursor),
      isPartial: cursor < from || next > end,
    });
    cursor = next;
  }
  return points;
}

/** Distributes one exact signed total across buckets with a deterministic trend. */
function distributeDemoTotal(total: number, count: number, seed: number): number[] {
  if (count === 0) return [];
  const sign = total < 0 ? -1 : 1;
  const magnitude = Math.abs(total);
  const weights = Array.from({ length: count }, (_, index) => 1 + ((index * 7 + seed) % 5) + Math.floor((index * 2) / count));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const exact = weights.map((weight) => (magnitude * weight) / weightTotal);
  const values = exact.map(Math.floor);
  const remainder = magnitude - values.reduce((sum, value) => sum + value, 0);
  const remainderOrder = exact.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let index = 0; index < remainder; index += 1) values[remainderOrder[index].index] += 1;
  return values.map((value) => value * sign);
}

function normalizeDemoPlanningTiming(input: Record<string, unknown>, timeZone = 'Europe/Berlin'): Record<string, unknown> {
  const fields = { ...input };
  if (input.allDay === true) {
    delete fields.startsAt;
    delete fields.endsAt;
    const startDate = String(fields.startDate ?? '');
    const endDateExclusive = String(fields.endDateExclusive ?? '');
    return { ...fields, allDay: true, timeZone, startsAt: zonedDateTimeInputToIso(`${startDate}T00:00`, timeZone), endsAt: zonedDateTimeInputToIso(`${endDateExclusive}T00:00`, timeZone) };
  }
  delete fields.startDate;
  delete fields.endDateExclusive;
  return { ...fields, allDay: false, timeZone };
}

function demoPageLimit(value: string | null, fallback = 100): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 200 ? parsed : fallback;
}

async function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsText(blob);
  });
}

/**
 * Resolves the strong catalog version precondition used by demo deletions.
 *
 * @param headers - Request headers containing a quoted `If-Match` version.
 * @returns The positive catalog resource version.
 * @throws Error when the precondition is absent or malformed.
 */
function requiredDemoVersion(headers?: HeadersInit): number {
  const value = new Headers(headers).get('If-Match');
  const match = /^"v([1-9][0-9]*)"$/.exec(value ?? '');
  if (!match) throw new Error(i18n.t('catalog.deleteStaleError'));
  return Number(match[1]);
}

/**
 * Validates a demo wire price against the production product-price bounds.
 *
 * @param value - Integer minor units from a simulated command.
 * @returns Canonical decimal minor units.
 * @throws TypeError when the value is absent, malformed, or non-positive.
 * @throws RangeError when the value exceeds the production limit.
 */
function validateDemoProductPrice(value: string | number | undefined): string {
  let amount: bigint;
  try {
    if (value === undefined) throw new TypeError(i18n.t('errors.amountFormat'));
    amount = BigInt(value);
  } catch {
    throw new TypeError(i18n.t('errors.amountFormat'));
  }
  if (amount <= 0n) throw new TypeError(i18n.t('errors.amountFormat'));
  if (amount > MAX_PRODUCT_PRICE_MINOR) throw new RangeError(i18n.t('errors.amountRange'));
  return amount.toString();
}

interface DemoImportCandidate {
  row: number;
  email: string;
  displayName: string;
  roleNames: string[];
}

/**
 * Parses one flat CSV record for the development-only invitation simulator.
 *
 * @param record - One CSV line without a line ending.
 * @param delimiter - Detected comma or semicolon delimiter.
 * @returns Decoded cells with surrounding whitespace removed.
 */
function parseDemoCsvRecord(record: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < record.length; index += 1) {
    const character = record[index];
    if (character === '"') {
      if (quoted && record[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * Reads the supported member invitation columns for the development demo.
 *
 * @param document - UTF-8 CSV text containing `email` and optional `display_name` columns.
 * @returns Data rows with their original one-based source line numbers.
 * @throws Error when the CSV has no usable header or email column.
 */
function parseDemoMemberCsv(document: string): DemoImportCandidate[] {
  const lines = document.replace(/^\uFEFF/, '').split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim().length > 0);
  if (headerIndex < 0) throw new Error('The CSV file must contain a header row.');
  const delimiter = (lines[headerIndex].match(/;/g)?.length ?? 0) > (lines[headerIndex].match(/,/g)?.length ?? 0) ? ';' : ',';
  const header = parseDemoCsvRecord(lines[headerIndex], delimiter).map((cell) => cell.toLowerCase());
  const emailIndex = header.indexOf('email');
  const displayNameIndex = header.indexOf('display_name');
  const rolesIndex = header.indexOf('roles');
  if (emailIndex < 0) throw new Error('The CSV header must contain an email column.');
  const result: DemoImportCandidate[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    const cells = parseDemoCsvRecord(lines[index], delimiter);
    result.push({
      row: index + 1,
      email: (cells[emailIndex] ?? '').trim().toLowerCase(),
      displayName: displayNameIndex >= 0 ? (cells[displayNameIndex] ?? '').trim() : '',
      roleNames: rolesIndex >= 0 ? (cells[rolesIndex] ?? '').split('|').map((name) => name.trim()).filter(Boolean) : [],
    });
  }
  if (result.length === 0) throw new Error('The CSV file must contain at least one data row.');
  return result;
}

/**
 * In-memory API substitute used exclusively by the development build.
 * It deliberately mirrors the real group-prefixed REST contract.
 */
export class DemoTransport {
  private session = clone(demoSession);
  private categories = clone(demoCategories);
  private members = clone(demoMembers);
  private bookings = clone(demoBookings);
  private dashboard = clone(demoDashboard);
  private ledger = clone(demoLedger);
  private accountSummaries: AccountSummary[] = clone(demoAccountSummaries);
  private payments = clone(demoPayments);
  private paymentAttachments = new Map<string, File>();
  private activityReversals = new Map<string, DemoActivityReversal>();
  private periods = clone(demoPeriods);
  private settlements = clone(demoSettlements);
  private notifications = clone(demoNotifications);
  private audit = clone(demoAudit);
  private roles = clone(demoRoles);
  private planningEvents = clone(demoPlanningEvents) as Array<Record<string, unknown>>;
  private planningSettings = { enabled: true, timeZone: 'Europe/Berlin', version: 1, updatedAt: new Date().toISOString() };
  private assignmentVersions = new Map<string, number>();
  private invitations: InvitationMetadata[] = [];
  private invitationTokens = new Map<string, string>();
  private groupSettings: GroupSettings = {
    defaultTheme: 'TEAMTALER',
    statisticsEnabled: true,
    settlementsEnabled: false,
    settlementDueSoonDays: 3,
    settlementOverdueRepeatDays: 7,
    defaultRoleId: 'role-guest',
    ownBookingReasonMode: 'OFF',
    foreignBookingReasonMode: 'REQUIRED',
    ownPaymentReasonMode: 'REQUIRED',
    otherPaymentReasonMode: 'OPTIONAL',
    foreignBookingReasonRequired: true,
    ownPaymentReasonRequired: true,
    otherPaymentReasonRequired: false,
    paymentMethods: [
      { id: 'BANK_TRANSFER', label: 'Bank transfer', attachmentMode: 'OFF', paymentTarget: null },
      { id: 'SHOPPING', label: 'Shopping', attachmentMode: 'REQUIRED', paymentTarget: null },
      { id: 'CASH', label: 'Cash', attachmentMode: 'OFF', paymentTarget: null },
      { id: 'PAYPAL', label: 'PayPal', attachmentMode: 'OFF', paymentTarget: null },
      { id: 'OTHER', label: 'Other', attachmentMode: 'OPTIONAL', paymentTarget: null },
    ],
    bookingReasons: [],
    paymentReasons: [],
  };
  private publicJoinLink: PublicJoinLink = { enabled: false, expired: false, expiresAt: null, version: 0, emailVerificationAvailable: true };
  private publicJoinToken = '';

  /**
   * Resolves one development request.
   *
   * @param path - API-relative resource path.
   * @param init - Fetch-compatible request options.
   * @returns A cloned response matching the requested API type.
   * @throws Error when the demo endpoint is not implemented.
   */
  async request<T>(path: string, init: DemoRequestInit = {}): Promise<T> {
    await new Promise((resolve) => window.setTimeout(resolve, 90));
    const method = init.method ?? 'GET';
    const contentType = new Headers(init.headers).get('Content-Type')?.toLowerCase() ?? '';
    let body = typeof init.body === 'string'
      ? contentType.startsWith('text/csv') ? init.body : JSON.parse(init.body) as unknown
      : undefined;
    let attachment: File | undefined;
    if (init.body instanceof FormData) {
      const commandPart = init.body.get('command');
      if (commandPart instanceof Blob) body = JSON.parse(await blobText(commandPart)) as unknown;
      else if (typeof commandPart === 'string') body = JSON.parse(commandPart) as unknown;
      const attachmentPart = init.body.get('attachment');
      if (attachmentPart instanceof File) attachment = attachmentPart;
    }
    const requestUrl = new URL(path, window.location.origin);
    const cleanPath = requestUrl.pathname;

    if (cleanPath === '/instance/capabilities' && method === 'GET') return {
      instanceName: 'TeamTaler Demo', maintenanceMode: false, maintenanceMessage: '', publicJoinEnabled: true,
      mediaUploadMaxBytes: 5 * 1024 * 1024, attachmentUploadMaxBytes: 15 * 1024 * 1024,
    } as T;
    if (cleanPath === '/legal-documents' && method === 'GET') return {
      imprint: '# Operator\n\nTeamTaler development demo',
      privacyPolicy: '# Controller\n\nThis development demo stores its sample data only in the current browser session.',
    } as T;
    if (cleanPath === '/auth/capabilities' && method === 'GET') return { passwordResetAvailable: false, emailChangeAvailable: false } as T;
    if (cleanPath === '/me/profile' && method === 'PATCH') {
      const displayName = String((body as { displayName?: unknown }).displayName ?? '').trim();
      if (!displayName) throw new Error('A display name is required.');
      this.session.user.displayName = displayName;
      this.members = this.members.map((member) => member.userId === this.session.user.id ? { ...member, displayName } : member);
      return clone(this.session.user) as T;
    }
    if (cleanPath === '/me/appearance' && method === 'PUT') {
      const colorMode = (body as { colorMode?: unknown }).colorMode;
      if (!isColorMode(colorMode)) throw new Error('The color mode is not supported.');
      this.session.colorMode = colorMode;
      return { colorMode } as T;
    }
    if (cleanPath === '/me/group-preference' && method === 'PUT') {
      const defaultGroupId = (body as { defaultGroupId?: unknown }).defaultGroupId;
      if (defaultGroupId !== null && (typeof defaultGroupId !== 'string' || !this.session.groups.some((group) => group.id === defaultGroupId))) {
        throw new Error('The default group must be an available group or null.');
      }
      this.session.defaultGroupId = defaultGroupId;
      return { defaultGroupId } as T;
    }
    if (cleanPath === '/me/group-preference/last-used' && method === 'PUT') {
      const groupId = String((body as { groupId?: unknown }).groupId ?? '');
      if (!this.session.groups.some((group) => group.id === groupId)) throw new Error('The last-used group must be available.');
      this.session.activeGroupId = groupId;
      return undefined as T;
    }
    if (cleanPath === '/me/password' && method === 'PUT') return undefined as T;
    if (cleanPath === '/session' || cleanPath === '/me') return clone(this.session) as T;
    if (cleanPath === '/permission-definitions' && method === 'GET') return clone(demoPermissionDefinitions) as T;
    if (cleanPath === '/me/avatar' && method === 'POST') {
      const image = init.body instanceof FormData ? init.body.get('image') : undefined;
      if (!(image instanceof Blob)) throw new Error('A profile image is required.');
      if (this.session.user.avatarUrl?.startsWith('blob:')) URL.revokeObjectURL(this.session.user.avatarUrl);
      const avatarUrl = URL.createObjectURL(image);
      this.session.user.avatarUrl = avatarUrl;
      this.members = this.members.map((member) => member.userId === this.session.user.id ? { ...member, avatarUrl } : member);
      return { avatarUrl } as T;
    }
    if (cleanPath === '/me/avatar' && method === 'DELETE') {
      if (this.session.user.avatarUrl?.startsWith('blob:')) URL.revokeObjectURL(this.session.user.avatarUrl);
      delete this.session.user.avatarUrl;
      this.members = this.members.map((member) => {
        if (member.userId !== this.session.user.id) return member;
        const updated = { ...member };
        delete updated.avatarUrl;
        return updated;
      });
      return undefined as T;
    }
    if (cleanPath === '/auth/login' && method === 'POST') return this.login(body as LoginCommand) as T;
    if (cleanPath === '/auth/logout' && method === 'POST') return undefined as T;
    if (cleanPath === '/invitations/preview' && method === 'POST') return this.previewInvitation((body as { token?: string }).token ?? '') as T;
    if ((cleanPath === '/auth/invitations/accept' || cleanPath === '/invitations/accept') && method === 'POST') return this.acceptInvitation(body as InvitationCommand) as T;
    if (cleanPath === '/public-join-links/preview' && method === 'POST') return this.previewPublicJoin((body as { token?: string }).token ?? '') as T;
    if (cleanPath === '/public-join-links/registrations' && method === 'POST') return { verificationRequired: true } as T;
    if (cleanPath === '/public-join-links/registrations/resend' && method === 'POST') return { verificationRequired: true } as T;
    if (cleanPath === '/public-join-links/registrations/confirm' && method === 'POST') return clone(this.session) as T;
    if (cleanPath === '/public-join-links/accept' && method === 'POST') {
      this.previewPublicJoin((body as { token?: string }).token ?? '');
      return clone(this.session) as T;
    }
    if (cleanPath === '/groups') return clone(this.session.groups) as T;

    const groupRootMatch = cleanPath.match(/^\/groups\/([^/]+)$/);
    if (groupRootMatch && method === 'PATCH') {
      this.requirePermission(groupRootMatch[1], 'GROUP_ADMINISTRATION');
      const name = String((body as { name?: string }).name ?? '').trim();
      const containsControlCharacter = [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
      if (!name || name.length > 120 || containsControlCharacter) throw new Error('The group name must contain 1 to 120 characters without control characters.');
      const group = this.session.groups.find((entry) => entry.id === groupRootMatch[1]);
      if (!group) throw new Error('The group does not exist.');
      group.name = name;
      return { name } as T;
    }

    const groupMatch = cleanPath.match(/^\/groups\/([^/]+)\/(.+)$/);
    if (!groupMatch) throw new Error(`Development demo endpoint not implemented: ${method} ${path}`);
    const [, groupId, resource] = groupMatch;
    this.authorizeGroupRoute(groupId, resource, method);

    if (resource === 'statistics' && !this.groupSettings.statisticsEnabled) {
      throw new Error('Statistics are disabled for this group.');
    }

    if (resource === 'statistics' && method === 'GET') {
      const currentPeriodAvailable = this.groupSettings.settlementsEnabled && this.periods.some((period) => period.status === 'OPEN');
      const requestedRange = requestUrl.searchParams.get('range');
      if (requestedRange !== null && !isStatisticsRange(requestedRange)) throw new Error('The statistics range is not supported.');
      const preset = isStatisticsRange(requestedRange)
        ? requestedRange
        : currentPeriodAvailable ? 'CURRENT_PERIOD' : 'LAST_30_DAYS';
      if (preset === 'CURRENT_PERIOD' && !currentPeriodAvailable) throw new Error('The current settlement period is not available.');
      const customFrom = requestUrl.searchParams.get('from');
      const customTo = requestUrl.searchParams.get('to');
      if (preset === 'CUSTOM' && (!/^\d{4}-\d{2}-\d{2}$/.test(customFrom ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(customTo ?? '') || String(customFrom) > String(customTo))) {
        throw new Error('A valid inclusive custom date range is required.');
      }
      if (preset !== 'CUSTOM' && (customFrom !== null || customTo !== null)) throw new Error('Custom dates require the CUSTOM range.');
      if (preset === 'CUSTOM' && String(customFrom) > '2026-08-28') throw new Error('The custom range must start before the generated time.');
      const endDate = new Date(`${customTo ?? '2026-08-28'}T12:00:00Z`);
      endDate.setUTCDate(endDate.getUTCDate() + 1);
      const presetStart: Record<string, string> = {
        CURRENT_PERIOD: '2026-08-01',
        LAST_30_DAYS: '2026-07-30',
        LAST_90_DAYS: '2026-05-31',
        LAST_12_MONTHS: '2025-09-01',
        ALL_TIME: '2024-01-01',
      };
      const fromDate = preset === 'CUSTOM' ? String(customFrom) : presetStart[preset];
      const customEndsBeforeToday = preset === 'CUSTOM' && String(customTo) < '2026-08-28';
      const toExclusiveDate = customEndsBeforeToday ? endDate.toISOString().slice(0, 10) : '2026-08-28';
      const endsAtGeneratedTime = !customEndsBeforeToday;
      const daySpan = Math.ceil((Date.parse(`${toExclusiveDate}T12:00:00Z`) - Date.parse(`${fromDate}T12:00:00Z`)) / 86_400_000) + (endsAtGeneratedTime ? 1 : 0);
      const fromCalendar = new Date(`${fromDate}T12:00:00Z`);
      const toCalendar = new Date(`${toExclusiveDate}T12:00:00Z`);
      const calendarMonths = (toCalendar.getUTCFullYear() - fromCalendar.getUTCFullYear()) * 12 + toCalendar.getUTCMonth() - fromCalendar.getUTCMonth() + 1;
      const bucket = preset === 'LAST_30_DAYS' ? 'DAY'
        : preset === 'LAST_90_DAYS' ? 'WEEK'
        : preset === 'LAST_12_MONTHS' ? 'MONTH'
        : daySpan <= 45 ? 'DAY'
        : daySpan <= 400 ? 'WEEK'
        : calendarMonths <= 60 ? 'MONTH'
        : 'YEAR';
      const meta = {
        ...demoStatisticsWire.meta,
        generatedAt: demoStatisticsWire.meta.generatedAt,
        preset,
        fromInclusive: formatDemoPeriodStart(parseDemoCalendarDate(fromDate)),
        toExclusive: endsAtGeneratedTime ? demoStatisticsWire.meta.generatedAt : formatDemoPeriodStart(parseDemoCalendarDate(toExclusiveDate)),
        bucket,
        currentPeriodAvailable,
      };
      const buckets = buildDemoStatisticsBuckets(fromDate, toExclusiveDate, bucket, endsAtGeneratedTime);
      const postedUnits = distributeDemoTotal(66, buckets.length, 3);
      const reversedUnits = distributeDemoTotal(5, buckets.length, 11);
      const members = {
        ...demoStatisticsWire.members,
        activity: buckets.map((point, index) => ({
          periodStart: point.periodStart,
          postedUnits: postedUnits[index],
          reversedUnits: reversedUnits[index],
        })),
        topCategories: {
          ...demoStatisticsWire.members.topCategories,
          items: demoStatisticsWire.members.topCategories.items.map((item, itemIndex) => {
            const units = distributeDemoTotal(item.validBookedUnits, buckets.length, itemIndex + 17);
            return {
              ...item,
              series: buckets.map((point, index) => ({ ...point, validBookedUnits: units[index], privacySuppressed: false })),
            };
          }),
        },
        topProducts: {
          ...demoStatisticsWire.members.topProducts,
          items: demoStatisticsWire.members.topProducts.items.map((item, itemIndex) => {
            const units = distributeDemoTotal(item.validBookedUnits, buckets.length, itemIndex + 29);
            return {
              ...item,
              series: buckets.map((point, index) => ({ ...point, validBookedUnits: units[index], privacySuppressed: false })),
            };
          }),
        },
      };
      const charges = distributeDemoTotal(Number(demoStatisticsWire.finance.flows.netBookingChargesMinor), buckets.length, 41);
      const payments = distributeDemoTotal(Number(demoStatisticsWire.finance.flows.netPaymentsMinor), buckets.length, 47);
      const adjustments = distributeDemoTotal(Number(demoStatisticsWire.finance.flows.netAdjustmentsMinor), buckets.length, 53);
      let closing = Number(demoStatisticsWire.finance.flows.openingNetReceivableMinor);
      const finance = {
        ...demoStatisticsWire.finance,
        series: buckets.map((point, index) => {
          closing += charges[index] - payments[index] + adjustments[index];
          return {
            periodStart: point.periodStart,
            netBookingChargesMinor: String(charges[index]),
            netPaymentsMinor: String(payments[index]),
            netAdjustmentsMinor: String(adjustments[index]),
            closingNetReceivableMinor: String(closing),
          };
        }),
      };
      return clone({ meta, members, finance }) as T;
    }

    if (resource === 'settings' && method === 'GET') return clone(this.groupSettings) as T;
    if (resource === 'settings' && method === 'PATCH') {
      const update = body as GroupSettingsUpdateInput;
      const updatesDefaultTheme = update.defaultTheme !== undefined;
      const updatesStatistics = update.statisticsEnabled !== undefined;
      const updatesSettlements = update.settlementsEnabled !== undefined;
      const updatesSettlementReminders = update.settlementDueSoonDays !== undefined || update.settlementOverdueRepeatDays !== undefined;
      const updatesDefaultRole = update.defaultRoleId !== undefined;
      const updatesTransactionSettings = update.ownBookingReasonMode !== undefined
        || update.foreignBookingReasonMode !== undefined
        || update.ownPaymentReasonMode !== undefined
        || update.otherPaymentReasonMode !== undefined
        || update.foreignBookingReasonRequired !== undefined
        || update.ownPaymentReasonRequired !== undefined
        || update.otherPaymentReasonRequired !== undefined
        || update.paymentMethods !== undefined
        || update.bookingReasons !== undefined
        || update.paymentReasons !== undefined;
      if (!updatesDefaultTheme && !updatesStatistics && !updatesSettlements && !updatesSettlementReminders && !updatesDefaultRole && !updatesTransactionSettings) throw new Error('At least one group setting is required.');
      if (updatesDefaultTheme) {
        this.requirePermission(groupId, 'GROUP_ADMINISTRATION');
        if (!isThemeId(update.defaultTheme)) throw new Error('The default theme is not supported.');
      }
      if (updatesDefaultRole) {
        this.requireAnyPermission(groupId, ['ROLE_MANAGEMENT', 'GROUP_ADMINISTRATION']);
      }
      if (updatesSettlements || updatesSettlementReminders || updatesTransactionSettings) this.requireAnyPermission(groupId, ['GROUP_ADMINISTRATION', 'FINANCE_MANAGEMENT']);
      if (updatesSettlements && typeof update.settlementsEnabled !== 'boolean') throw new Error('Settlement availability must be a boolean.');
      if (update.settlementDueSoonDays !== undefined && (!Number.isInteger(update.settlementDueSoonDays) || update.settlementDueSoonDays < 1 || update.settlementDueSoonDays > 30)) throw new Error('Settlement due-soon days must be between 1 and 30.');
      if (update.settlementOverdueRepeatDays !== undefined && (!Number.isInteger(update.settlementOverdueRepeatDays) || update.settlementOverdueRepeatDays < 0 || update.settlementOverdueRepeatDays > 90)) throw new Error('Settlement overdue repeat days must be between 0 and 90.');
      if (updatesStatistics) this.requirePermission(groupId, 'GROUP_ADMINISTRATION');
      if (updatesStatistics && typeof update.statisticsEnabled !== 'boolean') throw new Error('Statistics availability must be a boolean.');

      const submittedReasonModes = [update.ownBookingReasonMode, update.foreignBookingReasonMode, update.ownPaymentReasonMode, update.otherPaymentReasonMode].filter((value) => value !== undefined);
      if (submittedReasonModes.some((value) => value !== 'OFF' && value !== 'OPTIONAL' && value !== 'REQUIRED')) throw new Error('Reason modes must be OFF, OPTIONAL, or REQUIRED.');
      if (updatesDefaultRole) {
        const defaultRole = this.roles.find((role) => role.id === update.defaultRoleId);
        if (!defaultRole) throw new Error('The default role does not exist.');
        if (defaultRole.grants.some((grant) => grant.permission === 'GROUP_ADMINISTRATION' || grant.permission === 'MEMBER_MANAGEMENT')) throw new Error('The default role must not grant administration permissions.');
      }
      const foreignBookingReasonMode = update.foreignBookingReasonMode
        ?? (update.foreignBookingReasonRequired === undefined ? this.groupSettings.foreignBookingReasonMode : update.foreignBookingReasonRequired ? 'REQUIRED' : 'OPTIONAL');
      const ownPaymentReasonMode = update.ownPaymentReasonMode
        ?? (update.ownPaymentReasonRequired === undefined ? this.groupSettings.ownPaymentReasonMode : update.ownPaymentReasonRequired ? 'REQUIRED' : 'OPTIONAL');
      const otherPaymentReasonMode = update.otherPaymentReasonMode
        ?? (update.otherPaymentReasonRequired === undefined ? this.groupSettings.otherPaymentReasonMode : update.otherPaymentReasonRequired ? 'REQUIRED' : 'OPTIONAL');
      const paymentMethods = update.paymentMethods?.map<PaymentMethod>((method) => {
        const existingMethod = this.groupSettings.paymentMethods.find((candidate) => candidate.id === method.id);
        const targetWasSubmitted = Object.prototype.hasOwnProperty.call(method, 'paymentTarget');
        return {
          id: method.id,
          label: method.label,
          attachmentMode: method.attachmentMode,
          paymentTarget: targetWasSubmitted ? method.paymentTarget ?? null : existingMethod?.paymentTarget ?? null,
        };
      });
      this.groupSettings = {
        ...this.groupSettings,
        ...(updatesDefaultTheme ? { defaultTheme: update.defaultTheme as GroupSettings['defaultTheme'] } : {}),
        ...(updatesStatistics ? { statisticsEnabled: update.statisticsEnabled as boolean } : {}),
        ...(updatesSettlements ? { settlementsEnabled: update.settlementsEnabled as boolean } : {}),
        ...(update.settlementDueSoonDays !== undefined ? { settlementDueSoonDays: update.settlementDueSoonDays } : {}),
        ...(update.settlementOverdueRepeatDays !== undefined ? { settlementOverdueRepeatDays: update.settlementOverdueRepeatDays } : {}),
        ...(updatesDefaultRole ? { defaultRoleId: update.defaultRoleId as string } : {}),
        ...(update.ownBookingReasonMode !== undefined ? { ownBookingReasonMode: update.ownBookingReasonMode } : {}),
        foreignBookingReasonMode,
        ownPaymentReasonMode,
        otherPaymentReasonMode,
        foreignBookingReasonRequired: foreignBookingReasonMode === 'REQUIRED',
        ownPaymentReasonRequired: ownPaymentReasonMode === 'REQUIRED',
        otherPaymentReasonRequired: otherPaymentReasonMode === 'REQUIRED',
        ...(paymentMethods !== undefined ? { paymentMethods: clone(paymentMethods) } : {}),
        ...(update.bookingReasons !== undefined ? { bookingReasons: clone(update.bookingReasons) } : {}),
        ...(update.paymentReasons !== undefined ? { paymentReasons: clone(update.paymentReasons) } : {}),
      };
      if (updatesDefaultTheme) {
        const group = this.session.groups.find((candidate) => candidate.id === groupId);
        if (group) group.defaultTheme = this.groupSettings.defaultTheme;
      }
      if (updatesStatistics) {
        const group = this.session.groups.find((candidate) => candidate.id === groupId);
        if (group) group.statisticsEnabled = this.groupSettings.statisticsEnabled;
      }
      return clone(this.groupSettings) as T;
    }
    if (resource === 'theme-preference' && method === 'PUT') {
      const sessionGroup = this.session.groups.find((candidate) => candidate.id === groupId);
      const currentMember = this.currentMembership(groupId);
      if (!sessionGroup?.membership || !currentMember) throw new Error('An active group membership is required.');
      const themeOverride = (body as { themeOverride?: unknown }).themeOverride;
      if (themeOverride !== null && !isThemeId(themeOverride)) throw new Error('The theme override is not supported.');
      sessionGroup.membership.themeOverride = themeOverride;
      currentMember.themeOverride = themeOverride;
      return { themeOverride } as T;
    }
    if (resource === 'planning/settings' && method === 'GET') return clone(this.planningSettings) as T;
    if (resource === 'planning/settings' && method === 'PUT') {
      this.requirePermission(groupId, 'GROUP_ADMINISTRATION');
      const enabled = (body as { enabled?: unknown }).enabled;
      if (typeof enabled !== 'boolean') throw new Error('Planning enabled must be boolean.');
      this.planningSettings = { ...this.planningSettings, enabled, version: this.planningSettings.version + 1, updatedAt: new Date().toISOString() };
      const group = this.session.groups.find((entry) => entry.id === groupId);
      if (group) group.planningEnabled = enabled;
      return clone(this.planningSettings) as T;
    }
    if (resource === 'planning/events' && method === 'GET') {
      const from = requestUrl.searchParams.get('from');
      const to = requestUrl.searchParams.get('to');
      const status = requestUrl.searchParams.get('status');
      const cursor = requestUrl.searchParams.get('cursor');
      const limit = demoPageLimit(requestUrl.searchParams.get('limit'));
      const items = this.planningEvents
        .filter((entry) => (!from || String(entry.endsAt ?? entry.startsAt) > from) && (!to || String(entry.startsAt) < to) && (!status || entry.status === status));
      items.sort((left, right) => String(left.startsAt).localeCompare(String(right.startsAt)) || String(left.id).localeCompare(String(right.id)));
      const cursorIndex = cursor ? items.findIndex((entry) => entry.id === cursor) : -1;
      if (cursor && cursorIndex < 0) throw new Error('Planning event cursor is invalid.');
      const page = items.slice(cursorIndex + 1, cursorIndex + 1 + limit + 1);
      const nextCursor = page.length > limit ? String(page[limit - 1].id) : undefined;
      return { items: clone(page.slice(0, limit)), ...(nextCursor ? { nextCursor } : {}) } as T;
    }
    if (resource === 'planning/events' && method === 'POST') {
      const eventInput = body as Record<string, unknown>;
      const now = new Date().toISOString();
      const invited = this.members.filter((member) => member.status === 'ACTIVE').length;
      const event = { ...normalizeDemoPlanningTiming(eventInput), id: identifier('planning-event'), status: 'PUBLISHED', confirmationRevision: 1, version: 1, counts: { invited, yes: 0, maybe: 0, no: 0, pending: eventInput.eventType === 'APPOINTMENT_POLL' ? invited : 0, registered: 0, waitlisted: 0, reconfirmationRequired: 0 }, canEdit: true, canCancel: true, canRespond: false, canViewParticipants: true, createdAt: now, updatedAt: now };
      this.planningEvents.push(event);
      return clone(event) as T;
    }
    const planningEventMatch = resource.match(/^planning\/events\/([^/]+)$/);
    if (planningEventMatch && method === 'GET') {
      const event = this.planningEvents.find((entry) => entry.id === planningEventMatch[1]);
      if (!event) throw new Error('Planning event not found.');
      return clone(event) as T;
    }
    if (planningEventMatch && method === 'PUT') {
      const index = this.planningEvents.findIndex((entry) => entry.id === planningEventMatch[1]);
      if (index < 0) throw new Error('Planning event not found.');
      this.planningEvents[index] = { ...this.planningEvents[index], ...normalizeDemoPlanningTiming(body as Record<string, unknown>), version: Number(this.planningEvents[index].version ?? 1) + 1, updatedAt: new Date().toISOString() };
      return clone(this.planningEvents[index]) as T;
    }
    const planningTransitionMatch = resource.match(/^planning\/events\/([^/]+)\/(publish|close|complete|cancel)$/);
    if (planningTransitionMatch && method === 'POST') {
      const event = this.planningEvents.find((entry) => entry.id === planningTransitionMatch[1]);
      if (!event) throw new Error('Planning event not found.');
      const status = planningTransitionMatch[2] === 'publish' ? 'PUBLISHED' : planningTransitionMatch[2] === 'close' ? 'CLOSED' : planningTransitionMatch[2] === 'complete' ? 'COMPLETED' : 'CANCELLED';
      Object.assign(event, { status, canRespond: status === 'PUBLISHED', version: Number(event.version ?? 1) + 1, updatedAt: new Date().toISOString() });
      return clone(event) as T;
    }
    const planningParticipationMatch = resource.match(/^planning\/events\/([^/]+)\/participation$/);
    if (planningParticipationMatch && method === 'PUT') {
      const event = this.planningEvents.find((entry) => entry.id === planningParticipationMatch[1]);
      if (!event) throw new Error('Planning event not found.');
      const status = String((body as { status?: unknown }).status ?? 'WITHDRAWN');
      event.myParticipation = status === 'WITHDRAWN' ? undefined : { status, effectiveStatus: status, confirmedRevision: event.confirmationRevision, version: 1, updatedAt: new Date().toISOString() };
      event.version = Number(event.version ?? 1) + 1;
      return clone(event) as T;
    }
    const planningParticipantsMatch = resource.match(/^planning\/events\/([^/]+)\/participants$/);
    if (planningParticipantsMatch && method === 'GET') {
      const cursor = requestUrl.searchParams.get('cursor');
      const limit = demoPageLimit(requestUrl.searchParams.get('limit'));
      const activeMembers = this.members.filter((member) => member.status === 'ACTIVE');
      activeMembers.sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
      const participants = activeMembers.map((member) => ({ membershipId: member.id, displayName: member.displayName, avatarUrl: member.avatarUrl, effectiveStatus: 'YES', status: 'YES', confirmedRevision: 1, version: 1, updatedAt: new Date().toISOString() }));
      const cursorIndex = cursor ? participants.findIndex((participant) => participant.membershipId === cursor) : -1;
      if (cursor && cursorIndex < 0) throw new Error('Planning participant cursor is invalid.');
      const page = participants.slice(cursorIndex + 1, cursorIndex + 1 + limit + 1);
      const nextCursor = page.length > limit ? page[limit - 1].membershipId : undefined;
      return { items: clone(page.slice(0, limit)), ...(nextCursor ? { nextCursor } : {}) } as T;
    }
    if (resource === 'public-join-link' && method === 'GET') return clone(this.publicJoinLink) as T;
    if (resource === 'public-join-link' && method === 'PUT') {
      const input = body as { enabled: boolean; expiresAt: string | null };
      const expectedVersion = this.publicJoinLink.version === 0 ? 0 : requiredDemoVersion(init.headers);
      if (expectedVersion !== this.publicJoinLink.version) throw new Error('The public join link changed in another session.');
      if (input.enabled && (!this.publicJoinLink.enabled || this.publicJoinLink.expiresAt && Date.parse(this.publicJoinLink.expiresAt) <= Date.now())) this.publicJoinToken = crypto.randomUUID();
      if (!input.enabled) this.publicJoinToken = '';
      const version = this.publicJoinLink.version + 1;
      const now = new Date().toISOString();
      this.publicJoinLink = {
        enabled: input.enabled,
        expired: false,
        expiresAt: input.enabled ? input.expiresAt : null,
        version,
        emailVerificationAvailable: true,
        createdAt: this.publicJoinLink.createdAt ?? now,
        updatedAt: now,
        ...(input.enabled ? { acceptUrl: `${window.location.origin}/join#token=${encodeURIComponent(this.publicJoinToken)}` } : {}),
      };
      return clone(this.publicJoinLink) as T;
    }
    if (resource === 'public-join-link/rotate' && method === 'POST') {
      const expired = Boolean(this.publicJoinLink.expiresAt && Date.parse(this.publicJoinLink.expiresAt) <= Date.now());
      if (!this.publicJoinLink.enabled || expired || requiredDemoVersion(init.headers) !== this.publicJoinLink.version) throw new Error('The public join link cannot be rotated.');
      this.publicJoinToken = crypto.randomUUID();
      this.publicJoinLink = { ...this.publicJoinLink, version: this.publicJoinLink.version + 1, updatedAt: new Date().toISOString(), acceptUrl: `${window.location.origin}/join#token=${encodeURIComponent(this.publicJoinToken)}` };
      return clone(this.publicJoinLink) as T;
    }
    if (resource === 'dashboard') {
      const dashboard = clone({
        ...this.dashboard,
        recentBookings: this.dashboard.recentBookings.map((booking) => this.bookingWithCurrentIdentities(booking)),
      }) as Record<string, unknown>;
      const canViewStatistics = this.groupSettings.statisticsEnabled && can(this.currentMembership(groupId)?.effectiveGrants, 'VIEW_STATISTICS');
      if (!canViewStatistics) {
        delete dashboard.groupOutstanding;
        dashboard.groupCategoryTotals = [];
      }
      dashboard.planningEnabled = this.planningSettings.enabled;
      dashboard.nextPlanningEvent = this.planningEvents.find((entry) => entry.status === 'PUBLISHED');
      dashboard.openPlanningActionCount = dashboard.nextPlanningEvent ? 1 : 0;
      return dashboard as T;
    }
    if (resource === 'transaction-settings' && method === 'GET') return clone({
      settlementsEnabled: this.groupSettings.settlementsEnabled,
      ownBookingReasonMode: this.groupSettings.ownBookingReasonMode,
      foreignBookingReasonMode: this.groupSettings.foreignBookingReasonMode,
      ownPaymentReasonMode: this.groupSettings.ownPaymentReasonMode,
      otherPaymentReasonMode: this.groupSettings.otherPaymentReasonMode,
      foreignBookingReasonRequired: this.groupSettings.foreignBookingReasonRequired,
      ownPaymentReasonRequired: this.groupSettings.ownPaymentReasonRequired,
      otherPaymentReasonRequired: this.groupSettings.otherPaymentReasonRequired,
      paymentMethods: this.groupSettings.paymentMethods,
      bookingReasons: this.groupSettings.bookingReasons,
      paymentReasons: this.groupSettings.paymentReasons,
    }) as T;
    if (resource === 'booking-context' && method === 'GET') {
      const actor = this.currentMembership(groupId);
      if (!actor) throw new Error(i18n.t('errors.memberNotFound'));
      const canBookOwn = can(actor.effectiveGrants, 'CREATE_OWN_BOOKING');
      const canBookOthers = can(actor.effectiveGrants, 'BOOK_FOR_OTHERS');
      const canBookForGuests = can(actor.effectiveGrants, 'BOOK_FOR_GUESTS');
      const targets = this.members
        .filter((member) => member.active && (member.id === actor.id ? canBookOwn : member.isTemporaryGuest ? canBookForGuests : canBookOthers))
        .map((member) => ({ membershipId: member.id, displayName: member.displayName, avatarUrl: member.avatarUrl, isTemporaryGuest: member.isTemporaryGuest }));
      return clone({
        openPeriod: this.dashboard.currentPeriod,
        ownBalanceMinor: this.dashboard.openBalance.minorUnits,
        currentMembership: actor,
        targets,
        canBookForGuests,
        ownBookingReasonMode: this.groupSettings.ownBookingReasonMode,
        foreignBookingReasonMode: this.groupSettings.foreignBookingReasonMode,
        foreignBookingReasonRequired: this.groupSettings.foreignBookingReasonRequired,
        bookingReasons: this.groupSettings.bookingReasons,
      }) as T;
    }
    if (resource === 'members' && method === 'GET') return clone(this.members.filter((member) => member.status !== 'DELETED')) as T;
    if (resource === 'categories' && method === 'GET') return clone(this.categories) as T;
    if (resource === 'activities/filter-options' && method === 'GET') {
      const activities = this.listActivities(groupId, new URLSearchParams());
      const members = new Map<string, ActivityFilterOptions['members'][number]>();
      const categories = new Map<string, ActivityFilterOptions['categories'][number]>();
      const products = new Map<string, ActivityFilterOptions['products'][number]>();
      const kinds = new Set<ActivityFilterOptions['kinds'][number]>();
      for (const activity of activities) {
        kinds.add(activity.kind);
        members.set(activity.targetMembershipId, {
          membershipId: activity.targetMembershipId,
          displayName: activity.targetDisplayName,
          avatarUrl: activity.targetAvatarUrl,
        });
        if (!activity.categoryId || !activity.categoryName) continue;
        const category = this.categories.find((entry) => entry.id === activity.categoryId);
        categories.set(activity.categoryId, {
          categoryId: activity.categoryId,
          name: category?.name ?? activity.categoryName,
          icon: category?.icon ?? 'other',
        });
        if (!activity.productId) continue;
        const product = category?.products.find((entry) => entry.id === activity.productId);
        products.set(activity.productId, {
          productId: activity.productId,
          categoryId: activity.categoryId,
          name: product?.name ?? activity.detailName,
          imageUrl: product?.imageUrl,
        });
      }
      const collator = new Intl.Collator('de-DE', { numeric: true, sensitivity: 'base' });
      const options: ActivityFilterOptions = {
        kinds: (['BOOKING', 'PAYMENT', 'REVERSAL', 'ADJUSTMENT'] as const).filter((kind) => kinds.has(kind)),
        members: [...members.values()].sort((left, right) => collator.compare(left.displayName, right.displayName)),
        categories: [...categories.values()].sort((left, right) => collator.compare(left.name, right.name)),
        products: [...products.values()].sort((left, right) => collator.compare(left.name, right.name)),
      };
      return clone(options) as T;
    }
    if (resource === 'activities' && method === 'GET') return this.listActivities(groupId, requestUrl.searchParams) as T;
    if (resource === 'bookings/filter-options' && method === 'GET') {
      const members = [...new Map(this.listBookings(groupId).map((booking) => [booking.memberId, {
        membershipId: booking.memberId,
        displayName: booking.memberName,
        avatarUrl: booking.memberAvatarUrl,
      }])).values()].sort((left, right) => left.displayName.localeCompare(right.displayName, 'de-DE'));
      return clone({ members }) as T;
    }
    if (resource === 'bookings' && method === 'GET') return this.listBookings(groupId) as T;
    if (resource === 'bookings' && method === 'POST') return this.createBooking(groupId, body as BookingCommand) as T;
    if (resource === 'bookings/batch' && method === 'POST') return this.createBookingBatch(groupId, body as BookingBatchCommand & { unitPriceMinor?: number }) as T;
    if (resource === 'bookings/bulk' && method === 'POST') return this.createBookingBulk(groupId, body as BookingBulkCommand & { items: Array<BookingBulkCommand['items'][number] & { unitPriceMinor?: number }> }) as T;
    if (resource === 'accounts/me') return clone(this.ledger) as T;
    if (resource === 'accounts' && method === 'GET') return clone(this.accountSummaries.filter((account) => account.status !== 'DELETED' || BigInt(account.balance.minorUnits) !== 0n)) as T;
    if (resource === 'payments' && method === 'GET') return clone(this.payments) as T;
    if (resource === 'payments' && method === 'POST') return this.createPayment(body as PaymentCommand, this.groupSettings.otherPaymentReasonMode, attachment) as T;
    if (resource === 'payments/self' && method === 'POST') return this.createOwnPayment(groupId, body as SelfPaymentCommand & { amountMinor?: number }, attachment) as T;
    const paymentAttachmentMatch = resource.match(/^payments\/([^/]+)\/attachment$/);
    if (paymentAttachmentMatch && method === 'GET') {
      const payment = this.payments.find((entry) => entry.id === paymentAttachmentMatch[1]);
      const currentMember = this.currentMembership(groupId);
      const canRead = payment && currentMember && (payment.membershipId === currentMember.id || can(currentMember.effectiveGrants, 'FINANCE_MANAGEMENT'));
      const file = canRead ? this.paymentAttachments.get(payment.id) : undefined;
      if (!file) throw new Error('Payment receipt not found.');
      return file.slice(0, file.size, file.type) as T;
    }
    if (resource === 'periods' && method === 'GET') return clone(this.periods) as T;
    if (resource === 'settlements' && method === 'GET') return clone(this.settlements) as T;
    if (resource === 'notifications' && method === 'GET') return clone(this.notifications) as T;
    if (resource === 'notifications/summary' && method === 'GET') return { unreadCount: this.notifications.filter((entry) => !entry.readAt).length } as T;
    if (resource === 'notifications/read' && method === 'PATCH') {
      const ids = (body as { notificationIds?: string[] }).notificationIds ?? [];
      const readAt = new Date().toISOString();
      this.notifications.forEach((entry) => { if (ids.includes(entry.id)) entry.readAt = readAt; });
      return { readAt, unreadCount: this.notifications.filter((entry) => !entry.readAt).length } as T;
    }
    if (resource === 'audit' && method === 'GET') return clone(this.audit) as T;
    if (resource === 'audit/filter-options' && method === 'GET') {
      const actionResourceTypes = this.audit.reduce<Record<string, string[]>>((result, entry) => {
        const related = result[entry.action] ?? [];
        if (!related.includes(entry.resourceType)) related.push(entry.resourceType);
        result[entry.action] = related;
        return result;
      }, {});
      const actorNames = new Set(this.audit.map((entry) => entry.actorName));
      const options: AuditFilterOptions = {
        actions: [...new Set(this.audit.map((entry) => entry.action))].sort(),
        actors: this.members.filter((member) => actorNames.has(member.displayName)).map((member) => ({ membershipId: member.id, displayName: member.displayName, avatarUrl: member.avatarUrl })),
        resourceTypes: [...new Set(this.audit.map((entry) => entry.resourceType))].sort(),
        actionResourceTypes,
      };
      return clone(options) as T;
    }
    if (resource === 'roles' && method === 'GET') return clone(this.recountedRoles()) as T;
    if (resource === 'roles' && method === 'POST') {
      this.requirePermission(groupId, 'ROLE_MANAGEMENT');
      return this.createRole(groupId, body as RoleInput) as T;
    }
    if (resource === 'role-assignments' && method === 'GET') return this.roleAssignments() as T;
    if (resource === 'invitations/import' && method === 'POST') {
      const roleIds = new URL(path, window.location.origin).searchParams.getAll('roleId');
      return this.importInvitations(body as string, roleIds) as T;
    }
    if (resource === 'invitations' && method === 'GET') return this.listInvitations() as T;
    if (resource === 'invitations' && method === 'POST') return this.createInvitation(groupId, body as InvitationInput & { categoryGrants?: Record<string, string[]>; expiresInDays?: number }) as T;
    if (resource === 'catalog/order' && method === 'PUT') return this.reorderCatalog(body as CatalogOrderCommand) as T;
    if (resource === 'categories' && method === 'POST') return this.createCategory(body as Partial<Category>) as T;
    if (resource === 'logo' && method === 'POST') {
      const image = init.body instanceof FormData ? init.body.get('image') : undefined;
      const logoUrl = image instanceof Blob ? URL.createObjectURL(image) : '';
      const group = this.session.groups.find((entry) => entry.id === groupId);
      if (group) group.logoUrl = logoUrl;
      return { logoUrl } as T;
    }
    if (resource === 'logo' && method === 'DELETE') {
      const group = this.session.groups.find((entry) => entry.id === groupId);
      if (group) delete group.logoUrl;
      return undefined as T;
    }

    const permissionMatch = resource.match(/^members\/([^/]+)\/permissions$/);
    if (permissionMatch && method === 'PATCH') return this.updatePermissions(groupId, permissionMatch[1], body as PermissionUpdate & { categoryGrants?: Record<string, string[]> }, requiredDemoVersion(init.headers)) as T;
    const memberRolesMatch = resource.match(/^members\/([^/]+)\/roles$/);
    if (memberRolesMatch && method === 'PUT') return this.updateRoleAssignment(groupId, 'MEMBERSHIP', memberRolesMatch[1], (body as { roleIds?: string[] }).roleIds ?? [], requiredDemoVersion(init.headers)) as T;
    const memberClaimMatch = resource.match(/^members\/([^/]+)\/claim-invitation$/);
    if (memberClaimMatch && method === 'POST') {
      const member = this.members.find((entry) => entry.id === memberClaimMatch[1] && entry.active && entry.isTemporaryGuest && entry.email === null);
      if (!member) throw new Error('A temporary guest is required.');
      const input = body as { email?: string; roleIds?: string[] };
      const email = String(input.email ?? '').trim().toLowerCase();
      const roleIds = [...new Set(input.roleIds ?? [])];
      if (roleIds.length === 0) throw new Error('At least one role is required.');
      const invitation = this.createInvitation(groupId, {
        email,
        displayName: member.displayName,
        roleIds,
        roles: ['MEMBER'],
        groupPermissions: [],
        categoryPermissions: [],
      });
      invitation.targetMembershipId = member.id;
      const stored = this.invitations.find((entry) => entry.id === invitation.id);
      if (stored) stored.targetMembershipId = member.id;
      return clone(invitation) as T;
    }
    const memberReactivateMatch = resource.match(/^members\/([^/]+)\/reactivate$/);
    if (memberReactivateMatch && method === 'POST') {
      return this.reactivateMember(groupId, memberReactivateMatch[1], body as MemberReactivationCommand) as T;
    }
    const memberPermanentMatch = resource.match(/^members\/([^/]+)\/permanent$/);
    if (memberPermanentMatch && method === 'DELETE') {
      return this.permanentlyDeleteMember(memberPermanentMatch[1]) as T;
    }
    const memberMatch = resource.match(/^members\/([^/]+)$/);
    if (memberMatch && method === 'PATCH') {
      const member = this.members.find((entry) => entry.id === memberMatch[1] && entry.active && entry.isTemporaryGuest && entry.email === null);
      const displayName = String((body as { displayName?: string }).displayName ?? '').trim().replace(/\s+/g, ' ');
      if (!member || !displayName || [...displayName].length > 120 || /\p{Cc}/u.test(displayName)) throw new Error('A valid temporary guest display name is required.');
      member.displayName = displayName;
      member.initials = displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
      return clone(member) as T;
    }
    if (memberMatch && method === 'DELETE') {
      const confirmSelf = new URL(path, window.location.origin).searchParams.get('confirmSelf') === 'true';
      return this.archiveMember(groupId, memberMatch[1], confirmSelf) as T;
    }
    const categoryUpdateMatch = resource.match(/^categories\/([^/]+)$/);
    if (categoryUpdateMatch && method === 'PATCH') return this.updateCategory(categoryUpdateMatch[1], body as Pick<Category, 'name' | 'icon' | 'active' | 'sortOrder' | 'version'>) as T;
    if (categoryUpdateMatch && method === 'DELETE') return this.deleteCategory(categoryUpdateMatch[1], requiredDemoVersion(init.headers)) as T;
    const bookingReversalMatch = resource.match(/^bookings\/([^/]+)\/(?:reversal|void)$/);
    if (bookingReversalMatch && method === 'POST') return this.reverseBooking(groupId, bookingReversalMatch[1], String((body as { reason?: string }).reason ?? '')) as T;
    const periodCloseMatch = resource.match(/^periods\/([^/]+)\/close$/);
    if (periodCloseMatch && method === 'POST') return this.closePeriod(periodCloseMatch[1], body as { label: string; dueAt: string }) as T;
    const notificationMatch = resource.match(/^notifications\/([^/]+)$/);
    if (notificationMatch && method === 'PATCH') return this.markNotificationRead(notificationMatch[1]) as T;
    const paymentReverseMatch = resource.match(/^payments\/([^/]+)\/reverse$/);
    if (paymentReverseMatch && method === 'POST') {
      return this.reversePayment(groupId, paymentReverseMatch[1], String((body as { reason?: string }).reason ?? '')) as T;
    }
    const productCreateMatch = resource.match(/^categories\/([^/]+)\/products$/);
    if (productCreateMatch && method === 'POST') {
      const input = body as { name?: string; priceMinor?: number; pricingMode?: Product['pricingMode']; sortOrder?: number };
      const pricingMode = input.pricingMode === 'USER_DEFINED' ? 'USER_DEFINED' : 'FIXED';
      if (pricingMode === 'USER_DEFINED' && input.priceMinor !== undefined) throw new Error(i18n.t('errors.amountFormat'));
      const fixedPriceMinor = pricingMode === 'FIXED' ? validateDemoProductPrice(input.priceMinor) : undefined;
      return this.createProduct({
        categoryId: productCreateMatch[1],
        name: input.name,
        pricingMode,
        currency: 'EUR',
        price: fixedPriceMinor ? { minorUnits: fixedPriceMinor, currency: 'EUR' } : undefined,
        sortOrder: input.sortOrder,
      } as Partial<Product>) as T;
    }
    const productUpdateMatch = resource.match(/^products\/([^/]+)$/);
    if (productUpdateMatch && method === 'PATCH') {
      const input = body as { name: string; priceMinor?: number; pricingMode: Product['pricingMode']; active: boolean; sortOrder: number; version: number };
      const pricingMode = input.pricingMode === 'USER_DEFINED' ? 'USER_DEFINED' : 'FIXED';
      if (pricingMode === 'USER_DEFINED' && input.priceMinor !== undefined) throw new Error(i18n.t('errors.amountFormat'));
      const fixedPriceMinor = pricingMode === 'FIXED' ? validateDemoProductPrice(input.priceMinor) : undefined;
      return this.updateProduct(productUpdateMatch[1], {
        ...input,
        pricingMode,
        price: fixedPriceMinor ? { minorUnits: fixedPriceMinor, currency: 'EUR' } : undefined,
      }) as T;
    }
    if (productUpdateMatch && method === 'DELETE') return this.deleteProduct(productUpdateMatch[1], requiredDemoVersion(init.headers)) as T;
    const productImageMatch = resource.match(/^products\/([^/]+)\/image$/);
    if (productImageMatch && method === 'POST') return { imageUrl: '' } as T;
    const invitationEmailRetryMatch = resource.match(/^invitations\/([^/]+)\/email\/retry$/);
    if (invitationEmailRetryMatch && method === 'POST') return this.retryInvitationEmail(invitationEmailRetryMatch[1]) as T;
    const invitationEmailResendMatch = resource.match(/^invitations\/([^/]+)\/email\/resend$/);
    if (invitationEmailResendMatch && method === 'POST') return this.resendInvitationEmail(invitationEmailResendMatch[1]) as T;
    const invitationRolesMatch = resource.match(/^invitations\/([^/]+)\/roles$/);
    if (invitationRolesMatch && method === 'PUT') return this.updateRoleAssignment(groupId, 'INVITATION', invitationRolesMatch[1], (body as { roleIds?: string[] }).roleIds ?? [], requiredDemoVersion(init.headers)) as T;
    const roleMatch = resource.match(/^roles\/([^/]+)$/);
    if (roleMatch && method === 'GET') {
      const role = this.recountedRoles().find((entry) => entry.id === roleMatch[1]);
      if (!role) throw new Error('Role not found.');
      return clone(role) as T;
    }
    if (roleMatch && method === 'PUT') return this.updateRole(groupId, roleMatch[1], body as RoleInput, requiredDemoVersion(init.headers)) as T;
    if (roleMatch && method === 'DELETE') return this.deleteRole(groupId, roleMatch[1], requiredDemoVersion(init.headers)) as T;
    const invitationMatch = resource.match(/^invitations\/([^/]+)$/);
    if (invitationMatch && method === 'PATCH') return this.updateInvitation(groupId, invitationMatch[1], body as Omit<InvitationInput, 'email'> & { categoryGrants?: Record<string, string[]> }, init.headers) as T;
    if (invitationMatch && method === 'DELETE') return this.revokeInvitation(invitationMatch[1]) as T;

    throw new Error(`Development demo endpoint not implemented: ${method} ${path}`);
  }

  private login(command: LoginCommand): Session {
    if (!command.email.includes('@') || command.password.length < 8) {
      throw new Error(i18n.t('errors.invalidDemoCredentials'));
    }
    const activeGroupId = this.session.defaultGroupId ?? this.session.activeGroupId ?? this.session.groups[0]?.id ?? '';
    this.session.activeGroupId = activeGroupId;
    return clone(this.session);
  }

  private acceptInvitation(command: InvitationCommand): Session {
    const invitationId = [...this.invitationTokens].find(([, token]) => token === command.token)?.[0];
    const invitation = this.invitations.find((item) => item.id === invitationId);
    if (invitation) {
      const accountExists = this.members.some((member) => member.email?.toLowerCase() === invitation.email.toLowerCase());
      if ((command.expectedAccountState === 'EXISTING') !== accountExists) {
        throw new Error(i18n.t('auth.invitationAccountStateChanged'));
      }
      invitation.acceptedAt = new Date().toISOString();
      this.invitationTokens.delete(invitation.id);
      const claimedMember = invitation.targetMembershipId
        ? this.members.find((member) => member.id === invitation.targetMembershipId && member.active && member.isTemporaryGuest)
        : undefined;
      if (claimedMember) {
        claimedMember.email = invitation.email;
        claimedMember.displayName = command.displayName || claimedMember.displayName;
        claimedMember.initials = claimedMember.displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
        claimedMember.isTemporaryGuest = false;
        claimedMember.roles = invitation.roles;
        claimedMember.roleIds = this.normalizedRoleIds(invitation.roleIds ?? []);
        claimedMember.groupPermissions = invitation.groupPermissions;
        claimedMember.categoryPermissions = invitation.categoryPermissions;
        this.syncMemberPermissions(claimedMember);
        this.session.user.displayName = claimedMember.displayName;
        return clone(this.session);
      }
      const archivedMember = this.members.find((member) => !member.active && member.email?.toLowerCase() === invitation.email.toLowerCase());
      if (archivedMember) {
        archivedMember.active = true;
        archivedMember.roles = invitation.roles;
        archivedMember.roleIds = this.normalizedRoleIds(invitation.roleIds ?? []);
        archivedMember.groupPermissions = invitation.groupPermissions;
        archivedMember.categoryPermissions = invitation.categoryPermissions;
        this.syncMemberPermissions(archivedMember);
      } else {
        this.session.user.displayName = command.displayName;
      }
    }
    return clone(this.session);
  }

  private previewInvitation(token: string): InvitationPreview {
    const invitationId = [...this.invitationTokens].find(([, candidate]) => candidate === token)?.[0];
    const invitation = this.invitations.find((item) => item.id === invitationId && !item.acceptedAt && !item.revokedAt);
    if (!invitation || Date.parse(invitation.expiresAt) <= Date.now()) throw new Error('Invitation is invalid or expired.');
    const account = this.members.find((member) => member.email?.toLowerCase() === invitation.email.toLowerCase());
    return { displayName: invitation.displayName ?? account?.displayName ?? '', accountState: account ? 'EXISTING' : 'NEW' };
  }

  /** Resolves safe demo metadata for the current public join token. */
  private previewPublicJoin(token: string): PublicJoinPreview {
    if (!this.publicJoinLink.enabled || token !== this.publicJoinToken || this.publicJoinLink.expiresAt && Date.parse(this.publicJoinLink.expiresAt) <= Date.now()) throw new Error('Public join link is invalid or expired.');
    const groupName = this.session.groups[0]?.name ?? 'TeamTaler Demo Club';
    return { groupName, expiresAt: this.publicJoinLink.expiresAt };
  }

  /** Returns the signed-in membership for one demo group. */
  private currentMembership(groupId: string): Membership | undefined {
    const membershipId = this.session.groups.find((group) => group.id === groupId)?.membership?.id;
    return this.members.find((member) => member.id === membershipId && member.active);
  }

  /** Rejects a demo request when the active membership lacks a stable permission. */
  private requirePermission(groupId: string, permission: PermissionKey): void {
    this.requireAnyPermission(groupId, [permission]);
  }

  /** Rejects a demo request unless at least one accepted permission is effective. */
  private requireAnyPermission(groupId: string, permissions: readonly PermissionKey[]): void {
    const grants = this.currentMembership(groupId)?.effectiveGrants;
    if (!permissions.some((permission) => can(grants, permission))) throw new Error(i18n.t('admin.noAccessMessage'));
  }

  /** Applies the centralized production-equivalent policy for protected routes. */
  private authorizeGroupRoute(groupId: string, resource: string, method: string): void {
    const policy = DEMO_ROUTE_POLICIES.find((candidate) => candidate.methods.includes(method) && candidate.resource.test(resource));
    if (policy) this.requireAnyPermission(groupId, policy.anyOf);
  }

  /** Produces unique direct grants for a complete set of role IDs. */
  private grantsForRoleIds(roleIds: readonly string[]): PermissionGrant[] {
    const keys = new Set<PermissionKey>();
    for (const role of this.roles) {
      if (!roleIds.includes(role.id)) continue;
      role.grants.forEach((grant) => keys.add(grant.permission));
    }
    return [...keys].map((permission) => ({ permission, scope: { type: 'GROUP' } }));
  }

  /** Keeps a membership and matching session summary consistent after assignment changes. */
  private syncMemberPermissions(member: Membership): void {
    member.effectiveGrants = this.grantsForRoleIds(member.roleIds ?? []);
    member.roles = this.legacyRolesForRoleIds(member.roleIds ?? []);
    member.groupPermissions = member.roleIds?.includes('role-self-payment') ? ['SELF_RECORD_PAYMENT'] : [];
    const sessionGroup = this.session.groups.find((group) => group.membership?.id === member.id);
    if (sessionGroup?.membership) {
      sessionGroup.membership.roleIds = [...(member.roleIds ?? [])];
      sessionGroup.membership.effectiveGrants = clone(member.effectiveGrants);
      sessionGroup.membership.roles = [...member.roles];
      sessionGroup.membership.groupPermissions = [...member.groupPermissions];
    }
  }

  /** Derives deprecated role strings from the protected admin identity and effective grants. */
  private legacyRolesForRoleIds(roleIds: readonly string[]): Membership['roles'] {
    const roles = new Set<Membership['roles'][number]>();
    const assigned = this.roles.filter((role) => roleIds.includes(role.id));
    if (assigned.some((role) => role.presetKey === 'GROUP_ADMINISTRATOR')) roles.add('ADMIN');
    const grants = this.grantsForRoleIds(roleIds);
    if (grants.some((grant) => grant.permission === 'CATALOG_MANAGEMENT')) roles.add('CATALOG_MANAGER');
    if (grants.some((grant) => grant.permission === 'FINANCE_MANAGEMENT')) roles.add('FINANCE_MANAGER');
    return [...roles] as Membership['roles'];
  }

  /** Replaces legacy compatibility assignments while preserving ordinary dynamic roles. */
  private roleIdsForLegacyUpdate(currentRoleIds: readonly string[], roles: readonly Membership['roles'][number][], groupPermissions: readonly string[]): string[] {
    const legacyRoleIds = new Map<Membership['roles'][number], string>([
      ['ADMIN', 'role-admin'],
      ['FINANCE_MANAGER', 'role-finance'],
      ['CATALOG_MANAGER', 'role-catalog'],
    ]);
    const migrationRole = this.roles.find((role) => role.id === 'role-self-payment');
    const managedRoleIds = new Set(legacyRoleIds.values());
    const preservedCustom = currentRoleIds.filter((roleId) => {
      const role = this.roles.find((entry) => entry.id === roleId);
      return role && !managedRoleIds.has(role.id) && role.id !== migrationRole?.id;
    });
    const compatibilityRoleIds = roles.flatMap((legacyRole) => {
      const roleId = legacyRoleIds.get(legacyRole);
      return roleId && this.roles.some((role) => role.id === roleId) ? [roleId] : [];
    });
    const selfPaymentRoleIds = groupPermissions.includes('SELF_RECORD_PAYMENT') && migrationRole ? [migrationRole.id] : [];
    return this.normalizedRoleIds([...preservedCustom, ...compatibilityRoleIds, ...selfPaymentRoleIds]);
  }

  /** Normalizes an explicit role selection to unique, known identifiers. */
  private normalizedRoleIds(roleIds: readonly string[]): string[] {
    const known = new Set(this.roles.map((role) => role.id));
    return [...new Set(roleIds.filter((roleId) => known.has(roleId)))];
  }

  /** Reports whether any selected role grants protected group administration. */
  private roleIdsGrantGroupAdministration(roleIds: readonly string[]): boolean {
    return roleIds.some((roleId) => this.roles.find((role) => role.id === roleId)?.grants.some((grant) => grant.permission === 'GROUP_ADMINISTRATION'));
  }

  /** Returns dynamic role assignment counters without storing redundant values. */
  private recountedRoles(): Role[] {
    const pending = this.invitations.filter((invitation) => !invitation.acceptedAt && !invitation.revokedAt && Date.parse(invitation.expiresAt) > Date.now());
    return this.roles.map((role) => ({
      ...role,
      memberCount: this.members.filter((member) => member.active && member.roleIds?.includes(role.id)).length,
      pendingInvitationCount: pending.filter((invitation) => invitation.roleIds?.includes(role.id)).length,
    }));
  }

  /** Returns every active member and pending invitation assignment. */
  private roleAssignments(): RoleAssignment[] {
    const members: RoleAssignment[] = this.members.filter((member) => member.active).map((member) => ({
      subjectType: 'MEMBERSHIP',
      subjectId: member.id,
      roleIds: [...(member.roleIds ?? [])],
      version: this.assignmentVersions.get(`MEMBERSHIP:${member.id}`) ?? 1,
    }));
    const invitations: RoleAssignment[] = this.invitations.filter((invitation) => !invitation.acceptedAt && !invitation.revokedAt && Date.parse(invitation.expiresAt) > Date.now()).map((invitation) => ({
      subjectType: 'INVITATION',
      subjectId: invitation.id,
      roleIds: [...(invitation.roleIds ?? [])],
      version: this.assignmentVersions.get(`INVITATION:${invitation.id}`) ?? invitation.roleAssignmentsVersion,
    }));
    return clone([...members, ...invitations]);
  }

  /** Creates a validated custom demo role. */
  private createRole(groupId: string, input: RoleInput): Role {
    const name = input.name.trim();
    if (!name || this.roles.some((role) => role.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)) throw new Error('A unique role name is required.');
    if (input.grants.some((grant) => grant.scope.type !== 'GROUP')) throw new Error('Only group-scoped grants are enabled.');
    if (input.grants.some((grant) => grant.permission === 'GROUP_ADMINISTRATION')) this.requirePermission(groupId, 'GROUP_ADMINISTRATION');
    const role: Role = { id: identifier('role'), groupId, name, description: input.description?.trim() || undefined, nameLocked: false, deletable: true, grants: clone(input.grants), version: 1, memberCount: 0, pendingInvitationCount: 0 };
    this.roles.push(role);
    return clone(role);
  }

  /** Updates one role while preserving protected administrator invariants. */
  private updateRole(groupId: string, roleId: string, input: RoleInput, version: number): Role {
    this.requirePermission(groupId, 'ROLE_MANAGEMENT');
    const role = this.roles.find((entry) => entry.id === roleId);
    if (!role) throw new Error('Role not found.');
    if (role.version !== version) throw new Error('The role changed in another session.');
    const name = input.name.trim();
    if (!name || this.roles.some((entry) => entry.id !== roleId && entry.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)) throw new Error('A unique role name is required.');
    const changesAdministration = role.grants.some((grant) => grant.permission === 'GROUP_ADMINISTRATION') !== input.grants.some((grant) => grant.permission === 'GROUP_ADMINISTRATION');
    if (role.presetKey === 'GROUP_ADMINISTRATOR') {
      ADMIN_CORE.forEach((permission) => this.requirePermission(groupId, permission));
    } else if (changesAdministration) {
      this.requirePermission(groupId, 'GROUP_ADMINISTRATION');
    }
    if (role.nameLocked && name !== role.name) throw new Error('This role name is protected.');
    if (role.presetKey === 'GROUP_ADMINISTRATOR') {
      if (name !== role.name) throw new Error('The group administrator role cannot be renamed.');
      if (!ADMIN_CORE.every((permission) => input.grants.some((grant) => grant.permission === permission))) throw new Error('Administrator core permissions cannot be removed.');
    }
    if (this.groupSettings.defaultRoleId === roleId && input.grants.some((grant) => grant.permission === 'GROUP_ADMINISTRATION' || grant.permission === 'MEMBER_MANAGEMENT')) throw new Error('The default role must not grant administration permissions.');
    role.name = name;
    role.description = input.description?.trim() || undefined;
    role.grants = clone(input.grants);
    role.version += 1;
    this.members.filter((member) => member.active && member.roleIds?.includes(role.id)).forEach((member) => this.syncMemberPermissions(member));
    return clone(this.recountedRoles().find((entry) => entry.id === roleId) as Role);
  }

  /** Deletes an unused non-reserved role. */
  private deleteRole(groupId: string, roleId: string, version: number): void {
    this.requirePermission(groupId, 'ROLE_MANAGEMENT');
    const role = this.recountedRoles().find((entry) => entry.id === roleId);
    if (!role) throw new Error('Role not found.');
    if (role.version !== version) throw new Error('The role changed in another session.');
    if (role.deletable === false) throw new Error('This reserved role cannot be deleted.');
    if (role.memberCount > 0 || role.pendingInvitationCount > 0) throw new Error(`Role is assigned to ${role.memberCount} members and ${role.pendingInvitationCount} invitations.`);
    if (this.groupSettings.defaultRoleId === roleId) throw new Error('The default role cannot be deleted.');
    this.roles = this.roles.filter((entry) => entry.id !== roleId);
  }

  /** Replaces a member or invitation role set atomically. */
  private updateRoleAssignment(groupId: string, subjectType: RoleAssignment['subjectType'], subjectId: string, roleIds: string[], expectedVersion: number): RoleAssignment {
    this.requirePermission(groupId, 'MEMBER_MANAGEMENT');
    const key = `${subjectType}:${subjectId}`;
    const invitation = subjectType === 'INVITATION'
      ? this.invitations.find((entry) => entry.id === subjectId && !entry.acceptedAt && !entry.revokedAt && Date.parse(entry.expiresAt) > Date.now())
      : undefined;
    const currentVersion = this.assignmentVersions.get(key) ?? invitation?.roleAssignmentsVersion ?? 1;
    if (currentVersion !== expectedVersion) throw new Error('The role assignment changed in another session.');
    const normalized = this.normalizedRoleIds(roleIds);
    if (normalized.length === 0) throw new Error('At least one role is required.');
    const member = subjectType === 'MEMBERSHIP'
      ? this.members.find((entry) => entry.id === subjectId && entry.active)
      : undefined;
    const currentRoleIds = member?.roleIds ?? invitation?.roleIds ?? [];
    const changedRoleIds = [...new Set([...currentRoleIds, ...normalized])].filter((roleId) => currentRoleIds.includes(roleId) !== normalized.includes(roleId));
    const adminRole = this.roles.find((role) => role.presetKey === 'GROUP_ADMINISTRATOR');
    const changedAdministrativeRole = changedRoleIds.some((roleId) => this.roleIdsGrantGroupAdministration([roleId]));
    if (changedAdministrativeRole) this.requirePermission(groupId, 'GROUP_ADMINISTRATION');
    if (subjectType === 'MEMBERSHIP') {
      if (!member) throw new Error(i18n.t('errors.memberNotFound'));
      const removesReservedAdmin = Boolean(adminRole && member.roleIds?.includes(adminRole.id) && !normalized.includes(adminRole.id));
      const adminCount = adminRole ? this.members.filter((entry) => entry.active && entry.roleIds?.includes(adminRole.id)).length : 0;
      if (removesReservedAdmin && adminCount <= 1) throw new Error('The last group administrator cannot be removed.');
      member.roleIds = normalized;
      this.syncMemberPermissions(member);
    } else {
      if (!invitation) throw new Error('Invitation not found.');
      invitation.roleIds = normalized;
      invitation.roleAssignmentsVersion = currentVersion + 1;
    }
    const version = currentVersion + 1;
    this.assignmentVersions.set(key, version);
    if (member) member.roleAssignmentsVersion = version;
    return clone({ subjectType, subjectId, roleIds: normalized, version });
  }

  private createBooking(groupId: string, command: BookingCommand & { unitPriceMinor?: number }, reasonModeOverride?: ReasonMode): Booking {
    const product = this.categories.flatMap((category) => category.products).find((entry) => entry.id === command.productId);
    const target = this.members.find((member) => member.id === command.targetMembershipId) ?? this.members.find((member) => member.userId === this.session.user.id);
    const actor = this.currentMembership(groupId);
    const category = this.categories.find((entry) => entry.id === product?.categoryId);
    if (!product || !target || !actor || !category) throw new Error(i18n.t('errors.missingProductOrMember'));
    if (target.id !== actor.id && target.isTemporaryGuest && !can(actor.effectiveGrants, 'BOOK_FOR_GUESTS')) throw new Error(i18n.t('admin.noAccessMessage'));
    if (target.id !== actor.id && !target.isTemporaryGuest && !can(actor.effectiveGrants, 'BOOK_FOR_OTHERS')) throw new Error(i18n.t('admin.noAccessMessage'));
    if (target.id === actor.id && !can(actor.effectiveGrants, 'CREATE_OWN_BOOKING')) throw new Error(i18n.t('admin.noAccessMessage'));
    const reasonMode = reasonModeOverride ?? (target.id === actor.id
      ? this.groupSettings.ownBookingReasonMode
      : target.isTemporaryGuest ? 'OFF' : this.groupSettings.foreignBookingReasonMode);
    if (reasonMode === 'REQUIRED' && !command.reason?.trim()) throw new Error(i18n.t('booking.reasonRequired'));
    const effectiveReason = reasonMode === 'OFF' ? undefined : command.reason?.trim() || undefined;
    if (product.pricingMode === 'FIXED' && (command.unitPrice || command.unitPriceMinor !== undefined)) throw new Error(i18n.t('errors.amountFormat'));
    const chosenPrice = product.pricingMode === 'USER_DEFINED'
      ? validateDemoProductPrice(command.unitPrice?.minorUnits ?? command.unitPriceMinor)
      : undefined;
    const unitPrice = product.pricingMode === 'FIXED'
      ? product.price
      : { minorUnits: chosenPrice as string, currency: product.currency };
    if (!unitPrice) throw new Error(i18n.t('errors.amountFormat'));
    const totalMinorUnits = BigInt(unitPrice.minorUnits) * BigInt(command.quantity);
    const booking: Booking = {
      id: identifier('booking'),
      memberId: target.id,
      memberName: target.displayName,
      productId: product.id,
      productName: product.name,
      categoryId: category.id,
      categoryName: category.name,
      quantity: command.quantity,
      unitPrice,
      total: { minorUnits: totalMinorUnits.toString(), currency: unitPrice.currency },
      bookedAt: new Date().toISOString(),
      bookedByName: this.session.user.displayName,
      bookedByMemberId: actor.id,
      memberStatus: target.status,
      bookedByStatus: actor.status,
      reason: effectiveReason,
      status: 'POSTED',
      voidWithoutReasonUntil: new Date(Date.now() + 30_000).toISOString(),
      canVoid: false,
      voidReasonRequired: false,
    };
    this.bookings.unshift(booking);
    this.dashboard.recentBookings.unshift(booking);
    this.dashboard.recentBookings = this.dashboard.recentBookings.slice(0, 5);
    this.dashboard.openBalance.minorUnits = (BigInt(this.dashboard.openBalance.minorUnits) + totalMinorUnits).toString();
    this.adjustGroupOutstanding(totalMinorUnits);
    this.adjustAccountBalance(target.id, totalMinorUnits);
    const categoryTotal = this.dashboard.categoryTotals.find((entry) => entry.categoryId === category.id);
    if (categoryTotal) categoryTotal.total.minorUnits = (BigInt(categoryTotal.total.minorUnits) + totalMinorUnits).toString();
    const groupCategoryTotal = this.dashboard.groupCategoryTotals.find((entry) => entry.categoryId === category.id);
    if (groupCategoryTotal) {
      groupCategoryTotal.total.minorUnits = (BigInt(groupCategoryTotal.total.minorUnits) + totalMinorUnits).toString();
      groupCategoryTotal.quantity = (groupCategoryTotal.quantity ?? 0) + command.quantity;
    }
    return clone(this.bookingWithPermissions(booking, actor));
  }

  private createBookingBatch(groupId: string, command: BookingBatchCommand & { unitPriceMinor?: number }): Booking[] {
    const targets = (command.targetMembershipIds ?? []).map((target) => target.trim());
    const temporaryGuestNames = (command.temporaryGuestDisplayNames ?? []).map((name) => name.trim().replace(/\s+/g, ' '));
    const combinedTargetCount = targets.length + temporaryGuestNames.length;
    if (combinedTargetCount < 1
      || combinedTargetCount > 100
      || targets.some((target) => !target)
      || new Set(targets).size !== targets.length
      || temporaryGuestNames.some((name) => !name || [...name].length > 120 || /\p{Cc}/u.test(name))) {
      throw new Error(i18n.t('booking.noAvailableTarget'));
    }
    const actor = this.currentMembership(groupId);
    const membersById = new Map(this.members.filter((member) => member.active).map((member) => [member.id, member]));
    if (!actor || targets.some((target) => !membersById.has(target))) throw new Error(i18n.t('errors.missingProductOrMember'));
    const includesOwn = targets.includes(actor.id);
    const includesGuests = temporaryGuestNames.length > 0 || targets.some((target) => membersById.get(target)?.isTemporaryGuest);
    const includesOthers = targets.some((target) => target !== actor.id && !membersById.get(target)?.isTemporaryGuest);
    if (includesOwn && !can(actor.effectiveGrants, 'CREATE_OWN_BOOKING')) throw new Error(i18n.t('admin.noAccessMessage'));
    if (includesOthers && !can(actor.effectiveGrants, 'BOOK_FOR_OTHERS')) throw new Error(i18n.t('admin.noAccessMessage'));
    if (includesGuests && !can(actor.effectiveGrants, 'BOOK_FOR_GUESTS')) throw new Error(i18n.t('admin.noAccessMessage'));
    const reasonMode = includesOthers ? this.groupSettings.foreignBookingReasonMode : includesOwn ? this.groupSettings.ownBookingReasonMode : 'OFF';
    if (reasonMode === 'REQUIRED' && !command.reason?.trim()) throw new Error(i18n.t('booking.reasonRequired'));
    const effectiveReason = reasonMode === 'OFF' ? undefined : command.reason?.trim() || undefined;
    const guestMembershipIds = temporaryGuestNames.map((displayName) => {
      const membership: Membership = {
        id: identifier('member-guest'),
        userId: identifier('user-guest'),
        displayName,
        email: null,
        initials: displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join(''),
        isTemporaryGuest: true,
        roles: ['MEMBER'],
        roleIds: [],
        effectiveGrants: [],
        groupPermissions: [],
        categoryPermissions: [],
        roleAssignmentsVersion: 1,
        themeOverride: null,
        status: 'ACTIVE',
        active: true,
      };
      this.members.push(membership);
      return membership.id;
    });
    return [...targets, ...guestMembershipIds].map((targetMembershipId) => this.createBooking(groupId, { ...command, reason: effectiveReason, targetMembershipId }, reasonMode));
  }

  /**
   * Creates every product-and-target combination from one demo bulk command.
   *
   * @param groupId - Active group receiving the bookings.
   * @param command - Ordered product lines and their shared target scope.
   * @returns Created bookings in item-major and then target-major order.
   * @throws Error when the cart is empty, exceeds 500 bookings, or contains invalid lines.
   */
  private createBookingBulk(groupId: string, command: BookingBulkCommand & { items: Array<BookingBulkCommand['items'][number] & { unitPriceMinor?: number }> }): Booking[] {
    const targetCount = (command.targetMembershipIds?.length ?? 0) + (command.temporaryGuestDisplayNames?.length ?? 0);
    if (command.items.length < 1 || command.items.length > 25 || targetCount < 1 || new Set(command.items.map((item) => item.productId)).size !== command.items.length) {
      throw new Error(i18n.t('booking.noAvailableTarget'));
    }
    const bookingCount = command.items.length * targetCount;
    if (bookingCount > 500) throw new Error(i18n.t('booking.tooManyBookings'));
    for (const item of command.items) {
      const product = this.categories.flatMap((category) => category.products).find((entry) => entry.id === item.productId);
      if (!product || !product.active || product.version !== item.productVersion || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
        throw new Error(i18n.t('errors.missingProductOrMember'));
      }
      if (product.pricingMode === 'USER_DEFINED') validateDemoProductPrice(item.unitPrice?.minorUnits ?? item.unitPriceMinor);
      if (product.pricingMode === 'FIXED' && (item.unitPrice || item.unitPriceMinor !== undefined)) throw new Error(i18n.t('errors.amountFormat'));
    }

    const [first, ...remaining] = command.items;
    const firstBookings = this.createBookingBatch(groupId, {
      ...first,
      expectedPeriodId: command.expectedPeriodId,
      targetMembershipIds: command.targetMembershipIds,
      temporaryGuestDisplayNames: command.temporaryGuestDisplayNames,
      reason: command.reason,
    });
    const resolvedTargetIds = firstBookings.map((booking) => booking.memberId);
    return remaining.reduce<Booking[]>((created, item) => [
      ...created,
      ...this.createBookingBatch(groupId, {
        ...item,
        expectedPeriodId: command.expectedPeriodId,
        targetMembershipIds: resolvedTargetIds,
        reason: command.reason,
      }),
    ], firstBookings);
  }

  private listBookings(groupId: string): Booking[] {
    const actor = this.currentMembership(groupId);
    if (!actor) return [];
    const canViewAll = can(actor.effectiveGrants, 'VIEW_ALL_BOOKING_ACTIVITY');
    return clone(this.bookings
      .filter((booking) => canViewAll || booking.memberId === actor.id || booking.bookedByMemberId === actor.id)
      .map((booking) => this.bookingWithPermissions(booking, actor)));
  }

  /**
   * Builds the permission-aware unified demo activity collection.
   *
   * @param groupId - Active demo group identifier.
   * @param parameters - Collection filters and sorting from the request URL.
   * @returns Fully filtered demo activities; demo mode intentionally returns the complete set.
   */
  private listActivities(groupId: string, parameters: URLSearchParams): ActivityEntry[] {
    const actor = this.currentMembership(groupId);
    if (!actor) return [];
    if (parameters.has('anchorId') && parameters.has('cursor')) throw new Error('An activity anchor cannot be combined with a cursor.');
    const canManageFinance = can(actor.effectiveGrants, 'FINANCE_MANAGEMENT');
    const visibleBookings = this.listBookings(groupId);
    const bookingActivities: ActivityEntry[] = visibleBookings.map((booking) => {
      const reversal = this.activityReversals.get(`booking:${booking.id}`);
      return {
        id: `booking:${booking.id}`,
        sourceId: booking.id,
        kind: 'BOOKING',
        targetMembershipId: booking.memberId,
        targetDisplayName: booking.memberName,
        targetMembershipStatus: booking.memberStatus,
        targetAvatarUrl: booking.memberAvatarUrl,
        actorMembershipId: booking.bookedByMemberId,
        actorDisplayName: booking.bookedByName,
        actorMembershipStatus: booking.bookedByStatus,
        actorAvatarUrl: booking.bookedByAvatarUrl,
        detailName: booking.productName,
        detailNote: booking.reason,
        categoryId: booking.categoryId,
        categoryName: booking.categoryName,
        productId: booking.productId,
        quantity: booking.quantity,
        amount: booking.total,
        occurredAt: booking.bookedAt,
        status: booking.status,
        relatedActivityId: reversal ? `reversal:booking:${booking.id}` : undefined,
        canReverse: booking.canVoid === true,
        reversalReasonRequired: booking.voidReasonRequired === true,
        reversalWithoutReasonUntil: booking.voidWithoutReasonUntil,
      };
    });
    const visiblePayments = this.payments.filter((payment) => canManageFinance || payment.membershipId === actor.id);
    const paymentActivities: ActivityEntry[] = visiblePayments.map((payment) => {
      const reversal = this.activityReversals.get(`payment:${payment.id}`);
      return {
        id: `payment:${payment.id}`,
        sourceId: payment.id,
        kind: 'PAYMENT',
        targetMembershipId: payment.membershipId,
        targetDisplayName: payment.memberName,
        targetMembershipStatus: payment.membershipStatus,
        targetAvatarUrl: payment.memberAvatarUrl,
        actorMembershipId: payment.actorMembershipId,
        actorDisplayName: payment.actorName,
        actorMembershipStatus: payment.actorStatus,
        actorAvatarUrl: payment.actorAvatarUrl,
        detailName: payment.methodLabel,
        detailNote: payment.reference ?? payment.note,
        paymentMethod: payment.method,
        amount: { ...payment.amount, minorUnits: (-BigInt(payment.amount.minorUnits)).toString() },
        occurredAt: payment.createdAt ?? payment.receivedAt,
        status: payment.status,
        attachment: payment.attachment,
        relatedActivityId: reversal ? `reversal:payment:${payment.id}` : undefined,
        canReverse: canManageFinance && payment.status === 'POSTED',
        reversalReasonRequired: canManageFinance && payment.status === 'POSTED',
      };
    });
    const bookingReversals: ActivityEntry[] = visibleBookings.flatMap((booking) => {
      const reversal = this.activityReversals.get(`booking:${booking.id}`);
      if (!reversal) return [];
      return [{
        id: `reversal:booking:${booking.id}`,
        sourceId: booking.id,
        kind: 'REVERSAL',
        reversalSourceKind: 'BOOKING',
        relatedActivityId: `booking:${booking.id}`,
        targetMembershipId: booking.memberId,
        targetDisplayName: booking.memberName,
        targetMembershipStatus: booking.memberStatus,
        targetAvatarUrl: booking.memberAvatarUrl,
        actorMembershipId: reversal.actorMembershipId,
        actorDisplayName: reversal.actorDisplayName,
        actorMembershipStatus: reversal.actorMembershipStatus,
        actorAvatarUrl: reversal.actorAvatarUrl,
        detailName: booking.productName,
        detailNote: reversal.reason,
        categoryId: booking.categoryId,
        categoryName: booking.categoryName,
        productId: booking.productId,
        quantity: booking.quantity,
        amount: { ...booking.total, minorUnits: (-BigInt(booking.total.minorUnits)).toString() },
        occurredAt: reversal.occurredAt,
        status: 'POSTED',
        canReverse: false,
        reversalReasonRequired: false,
      }];
    });
    const paymentReversals: ActivityEntry[] = visiblePayments.flatMap((payment) => {
      const reversal = this.activityReversals.get(`payment:${payment.id}`);
      if (!reversal) return [];
      return [{
        id: `reversal:payment:${payment.id}`,
        sourceId: payment.id,
        kind: 'REVERSAL',
        reversalSourceKind: 'PAYMENT',
        relatedActivityId: `payment:${payment.id}`,
        targetMembershipId: payment.membershipId,
        targetDisplayName: payment.memberName,
        targetMembershipStatus: payment.membershipStatus,
        targetAvatarUrl: payment.memberAvatarUrl,
        actorMembershipId: reversal.actorMembershipId,
        actorDisplayName: reversal.actorDisplayName,
        actorMembershipStatus: reversal.actorMembershipStatus,
        actorAvatarUrl: reversal.actorAvatarUrl,
        detailName: payment.methodLabel,
        detailNote: reversal.reason,
        paymentMethod: payment.method,
        amount: clone(payment.amount),
        occurredAt: reversal.occurredAt,
        status: 'POSTED',
        canReverse: false,
        reversalReasonRequired: false,
      }];
    });
    const adjustmentActivities: ActivityEntry[] = this.ledger
      .filter((entry) => entry.kind === 'CREDIT')
      .map((entry) => ({
        id: `adjustment:${entry.id}`,
        sourceId: entry.id,
        kind: 'ADJUSTMENT',
        targetMembershipId: actor.id,
        targetDisplayName: actor.displayName,
        targetMembershipStatus: actor.status,
        targetAvatarUrl: actor.avatarUrl,
        detailName: entry.description,
        amount: entry.amount,
        occurredAt: entry.occurredAt,
        status: 'POSTED',
        canReverse: false,
        reversalReasonRequired: false,
      }));
    const anchorId = parameters.get('anchorId');
    const selectedKinds = new Set(parameters.getAll('kind'));
    const selectedCategories = new Set(parameters.getAll('categoryId'));
    const selectedProducts = new Set(parameters.getAll('productId'));
    const targetMembershipId = parameters.get('targetMembershipId');
    const status = parameters.get('status');
    const occurredFrom = parameters.get('occurredFrom');
    const occurredTo = parameters.get('occurredTo');
    const amountMin = parameters.get('amountMin');
    const amountMax = parameters.get('amountMax');
    const search = parameters.get('q')?.trim().toLocaleLowerCase('de-DE') ?? '';
    const filtered = [...bookingActivities, ...paymentActivities, ...bookingReversals, ...paymentReversals, ...adjustmentActivities].filter((activity) => {
      if (anchorId) return true;
      const searchable = [activity.targetDisplayName, activity.actorDisplayName, activity.detailName, activity.detailNote, activity.categoryName, activity.kind, activity.status]
        .filter(Boolean).join(' ').toLocaleLowerCase('de-DE');
      const amount = BigInt(activity.amount.minorUnits);
      return (selectedKinds.size === 0 || selectedKinds.has(activity.kind))
        && (!targetMembershipId || activity.targetMembershipId === targetMembershipId)
        && (selectedCategories.size === 0 || Boolean(activity.categoryId && selectedCategories.has(activity.categoryId)))
        && (selectedProducts.size === 0 || Boolean(activity.productId && selectedProducts.has(activity.productId)))
        && (!status || activity.status === status)
        && (!occurredFrom || activity.occurredAt >= occurredFrom)
        && (!occurredTo || activity.occurredAt < occurredTo)
        && (amountMin === null || amount >= BigInt(amountMin))
        && (amountMax === null || amount <= BigInt(amountMax))
        && (!search || searchable.includes(search));
    });
    const sort = parameters.get('sort') ?? 'occurredAt';
    const descending = parameters.get('direction') !== 'asc';
    const collator = new Intl.Collator('de-DE', { numeric: true, sensitivity: 'base' });
    const sorted = filtered.sort((left, right) => {
      const leftValue = sort === 'kind' ? left.kind
        : sort === 'targetName' ? left.targetDisplayName
          : sort === 'actorName' ? left.actorDisplayName ?? ''
            : sort === 'detailName' ? left.detailName
              : sort === 'categoryName' ? left.categoryName ?? ''
                : sort === 'status' ? left.status : left.occurredAt;
      const rightValue = sort === 'kind' ? right.kind
        : sort === 'targetName' ? right.targetDisplayName
          : sort === 'actorName' ? right.actorDisplayName ?? ''
            : sort === 'detailName' ? right.detailName
              : sort === 'categoryName' ? right.categoryName ?? ''
                : sort === 'status' ? right.status : right.occurredAt;
      let comparison = sort === 'amount'
        ? BigInt(left.amount.minorUnits) < BigInt(right.amount.minorUnits) ? -1 : BigInt(left.amount.minorUnits) > BigInt(right.amount.minorUnits) ? 1 : 0
        : collator.compare(leftValue, rightValue);
      if (comparison === 0) comparison = collator.compare(left.id, right.id);
      return descending ? -comparison : comparison;
    });
    if (!anchorId) return clone(sorted);
    const anchorIndex = sorted.findIndex((activity) => activity.id === anchorId);
    if (anchorIndex < 0) throw new Error('The requested activity was not found.');
    const requestedLimit = Number(parameters.get('limit') ?? 50);
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 200) : 50;
    const start = Math.max(0, Math.min(anchorIndex - Math.floor((limit - 1) / 2), sorted.length - limit));
    return clone(sorted.slice(start, start + limit));
  }

  private bookingWithPermissions(booking: Booking, actor: Membership): Booking {
    const createdByActor = booking.bookedByMemberId === actor.id;
    const affectsActor = booking.memberId === actor.id;
    const canVoid = booking.status === 'POSTED' && (can(actor.effectiveGrants, 'VOID_ANY_BOOKING') || (createdByActor || affectsActor) && can(actor.effectiveGrants, 'VOID_OWN_BOOKING'));
    const deadline = booking.voidWithoutReasonUntil ?? booking.undoUntil ?? new Date(Date.parse(booking.bookedAt) + 30_000).toISOString();
    const withinReasonlessWindow = createdByActor && Date.parse(deadline) > Date.now();
    const reasonRequired = canVoid && !withinReasonlessWindow;
    return {
      ...this.bookingWithCurrentIdentities(booking),
      canVoid,
      voidReasonRequired: reasonRequired,
      voidWithoutReasonUntil: canVoid && withinReasonlessWindow ? deadline : undefined,
      undoUntil: undefined,
    };
  }

  private bookingWithCurrentIdentities(booking: Booking): Booking {
    const target = this.members.find((member) => member.id === booking.memberId);
    const actor = this.members.find((member) => member.id === booking.bookedByMemberId);
    return {
      ...booking,
      memberName: target?.displayName ?? booking.memberName,
      memberAvatarUrl: target ? target.avatarUrl : booking.memberAvatarUrl,
      bookedByName: actor?.displayName ?? booking.bookedByName,
      bookedByAvatarUrl: actor ? actor.avatarUrl : booking.bookedByAvatarUrl,
    };
  }

  private reverseBooking(groupId: string, id: string, reason: string): Booking {
    const booking = this.bookings.find((entry) => entry.id === id);
    const actor = this.currentMembership(groupId);
    if (!booking) throw new Error(i18n.t('errors.bookingNotFound'));
    if (!actor) throw new Error(i18n.t('errors.memberNotFound'));
    const authorized = this.bookingWithPermissions(booking, actor);
    if (!authorized.canVoid) throw new Error(i18n.t('admin.noAccessMessage'));
    if (authorized.voidReasonRequired && !reason.trim()) throw new Error(i18n.t('activities.reasonRequired'));
    if (booking.status === 'POSTED') {
      const reversal = -BigInt(booking.total.minorUnits);
      this.adjustAccountBalance(booking.memberId, reversal);
      this.adjustGroupOutstanding(reversal);
    }
    booking.status = 'REVERSED';
    booking.canVoid = false;
    this.activityReversals.set(`booking:${booking.id}`, {
      actorAvatarUrl: actor.avatarUrl,
      actorDisplayName: actor.displayName,
      actorMembershipId: actor.id,
      actorMembershipStatus: actor.status,
      occurredAt: new Date().toISOString(),
      reason: reason.trim() || undefined,
    });
    return clone(this.bookingWithPermissions(booking, actor));
  }

  private updatePermissions(groupId: string, id: string, update: PermissionUpdate & { categoryGrants?: Record<string, string[]> }, expectedVersion: number): Membership {
    this.requirePermission(groupId, 'MEMBER_MANAGEMENT');
    const member = this.members.find((entry) => entry.id === id && entry.active);
    if (!member) throw new Error(i18n.t('errors.memberNotFound'));
    const hasCategoryGrant = (update.categoryPermissions ?? []).some((permission) => permission.assignToOthers || permission.voidBookings)
      || Object.values(update.categoryGrants ?? {}).some((permissions) => permissions.length > 0);
    if (hasCategoryGrant) throw new Error('Legacy category grants are no longer accepted.');
    const roleIds = this.roleIdsForLegacyUpdate(member.roleIds ?? [], update.roles, update.groupPermissions ?? []);
    this.updateRoleAssignment(groupId, 'MEMBERSHIP', id, roleIds, expectedVersion);
    member.categoryPermissions = [];
    member.etag = `"${id}-${Date.now()}"`;
    return clone(member);
  }

  private archiveMember(groupId: string, id: string, confirmSelf: boolean): void {
    const member = this.members.find((entry) => entry.id === id && entry.active);
    if (!member) throw new Error(i18n.t('errors.memberNotFound'));
    const selfRemoval = member.userId === this.session.user.id;
    if (selfRemoval && !confirmSelf) throw new Error('Self-removal must be confirmed.');
    if (this.roleIdsGrantGroupAdministration(member.roleIds ?? [])) this.requirePermission(groupId, 'GROUP_ADMINISTRATION');
    const adminRole = this.roles.find((entry) => entry.presetKey === 'GROUP_ADMINISTRATOR');
    if (adminRole && member.roleIds?.includes(adminRole.id) && this.activeAdministratorCount() <= 1) {
      throw new Error('The last active administrator cannot be removed.');
    }
    member.active = false;
    member.status = 'ARCHIVED';
    member.roles = ['MEMBER'];
    member.roleIds = [];
    member.effectiveGrants = [];
    member.groupPermissions = [];
    member.categoryPermissions = [];
    if (selfRemoval) {
      this.session.groups = this.session.groups.filter((group) => group.id !== groupId);
      this.session.activeGroupId = this.session.groups[0]?.id ?? '';
    }
  }

  /** Restores one archived demo membership using the production role rules. */
  private reactivateMember(groupId: string, id: string, input: MemberReactivationCommand): Membership {
    const member = this.members.find((entry) => entry.id === id && entry.status === 'ARCHIVED');
    if (!member) throw new Error(i18n.t('errors.memberNotFound'));
    if (member.isTemporaryGuest) {
      const displayName = input.displayName?.trim().replace(/\s+/g, ' ') || member.displayName;
      if (!displayName || [...displayName].length > 120 || /\p{Cc}/u.test(displayName)) throw new Error(i18n.t('errors.requestFailed'));
      const conflict = this.members.some((entry) => entry.id !== member.id && entry.active && entry.isTemporaryGuest && entry.displayName.localeCompare(displayName, undefined, { sensitivity: 'accent' }) === 0);
      if (conflict) throw new Error(i18n.t('members.temporaryGuestNameConflict'));
      member.displayName = displayName;
      member.initials = displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
      member.roleIds = [];
    } else {
      const roleIds = this.normalizedRoleIds(input.roleIds);
      if (roleIds.length === 0) throw new Error(i18n.t('members.reactivationRoleRequired'));
      if (this.roleIdsGrantGroupAdministration(roleIds)) this.requirePermission(groupId, 'GROUP_ADMINISTRATION');
      member.roleIds = roleIds;
    }
    member.status = 'ACTIVE';
    member.active = true;
    this.syncMemberPermissions(member);
    return clone(member);
  }

  /** Permanently removes one zero-balance archived demo membership from administration views. */
  private permanentlyDeleteMember(id: string): void {
    const member = this.members.find((entry) => entry.id === id && entry.status === 'ARCHIVED');
    const account = this.accountSummaries.find((entry) => entry.membershipId === id);
    if (!member) throw new Error(i18n.t('errors.memberNotFound'));
    if (account && BigInt(account.balance.minorUnits) !== 0n) throw new Error(i18n.t('members.permanentDeleteBalanceConflict'));
    member.status = 'DELETED';
    member.active = false;
    member.email = null;
    delete member.avatarUrl;
    member.roles = [];
    member.roleIds = [];
    member.effectiveGrants = [];
    member.groupPermissions = [];
    member.categoryPermissions = [];
    if (account) {
      account.status = 'DELETED';
      account.isTemporaryGuest = false;
      delete account.avatarUrl;
    }
    this.bookings.forEach((booking) => {
      if (booking.memberId === id) booking.memberStatus = 'DELETED';
      if (booking.bookedByMemberId === id) booking.bookedByStatus = 'DELETED';
    });
    this.payments.forEach((payment) => {
      if (payment.membershipId === id) payment.membershipStatus = 'DELETED';
    });
  }

  private activeAdministratorCount(): number {
    const role = this.roles.find((entry) => entry.presetKey === 'GROUP_ADMINISTRATOR');
    return role ? this.members.filter((member) => member.active && member.roleIds?.includes(role.id)).length : 0;
  }

  private createCategory(input: Partial<Category>): Category {
    if (!isCategoryIcon(input.icon)) throw new Error(i18n.t('errors.requestFailed'));
    const category: Category = {
      id: identifier('category'),
      version: 1,
      name: input.name ?? i18n.t('demo.newCategory'),
      icon: input.icon,
      active: true,
      sortOrder: this.categories.length,
      products: [],
    };
    this.categories.push(category);
    return clone(category);
  }

  /**
   * Replaces the complete demo catalog order using the production endpoint's
   * validation rules.
   *
   * @param input - Every category and each category's complete product list.
   * @returns A detached catalog snapshot in the persisted display order.
   * @throws Error when identifiers are missing, duplicated, unknown, or assigned to another category.
   */
  private reorderCatalog(input: CatalogOrderCommand): Category[] {
    if (!Array.isArray(input.categoryIds) || !input.productIdsByCategory || typeof input.productIdsByCategory !== 'object') {
      throw new Error(i18n.t('errors.requestFailed'));
    }
    const categoryById = new Map(this.categories.map((category) => [category.id, category]));
    const categoryKeys = Object.keys(input.productIdsByCategory);
    if (input.categoryIds.length !== this.categories.length
      || new Set(input.categoryIds).size !== this.categories.length
      || categoryKeys.length !== this.categories.length
      || input.categoryIds.some((categoryId) => !categoryById.has(categoryId) || !Object.hasOwn(input.productIdsByCategory, categoryId))
      || categoryKeys.some((categoryId) => !categoryById.has(categoryId))) {
      throw new Error(i18n.t('errors.requestFailed'));
    }

    for (const categoryId of input.categoryIds) {
      const category = categoryById.get(categoryId)!;
      const productIds = input.productIdsByCategory[categoryId];
      const existingProductIds = new Set(category.products.map((product) => product.id));
      if (!Array.isArray(productIds)
        || productIds.length !== category.products.length
        || new Set(productIds).size !== category.products.length
        || productIds.some((productId) => !existingProductIds.has(productId))) {
        throw new Error(i18n.t('errors.requestFailed'));
      }
    }

    this.categories = input.categoryIds.map((categoryId, categoryPosition) => {
      const category = categoryById.get(categoryId)!;
      const productById = new Map(category.products.map((product) => [product.id, product]));
      return {
        ...category,
        sortOrder: categoryPosition,
        version: category.version + Number(category.sortOrder !== categoryPosition),
        products: input.productIdsByCategory[categoryId].map((productId, productPosition) => {
          const product = productById.get(productId)!;
          return { ...product, sortOrder: productPosition, version: product.version + Number(product.sortOrder !== productPosition) };
        }),
      };
    });
    const categoryPosition = new Map(input.categoryIds.map((categoryId, position) => [categoryId, position]));
    const sortTotals = <T extends { categoryId: string }>(totals: T[]) => totals.sort((left, right) => (
      (categoryPosition.get(left.categoryId) ?? Number.MAX_SAFE_INTEGER) - (categoryPosition.get(right.categoryId) ?? Number.MAX_SAFE_INTEGER)
    ));
    sortTotals(this.dashboard.categoryTotals);
    sortTotals(this.dashboard.groupCategoryTotals);
    return clone(this.categories);
  }

  /** Updates one demo category while enforcing the production version contract. */
  private updateCategory(id: string, input: Pick<Category, 'name' | 'icon' | 'active' | 'sortOrder' | 'version'>): Category {
    const category = this.categories.find((entry) => entry.id === id);
    if (!category) throw new Error(i18n.t('errors.categoryNotFound'));
    if (category.version !== input.version) throw new Error(i18n.t('errors.requestFailed'));
    if (!isCategoryIcon(input.icon)) throw new Error(i18n.t('errors.requestFailed'));
    category.name = input.name;
    category.icon = input.icon;
    category.active = input.active;
    category.sortOrder = input.sortOrder;
    category.version += 1;
    return clone(category);
  }

  private deleteCategory(id: string, version: number): void {
    const index = this.categories.findIndex((entry) => entry.id === id);
    const category = this.categories[index];
    if (!category) throw new Error('The category does not exist.');
    if (category.version !== version) throw new Error(i18n.t('catalog.deleteStaleError'));
    if (category.active) throw new Error(i18n.t('catalog.deleteCategoryActiveError'));
    if (category.products.length > 0) throw new Error(i18n.t('catalog.deleteCategoryProductsError'));
    if (this.bookings.some((booking) => booking.categoryId === id)) throw new Error(i18n.t('catalog.deleteCategoryHistoryError'));
    this.categories.splice(index, 1);
    this.members.forEach((member) => {
      member.categoryPermissions = member.categoryPermissions.filter((permission) => permission.categoryId !== id);
    });
    this.invitations.forEach((invitation) => {
      if (!invitation.acceptedAt && !invitation.revokedAt) {
        invitation.categoryPermissions = invitation.categoryPermissions.filter((permission) => permission.categoryId !== id);
      }
    });
    this.dashboard.categoryTotals = this.dashboard.categoryTotals.filter((total) => total.categoryId !== id);
    this.dashboard.groupCategoryTotals = this.dashboard.groupCategoryTotals.filter((total) => total.categoryId !== id);
  }

  private createInvitation(groupId: string, input: InvitationInput & { categoryGrants?: Record<string, string[]>; expiresInDays?: number }): CreatedInvitation {
    this.requirePermission(groupId, 'MEMBER_MANAGEMENT');
    const email = input.email.trim().toLowerCase();
    if (this.members.some((member) => member.active && member.email?.toLowerCase() === email)) throw new Error('An active membership already exists for this email address.');
    if (this.invitations.some((item) => !item.acceptedAt && !item.revokedAt && Date.parse(item.expiresAt) > Date.now() && item.email.toLowerCase() === email)) throw new Error('An active invitation already exists for this email address.');
    const token = crypto.randomUUID();
    const selectedRoleIds = this.normalizedRoleIds(input.roleIds ?? []);
    if (selectedRoleIds.length === 0) throw new Error('At least one role is required.');
    if (this.roleIdsGrantGroupAdministration(selectedRoleIds)) this.requirePermission(groupId, 'GROUP_ADMINISTRATION');
    const invitation: CreatedInvitation = {
      id: identifier('invitation'),
      email,
      displayName: input.displayName || undefined,
      roles: this.legacyRolesForRoleIds(selectedRoleIds),
      roleIds: selectedRoleIds,
      roleAssignmentsVersion: 1,
      groupPermissions: input.groupPermissions ?? [],
      categoryPermissions: input.categoryPermissions ?? Object.entries(input.categoryGrants ?? {}).map(([categoryId, permissions]) => ({ categoryId, assignToOthers: permissions.includes('ASSIGN_TO_OTHERS'), voidBookings: permissions.includes('VOID_BOOKINGS') })),
      expiresAt: new Date(Date.now() + (input.expiresInDays || 7) * 86_400_000).toISOString(),
      acceptUrl: `${window.location.origin}/invite#token=${token}`,
      emailDeliveryStatus: 'PENDING',
    };
    this.invitations.unshift({ ...invitation });
    this.invitationTokens.set(invitation.id, token);
    return invitation;
  }

  private updateInvitation(groupId: string, invitationId: string, input: Omit<InvitationInput, 'email'> & { categoryGrants?: Record<string, string[]> }, headers?: HeadersInit): InvitationMetadata {
    const invitation = this.invitations.find((item) => item.id === invitationId && !item.acceptedAt && !item.revokedAt && Date.parse(item.expiresAt) > Date.now());
    if (!invitation) throw new Error('Invitation not found.');
    if (input.roleIds !== undefined) {
      this.updateRoleAssignment(groupId, 'INVITATION', invitationId, input.roleIds, requiredDemoVersion(headers));
      invitation.displayName = input.displayName || undefined;
      return clone(invitation);
    }
    const roleIds = this.roleIdsForLegacyUpdate(invitation.roleIds ?? [], input.roles ?? [], input.groupPermissions ?? []);
    this.updateRoleAssignment(groupId, 'INVITATION', invitationId, roleIds, requiredDemoVersion(headers));
    invitation.displayName = input.displayName || undefined;
    invitation.roles = this.legacyRolesForRoleIds(roleIds);
    invitation.groupPermissions = input.groupPermissions ?? [];
    invitation.categoryPermissions = input.categoryPermissions ?? Object.entries(input.categoryGrants ?? {}).map(([categoryId, permissions]) => ({ categoryId, assignToOthers: permissions.includes('ASSIGN_TO_OTHERS'), voidBookings: permissions.includes('VOID_BOOKINGS') }));
    return clone(invitation);
  }

  private revokeInvitation(invitationId: string): void {
    const invitation = this.invitations.find((item) => item.id === invitationId && !item.acceptedAt && !item.revokedAt);
    if (!invitation) throw new Error('Invitation not found.');
    invitation.revokedAt = new Date().toISOString();
    invitation.emailDeliveryStatus = 'CANCELLED';
    this.invitationTokens.delete(invitationId);
  }

  /**
   * Imports member invitation rows and queues simulated email delivery.
   *
   * @param document - UTF-8 CSV text containing the invitation candidates.
   * @returns Row-level import outcomes and aggregate counters.
   * @throws Error when the CSV header or data rows are missing.
   */
  private importInvitations(document: string, roleIds: string[]): InvitationImportResult {
    const normalizedRoleIds = this.normalizedRoleIds(roleIds);
    const candidates = parseDemoMemberCsv(document);
    const memberEmails = new Set(this.members.filter((member) => member.active).flatMap((member) => member.email ? [member.email.toLowerCase()] : []));
    const existingInvitations = new Map(this.invitations
      .filter((invitation) => !invitation.acceptedAt && !invitation.revokedAt && Date.parse(invitation.expiresAt) > Date.now())
      .map((invitation) => [invitation.email.toLowerCase(), invitation]));
    const importedEmails = new Set<string>();
    const rows: InvitationImportRow[] = [];
    const summary = { totalRows: candidates.length, created: 0, invalid: 0, skipped: 0 };
    for (const candidate of candidates) {
      const base = { row: candidate.row, email: candidate.email || undefined, displayName: candidate.displayName || undefined };
      const invalidCode = !candidate.email.includes('@')
        ? 'invalid_email'
        : candidate.displayName.length > 120
          ? 'display_name_too_long'
          : importedEmails.has(candidate.email) ? 'duplicate_email' : undefined;
      if (invalidCode) {
        rows.push({ ...base, invitationStatus: 'INVALID', emailDeliveryStatus: 'NOT_REQUESTED', code: invalidCode });
        summary.invalid += 1;
        continue;
      }
      let effectiveRoleIds = normalizedRoleIds;
      if (candidate.roleNames.length > 0) {
        const resolved = candidate.roleNames.map((name) => this.roles.find((role) => role.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)?.id);
        if (resolved.some((roleId) => !roleId)) {
          rows.push({ ...base, invitationStatus: 'INVALID', emailDeliveryStatus: 'NOT_REQUESTED', code: 'unknown_role' });
          summary.invalid += 1;
          continue;
        }
        effectiveRoleIds = this.normalizedRoleIds(resolved as string[]);
      } else if (effectiveRoleIds.length === 0 && this.groupSettings.defaultRoleId) {
        effectiveRoleIds = [this.groupSettings.defaultRoleId];
      }
      if (effectiveRoleIds.length === 0) {
        rows.push({ ...base, invitationStatus: 'INVALID', emailDeliveryStatus: 'NOT_REQUESTED', code: 'missing_default_role' });
        summary.invalid += 1;
        continue;
      }
      importedEmails.add(candidate.email);
      if (memberEmails.has(candidate.email)) {
        rows.push({ ...base, invitationStatus: 'SKIPPED_ALREADY_MEMBER', emailDeliveryStatus: 'NOT_REQUESTED' });
        summary.skipped += 1;
        continue;
      }
      const existingInvitation = existingInvitations.get(candidate.email);
      if (existingInvitation) {
        rows.push({
          ...base,
          invitationId: existingInvitation.id,
          invitationStatus: 'SKIPPED_ALREADY_INVITED',
          emailDeliveryStatus: existingInvitation.emailDeliveryStatus,
        });
        summary.skipped += 1;
        continue;
      }
      const invitation: InvitationMetadata = {
        id: identifier('invitation'),
        email: candidate.email,
        displayName: candidate.displayName || undefined,
        roles: this.legacyRolesForRoleIds(effectiveRoleIds),
        roleIds: [...effectiveRoleIds],
        roleAssignmentsVersion: 1,
        groupPermissions: [],
        categoryPermissions: [],
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        emailDeliveryStatus: 'PENDING',
      };
      this.invitations.unshift(invitation);
      this.invitationTokens.set(invitation.id, crypto.randomUUID());
      existingInvitations.set(candidate.email, invitation);
      rows.push({ ...base, invitationId: invitation.id, invitationStatus: 'CREATED', emailDeliveryStatus: 'PENDING' });
      summary.created += 1;
    }
    return clone({ summary, rows });
  }

  /**
   * Lists invitation metadata and advances pending demo deliveries.
   *
   * @returns A cloned snapshot of all invitation delivery states.
   */
  private listInvitations(): InvitationMetadata[] {
    for (const invitation of this.invitations) {
      if (invitation.emailDeliveryStatus === 'PENDING') invitation.emailDeliveryStatus = 'SENDING';
      else if (invitation.emailDeliveryStatus === 'SENDING') {
        invitation.emailDeliveryStatus = 'SENT';
        invitation.emailSentAt = new Date().toISOString();
      }
    }
    return clone(this.invitations);
  }

  /**
   * Restarts simulated email delivery for an existing invitation.
   *
   * @param invitationId - Identifier of the invitation to retry.
   * @returns The invitation identifier and its reset pending state.
   * @throws Error when the invitation does not exist.
   */
  private retryInvitationEmail(invitationId: string): InvitationEmailRetryResult {
    const invitation = this.invitations.find((item) => item.id === invitationId
      && !item.acceptedAt && !item.revokedAt && Date.parse(item.expiresAt) > Date.now()
      && item.emailDeliveryStatus === 'FAILED');
    if (!invitation) throw new Error('Invitation not found.');
    invitation.emailDeliveryStatus = 'PENDING';
    delete invitation.emailSentAt;
    return { invitationId, emailDeliveryStatus: 'PENDING' };
  }

  private resendInvitationEmail(invitationId: string): InvitationEmailResendResult {
    const invitation = this.invitations.find((item) => item.id === invitationId && !item.acceptedAt && !item.revokedAt);
    if (!invitation) throw new Error('Invitation not found.');
    if (invitation.emailDeliveryStatus === 'PENDING' || invitation.emailDeliveryStatus === 'SENDING') throw new Error('Invitation delivery is already in progress.');
    const token = crypto.randomUUID();
    invitation.expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    invitation.emailDeliveryStatus = 'PENDING';
    delete invitation.emailSentAt;
    this.invitationTokens.set(invitationId, token);
    return { invitationId, emailDeliveryStatus: 'PENDING', expiresAt: invitation.expiresAt, acceptUrl: `${window.location.origin}/invite#token=${token}` };
  }

  private createProduct(input: Partial<Product>): Product {
    const category = this.categories.find((entry) => entry.id === input.categoryId);
    if (!category) throw new Error(i18n.t('errors.categoryNotFound'));
    const product: Product = {
      id: identifier('product'),
      categoryId: category.id,
      version: 1,
      name: input.name ?? i18n.t('demo.newProduct'),
      pricingMode: input.pricingMode ?? 'FIXED',
      currency: input.currency ?? 'EUR',
      price: input.pricingMode === 'USER_DEFINED' ? undefined : input.price ?? { minorUnits: '0', currency: input.currency ?? 'EUR' },
      imageUrl: input.imageUrl,
      active: true,
      sortOrder: category.products.length,
    };
    category.products.push(product);
    return clone(product);
  }

  /** Updates one demo product while preserving its category and booking history. */
  private updateProduct(id: string, input: Pick<Product, 'name' | 'pricingMode' | 'price' | 'active' | 'sortOrder' | 'version'>): Product {
    const product = this.categories.flatMap((category) => category.products).find((entry) => entry.id === id);
    if (!product) throw new Error(i18n.t('errors.missingProductOrMember'));
    if (product.version !== input.version) throw new Error(i18n.t('errors.requestFailed'));
    product.name = input.name;
    product.pricingMode = input.pricingMode;
    product.price = input.price;
    product.active = input.active;
    product.sortOrder = input.sortOrder;
    product.version += 1;
    return clone(product);
  }

  private deleteProduct(id: string, version: number): void {
    const category = this.categories.find((entry) => entry.products.some((product) => product.id === id));
    const productIndex = category?.products.findIndex((product) => product.id === id) ?? -1;
    const product = productIndex >= 0 ? category?.products[productIndex] : undefined;
    if (!category || !product) throw new Error('The product does not exist.');
    if (product.version !== version) throw new Error(i18n.t('catalog.deleteStaleError'));
    if (product.active) throw new Error(i18n.t('catalog.deleteProductActiveError'));
    category.products.splice(productIndex, 1);
  }

  private createPayment(command: PaymentCommand & { amountMinor?: number }, reasonMode: ReasonMode = this.groupSettings.otherPaymentReasonMode, attachment?: File): Payment {
    const member = this.members.find((entry) => entry.id === command.membershipId);
    const groupId = this.session.activeGroupId ?? this.session.groups[0]?.id ?? '';
    const actor = this.currentMembership(groupId);
    if (!member) throw new Error(i18n.t('errors.memberNotFound'));
    if (!actor) throw new Error(i18n.t('errors.memberNotFound'));
    if (reasonMode === 'REQUIRED' && !command.reference?.trim()) throw new Error(i18n.t('selfPayment.referenceRequired'));
    const paymentMethod = this.groupSettings.paymentMethods.find((entry) => entry.id === command.method);
    if (!paymentMethod) throw new Error(i18n.t('errors.requestFailed'));
    if (paymentMethod.attachmentMode === 'OFF' && attachment) throw new Error('This payment method does not accept receipts.');
    if (paymentMethod.attachmentMode === 'REQUIRED' && !attachment) throw new Error('A receipt is required for this payment method.');
    const effectiveReference = reasonMode === 'OFF' ? undefined : command.reference?.trim() || undefined;
    const payment: Payment = {
      id: identifier('payment'),
      memberName: member.displayName,
      membershipStatus: member.status,
      memberAvatarUrl: member.avatarUrl,
      actorMembershipId: actor.id,
      actorName: actor.displayName,
      actorStatus: actor.status,
      actorAvatarUrl: actor.avatarUrl,
      createdAt: new Date().toISOString(),
      status: 'POSTED',
      ...command,
      reference: effectiveReference,
      amount: command.amount ?? { minorUnits: String(command.amountMinor ?? 0), currency: 'EUR' },
      methodLabel: paymentMethod.label,
      ...(attachment ? { attachment: { fileName: attachment.name, mediaType: attachment.type, sizeBytes: attachment.size, url: '' } } : {}),
    };
    if (attachment && payment.attachment) {
      payment.attachment.url = `/api/v1/groups/${encodeURIComponent(groupId)}/payments/${encodeURIComponent(payment.id)}/attachment`;
      this.paymentAttachments.set(payment.id, attachment);
    }
    this.payments.unshift(payment);
    const paymentMinor = BigInt(payment.amount.minorUnits);
    this.adjustAccountBalance(member.id, -paymentMinor);
    this.adjustGroupOutstanding(-paymentMinor);
    if (member.userId === this.session.user.id) {
      this.dashboard.openBalance.minorUnits = (BigInt(this.dashboard.openBalance.minorUnits) - paymentMinor).toString();
      this.ledger.unshift({
        id: identifier('ledger'),
        occurredAt: payment.receivedAt,
        kind: 'PAYMENT',
        description: payment.reference ? i18n.t('ledger.paymentReceivedWithReference', { reference: payment.reference }) : i18n.t('ledger.paymentReceived'),
        amount: { minorUnits: (-paymentMinor).toString(), currency: payment.amount.currency },
        balance: clone(this.dashboard.openBalance),
        referenceId: payment.id,
        ...(payment.attachment ? { attachment: clone(payment.attachment) } : {}),
      });
      let remaining = paymentMinor;
      for (const settlement of this.settlements.filter((entry) => entry.membershipId === member.id && (entry.status === 'OPEN' || entry.status === 'PARTIAL'))) {
        if (remaining <= 0n) break;
        const openMinor = BigInt(settlement.openAmount?.minorUnits ?? '0');
        const allocated = remaining < openMinor ? remaining : openMinor;
        settlement.paidAmount.minorUnits = (BigInt(settlement.paidAmount.minorUnits) + allocated).toString();
        settlement.openAmount = { minorUnits: (openMinor - allocated).toString(), currency: settlement.amount.currency };
        settlement.status = openMinor === allocated ? 'PAID' : 'PARTIAL';
        remaining -= allocated;
      }
    }
    return clone(payment);
  }

  private createOwnPayment(groupId: string, command: SelfPaymentCommand & { amountMinor?: number }, attachment?: File): Payment {
    const membershipId = this.session.groups.find((group) => group.id === groupId)?.membership?.id;
    const member = this.members.find((entry) => entry.id === membershipId && entry.active);
    if (!member) throw new Error(i18n.t('errors.memberNotFound'));
    if (!can(member.effectiveGrants, 'RECORD_OWN_PAYMENT')) throw new Error(i18n.t('financeWorkspace.noAccessMessage'));
    const amountMinor = BigInt(command.amount?.minorUnits ?? command.amountMinor ?? 0);
    if (amountMinor <= 0n) throw new Error(i18n.t('errors.amountFormat'));
    if (amountMinor > 100_000_000_000n) throw new Error(i18n.t('errors.amountRange'));
    if (!command.receivedAt || Number.isNaN(Date.parse(command.receivedAt))) throw new Error(i18n.t('errors.requestFailed'));
    if (!this.groupSettings.paymentMethods.some((entry) => entry.id === command.method)) throw new Error(i18n.t('errors.requestFailed'));
    if (this.groupSettings.ownPaymentReasonMode === 'REQUIRED' && !command.reference?.trim()) throw new Error(i18n.t('selfPayment.referenceRequired'));
    return this.createPayment({
      membershipId: member.id,
      amount: command.amount ?? { minorUnits: amountMinor.toString(), currency: 'EUR' },
      receivedAt: command.receivedAt,
      method: command.method,
      reference: command.reference?.trim(),
    }, this.groupSettings.ownPaymentReasonMode, attachment);
  }

  private reversePayment(groupId: string, id: string, reason: string): void {
    const payment = this.payments.find((entry) => entry.id === id);
    const actor = this.currentMembership(groupId);
    if (!payment) throw new Error(i18n.t('errors.paymentNotFound'));
    if (!actor) throw new Error(i18n.t('errors.memberNotFound'));
    if (!reason.trim()) throw new Error(i18n.t('activities.reasonRequired'));
    if (payment.status === 'POSTED') {
      const reversal = BigInt(payment.amount.minorUnits);
      this.adjustAccountBalance(payment.membershipId, reversal);
      this.adjustGroupOutstanding(reversal);
    }
    payment.status = 'REVERSED';
    this.activityReversals.set(`payment:${payment.id}`, {
      actorAvatarUrl: actor.avatarUrl,
      actorDisplayName: actor.displayName,
      actorMembershipId: actor.id,
      actorMembershipStatus: actor.status,
      occurredAt: new Date().toISOString(),
      reason: reason.trim(),
    });
  }

  /** Applies an exact complete-ledger movement to the demo group balance. */
  private adjustGroupOutstanding(amount: bigint): void {
    if (!this.dashboard.groupOutstanding) return;
    this.dashboard.groupOutstanding.minorUnits = (BigInt(this.dashboard.groupOutstanding.minorUnits) + amount).toString();
  }

  /** Applies an exact balance movement to one demo account summary. */
  private adjustAccountBalance(membershipId: string, amount: bigint): void {
    const account = this.accountSummaries.find((entry) => entry.membershipId === membershipId);
    if (!account) return;
    account.balance.minorUnits = (BigInt(account.balance.minorUnits) + amount).toString();
  }

  private closePeriod(id: string, input: { label: string; dueAt: string }): Period {
    if (!this.groupSettings.settlementsEnabled) throw new Error('Settlements are disabled for this group.');
    const period = this.periods.find((entry) => entry.id === id);
    if (!period) throw new Error(i18n.t('errors.periodNotFound'));
    period.status = 'CLOSED';
    period.label = input.label;
    period.dueAt = input.dueAt;
    period.closedAt = new Date().toISOString();
    const next: Period = {
      id: identifier('period'),
      label: i18n.t('demo.newPeriod'),
      status: 'OPEN',
      startsAt: new Date().toISOString(),
    };
    this.periods.unshift(next);
    return clone(period);
  }

  private markNotificationRead(id: string): Notification {
    const notification = this.notifications.find((entry) => entry.id === id);
    if (!notification) throw new Error(i18n.t('errors.notificationNotFound'));
    notification.readAt = new Date().toISOString();
    return clone(notification);
  }
}
