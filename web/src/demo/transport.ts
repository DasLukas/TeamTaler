import type {
  AccountSummary,
  Booking,
  BookingBatchCommand,
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
  Membership,
  Notification,
  Payment,
  PaymentCommand,
  PermissionGrant,
  PermissionKey,
  SelfPaymentCommand,
  Period,
  PermissionUpdate,
  Product,
  PublicJoinLink,
  PublicJoinPreview,
  Role,
  RoleAssignment,
  RoleInput,
  Session,
} from '@/api/types';
import { isCategoryIcon } from '@/api/types';
import { can } from '@/app/permissions';
import { MAX_PRODUCT_PRICE_MINOR } from '@/api/money';
import {
  demoAccountSummaries,
  demoAudit,
  demoBookings,
  demoCategories,
  demoDashboard,
  demoLedger,
  demoMembers,
  demoNotifications,
  demoPayments,
  demoPermissionDefinitions,
  demoPeriods,
  demoRoles,
  demoSession,
  demoSettlements,
} from './data';
import i18n from '@/i18n';

type DemoRequestInit = RequestInit;

const ADMIN_CORE: readonly PermissionKey[] = ['GROUP_ADMINISTRATION', 'ROLE_MANAGEMENT'];

interface DemoRoutePolicy {
  methods: readonly string[];
  resource: RegExp;
  anyOf: readonly PermissionKey[];
}

const DEMO_ROUTE_POLICIES: readonly DemoRoutePolicy[] = [
  { methods: ['GET', 'PATCH'], resource: /^settings$/, anyOf: ['GROUP_ADMINISTRATION'] },
  { methods: ['PUT'], resource: /^guest-settings$/, anyOf: ['GROUP_ADMINISTRATION'] },
  { methods: ['POST', 'DELETE'], resource: /^logo$/, anyOf: ['GROUP_ADMINISTRATION'] },
  { methods: ['GET'], resource: /^members$/, anyOf: ['VIEW_MEMBER_DIRECTORY'] },
  { methods: ['PATCH', 'DELETE'], resource: /^members\/[^/]+$/, anyOf: ['GROUP_ADMINISTRATION'] },
  { methods: ['POST'], resource: /^members\/[^/]+\/claim-invitation$/, anyOf: ['GROUP_ADMINISTRATION'] },
  { methods: ['GET', 'PUT'], resource: /^public-join-link$/, anyOf: ['GROUP_ADMINISTRATION'] },
  { methods: ['POST'], resource: /^public-join-link\/rotate$/, anyOf: ['GROUP_ADMINISTRATION'] },
  { methods: ['PATCH'], resource: /^members\/[^/]+\/permissions$/, anyOf: ['GROUP_ADMINISTRATION'] },
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
  { methods: ['GET'], resource: /^roles(?:\/[^/]+)?$/, anyOf: ['GROUP_ADMINISTRATION', 'ROLE_MANAGEMENT'] },
  { methods: ['GET'], resource: /^role-assignments$/, anyOf: ['GROUP_ADMINISTRATION', 'ROLE_MANAGEMENT'] },
  { methods: ['GET'], resource: /^invitations$/, anyOf: ['GROUP_ADMINISTRATION', 'ROLE_MANAGEMENT'] },
  { methods: ['POST'], resource: /^invitations$/, anyOf: ['GROUP_ADMINISTRATION'] },
  { methods: ['POST'], resource: /^invitations\/import$/, anyOf: ['GROUP_ADMINISTRATION'] },
  { methods: ['PATCH', 'DELETE'], resource: /^invitations\/[^/]+$/, anyOf: ['GROUP_ADMINISTRATION'] },
  { methods: ['PUT'], resource: /^invitations\/[^/]+\/roles$/, anyOf: ['GROUP_ADMINISTRATION', 'ROLE_MANAGEMENT'] },
  { methods: ['POST'], resource: /^invitations\/[^/]+\/email\/(?:retry|resend)$/, anyOf: ['GROUP_ADMINISTRATION'] },
  { methods: ['POST'], resource: /^categories$/, anyOf: ['CATALOG_MANAGEMENT'] },
  { methods: ['PUT'], resource: /^catalog\/order$/, anyOf: ['CATALOG_MANAGEMENT'] },
  { methods: ['PATCH', 'DELETE'], resource: /^categories\/[^/]+$/, anyOf: ['CATALOG_MANAGEMENT'] },
  { methods: ['POST'], resource: /^categories\/[^/]+\/products$/, anyOf: ['CATALOG_MANAGEMENT'] },
  { methods: ['PATCH', 'DELETE'], resource: /^products\/[^/]+$/, anyOf: ['CATALOG_MANAGEMENT'] },
  { methods: ['POST'], resource: /^products\/[^/]+\/image$/, anyOf: ['CATALOG_MANAGEMENT'] },
];

const clone = <T,>(value: T): T => structuredClone(value);
const identifier = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

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
  private periods = clone(demoPeriods);
  private settlements = clone(demoSettlements);
  private notifications = clone(demoNotifications);
  private audit = clone(demoAudit);
  private roles = clone(demoRoles);
  private assignmentVersions = new Map<string, number>();
  private invitations: InvitationMetadata[] = [];
  private invitationTokens = new Map<string, string>();
  private groupSettings: GroupSettings = { notificationEmailsEnabled: false, notificationEmailDeliveryAvailable: true, defaultRoleId: 'role-member', guestsEnabled: false, guestRoleId: null };
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
    const body = typeof init.body === 'string'
      ? contentType.startsWith('text/csv') ? init.body : JSON.parse(init.body) as unknown
      : undefined;
    const cleanPath = path.split('?')[0];

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

    if (resource === 'settings' && method === 'GET') return clone(this.groupSettings) as T;
    if (resource === 'settings' && method === 'PATCH') {
      this.requirePermission(groupId, 'GROUP_ADMINISTRATION');
      const update = body as Partial<GroupSettings>;
      const updatesNotificationEmails = update.notificationEmailsEnabled !== undefined;
      const updatesDefaultRole = update.defaultRoleId !== undefined;
      if (!updatesNotificationEmails && !updatesDefaultRole) throw new Error('At least one group setting is required.');
      if (updatesNotificationEmails && typeof update.notificationEmailsEnabled !== 'boolean') throw new Error('Notification email delivery must be a boolean.');
      if (updatesDefaultRole) {
        const defaultRole = this.roles.find((role) => role.id === update.defaultRoleId);
        if (!defaultRole) throw new Error('The default role does not exist.');
        if (defaultRole.grants.some((grant) => grant.permission === 'GROUP_ADMINISTRATION')) throw new Error('The default role must not grant group administration.');
      }
      this.groupSettings = {
        ...this.groupSettings,
        ...(updatesNotificationEmails ? { notificationEmailsEnabled: update.notificationEmailsEnabled as boolean } : {}),
        ...(updatesDefaultRole ? { defaultRoleId: update.defaultRoleId as string } : {}),
      };
      return clone(this.groupSettings) as T;
    }
    if (resource === 'guest-settings' && method === 'PUT') {
      this.requirePermission(groupId, 'GROUP_ADMINISTRATION');
      const input = body as { guestsEnabled?: boolean; guestRoleId?: string | null; createGuestRole?: boolean; replacementDefaultRoleId?: string };
      if (typeof input.guestsEnabled !== 'boolean') throw new Error('Guest activation must be a boolean.');
      if (input.createGuestRole && input.guestRoleId !== undefined) throw new Error('Choose an existing role or create a guest role, not both.');
      let guestRoleId = this.groupSettings.guestRoleId;
      if (input.guestsEnabled && input.createGuestRole) {
        const existingNames = new Set(this.roles.map((role) => role.name.toLocaleLowerCase()));
        let name = 'Gast';
        let suffix = 2;
        while (existingNames.has(name.toLocaleLowerCase())) {
          name = `Gast ${suffix}`;
          suffix += 1;
        }
        const role: Role = {
          id: identifier('role-guest'),
          groupId,
          name,
          description: 'Booking-only role for guests',
          grants: [{ permission: 'CREATE_OWN_BOOKING', scope: { type: 'GROUP' } }],
          version: 1,
          memberCount: 0,
          pendingInvitationCount: 0,
        };
        this.roles.push(role);
        guestRoleId = role.id;
      } else if (input.guestsEnabled && typeof input.guestRoleId === 'string') {
        const role = this.roles.find((entry) => entry.id === input.guestRoleId);
        if (!role || role.id !== this.groupSettings.guestRoleId && (role.grants.length !== 1 || role.grants[0]?.permission !== 'CREATE_OWN_BOOKING' || role.grants[0].scope.type !== 'GROUP')) {
          throw new Error('The guest role must grant exactly own-booking access.');
        }
        guestRoleId = role.id;
      }
      if (!input.guestsEnabled && guestRoleId && this.groupSettings.defaultRoleId === guestRoleId) {
        const replacement = this.roles.find((role) => role.id === input.replacementDefaultRoleId);
        if (!replacement || replacement.id === guestRoleId || replacement.grants.some((grant) => grant.permission === 'GROUP_ADMINISTRATION')) {
          throw new Error('A replacement default role is required.');
        }
        this.groupSettings.defaultRoleId = replacement.id;
      }
      this.groupSettings = {
        ...this.groupSettings,
        guestsEnabled: input.guestsEnabled,
        guestRoleId,
        ...(input.guestsEnabled && guestRoleId ? { defaultRoleId: guestRoleId } : {}),
      };
      return clone(this.groupSettings) as T;
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
    if (resource === 'dashboard') return clone(this.dashboard) as T;
    if (resource === 'booking-context' && method === 'GET') {
      const actor = this.currentMembership(groupId);
      if (!actor) throw new Error(i18n.t('errors.memberNotFound'));
      const canBookOwn = can(actor.effectiveGrants, 'CREATE_OWN_BOOKING');
      const canBookOthers = can(actor.effectiveGrants, 'BOOK_FOR_OTHERS');
      const targets = this.members
        .filter((member) => member.active && (member.id === actor.id ? canBookOwn : canBookOthers))
        .map((member) => ({ membershipId: member.id, displayName: member.displayName, avatarUrl: member.avatarUrl, isGuest: member.isGuest }));
      return clone({
        openPeriod: this.dashboard.currentPeriod,
        ownBalanceMinor: this.dashboard.openBalance.minorUnits,
        currentMembership: actor,
        targets,
        canCreateManagedGuests: this.groupSettings.guestsEnabled && canBookOthers,
      }) as T;
    }
    if (resource === 'members' && method === 'GET') return clone(this.members) as T;
    if (resource === 'categories' && method === 'GET') return clone(this.categories) as T;
    if (resource === 'bookings' && method === 'GET') return this.listBookings(groupId) as T;
    if (resource === 'bookings' && method === 'POST') return this.createBooking(groupId, body as BookingCommand) as T;
    if (resource === 'bookings/batch' && method === 'POST') return this.createBookingBatch(groupId, body as BookingBatchCommand & { unitPriceMinor?: number }) as T;
    if (resource === 'accounts/me') return clone(this.ledger) as T;
    if (resource === 'accounts' && method === 'GET') return clone(this.accountSummaries) as T;
    if (resource === 'payments' && method === 'GET') return clone(this.payments) as T;
    if (resource === 'payments' && method === 'POST') return this.createPayment(body as PaymentCommand) as T;
    if (resource === 'payments/self' && method === 'POST') return this.createOwnPayment(groupId, body as SelfPaymentCommand & { amountMinor?: number }) as T;
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
      const member = this.members.find((entry) => entry.id === memberClaimMatch[1] && entry.active && entry.isGuest && entry.email === null);
      if (!member || !this.groupSettings.guestRoleId) throw new Error('A managed guest and configured guest role are required.');
      const email = String((body as { email?: string }).email ?? '').trim().toLowerCase();
      const invitation = this.createInvitation(groupId, {
        email,
        displayName: member.displayName,
        roleIds: [this.groupSettings.guestRoleId],
        roles: ['MEMBER'],
        groupPermissions: [],
        categoryPermissions: [],
      });
      invitation.targetMembershipId = member.id;
      const stored = this.invitations.find((entry) => entry.id === invitation.id);
      if (stored) stored.targetMembershipId = member.id;
      return clone(invitation) as T;
    }
    const memberMatch = resource.match(/^members\/([^/]+)$/);
    if (memberMatch && method === 'PATCH') {
      const member = this.members.find((entry) => entry.id === memberMatch[1] && entry.active && entry.isGuest && entry.email === null);
      const displayName = String((body as { displayName?: string }).displayName ?? '').trim().replace(/\s+/g, ' ');
      if (!member || !displayName || [...displayName].length > 120 || /\p{Cc}/u.test(displayName)) throw new Error('A valid managed guest display name is required.');
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
    if (paymentReverseMatch && method === 'POST') return this.reversePayment(paymentReverseMatch[1]) as T;
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
    return clone(this.session);
  }

  private acceptInvitation(command: InvitationCommand): Session {
    const invitationId = [...this.invitationTokens].find(([, token]) => token === command.token)?.[0];
    const invitation = this.invitations.find((item) => item.id === invitationId);
    if (invitation) {
      invitation.acceptedAt = new Date().toISOString();
      this.invitationTokens.delete(invitation.id);
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
    return { displayName: invitation.displayName ?? account?.displayName ?? '', existingAccount: Boolean(account) };
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

  /** Derives deprecated role strings only from seeded preset assignments. */
  private legacyRolesForRoleIds(roleIds: readonly string[]): Membership['roles'] {
    const roles = new Set<Membership['roles'][number]>();
    for (const roleId of roleIds) {
      const preset = this.roles.find((role) => role.id === roleId)?.presetKey;
      if (preset === 'GROUP_ADMINISTRATOR') roles.add('ADMIN');
      if (preset === 'FINANCE_MANAGER') roles.add('FINANCE_MANAGER');
      if (preset === 'CATALOG_MANAGER') roles.add('CATALOG_MANAGER');
    }
    return [...roles];
  }

  /** Replaces legacy presets while preserving every custom role assignment. */
  private roleIdsForLegacyUpdate(currentRoleIds: readonly string[], roles: readonly Membership['roles'][number][], groupPermissions: readonly string[]): string[] {
    const legacyPreset = new Map<Membership['roles'][number], Role['presetKey']>([
      ['ADMIN', 'GROUP_ADMINISTRATOR'],
      ['FINANCE_MANAGER', 'FINANCE_MANAGER'],
      ['CATALOG_MANAGER', 'CATALOG_MANAGER'],
      ['MEMBER', 'MEMBER'],
    ]);
    const migrationRole = this.roles.find((role) => role.id === 'role-self-payment');
    const preservedCustom = currentRoleIds.filter((roleId) => {
      const role = this.roles.find((entry) => entry.id === roleId);
      return role && !role.presetKey && role.id !== migrationRole?.id;
    });
    const presetRoleIds = roles.flatMap((legacyRole) => {
      const preset = legacyPreset.get(legacyRole);
      const role = this.roles.find((entry) => entry.presetKey === preset);
      return role ? [role.id] : [];
    });
    const selfPaymentRoleIds = groupPermissions.includes('SELF_RECORD_PAYMENT') && migrationRole ? [migrationRole.id] : [];
    return this.normalizedRoleIds([...preservedCustom, ...presetRoleIds, ...selfPaymentRoleIds]);
  }

  /** Normalizes an explicit role selection to unique, known identifiers. */
  private normalizedRoleIds(roleIds: readonly string[]): string[] {
    const known = new Set(this.roles.map((role) => role.id));
    return [...new Set(roleIds.filter((roleId) => known.has(roleId)))];
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
    if (role.presetKey === 'GROUP_ADMINISTRATOR' || changesAdministration) this.requirePermission(groupId, 'GROUP_ADMINISTRATION');
    if (role.nameLocked && name !== role.name) throw new Error('This role name is protected.');
    if (role.presetKey === 'GROUP_ADMINISTRATOR') {
      if (name !== role.name) throw new Error('The group administrator role cannot be renamed.');
      if (!ADMIN_CORE.every((permission) => input.grants.some((grant) => grant.permission === permission))) throw new Error('Administrator core permissions cannot be removed.');
    }
    if (this.groupSettings.defaultRoleId === roleId && input.grants.some((grant) => grant.permission === 'GROUP_ADMINISTRATION')) throw new Error('The default role must not grant group administration.');
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
    if (changedRoleIds.some((roleId) => roleId !== adminRole?.id)) this.requirePermission(groupId, 'ROLE_MANAGEMENT');
    const changedAdministrativeRole = changedRoleIds.some((roleId) => {
      const changed = currentRoleIds.includes(roleId) !== normalized.includes(roleId);
      return changed && this.roles.find((role) => role.id === roleId)?.grants.some((grant) => grant.permission === 'GROUP_ADMINISTRATION');
    });
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

  private createBooking(groupId: string, command: BookingCommand & { unitPriceMinor?: number }): Booking {
    const product = this.categories.flatMap((category) => category.products).find((entry) => entry.id === command.productId);
    const target = this.members.find((member) => member.id === command.targetMembershipId) ?? this.members.find((member) => member.userId === this.session.user.id);
    const actor = this.currentMembership(groupId);
    const category = this.categories.find((entry) => entry.id === product?.categoryId);
    if (!product || !target || !actor || !category) throw new Error(i18n.t('errors.missingProductOrMember'));
    if (target.id !== actor.id && !can(actor.effectiveGrants, 'BOOK_FOR_OTHERS')) throw new Error(i18n.t('admin.noAccessMessage'));
    if (target.id === actor.id && !can(actor.effectiveGrants, 'CREATE_OWN_BOOKING')) throw new Error(i18n.t('admin.noAccessMessage'));
    if (target.id !== actor.id && !command.reason?.trim()) throw new Error(i18n.t('booking.reasonRequired'));
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
      reason: command.reason?.trim() || undefined,
      status: 'POSTED',
      voidWithoutReasonUntil: new Date(Date.now() + 30_000).toISOString(),
      canVoid: false,
      voidReasonRequired: false,
    };
    this.bookings.unshift(booking);
    this.dashboard.recentBookings.unshift(booking);
    this.dashboard.recentBookings = this.dashboard.recentBookings.slice(0, 5);
    this.dashboard.openBalance.minorUnits = (BigInt(this.dashboard.openBalance.minorUnits) + totalMinorUnits).toString();
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
    const managedGuestNames = (command.managedGuestDisplayNames ?? []).map((name) => name.trim().replace(/\s+/g, ' '));
    const combinedTargetCount = targets.length + managedGuestNames.length;
    if (combinedTargetCount < 1
      || combinedTargetCount > 100
      || targets.some((target) => !target)
      || new Set(targets).size !== targets.length
      || managedGuestNames.some((name) => !name || [...name].length > 120 || /\p{Cc}/u.test(name))) {
      throw new Error(i18n.t('booking.noAvailableTarget'));
    }
    const actor = this.currentMembership(groupId);
    const membersById = new Map(this.members.filter((member) => member.active).map((member) => [member.id, member]));
    if (!actor || targets.some((target) => !membersById.has(target))) throw new Error(i18n.t('errors.missingProductOrMember'));
    const includesOwn = targets.includes(actor.id);
    const includesOthers = managedGuestNames.length > 0 || targets.some((target) => target !== actor.id);
    if (includesOwn && !can(actor.effectiveGrants, 'CREATE_OWN_BOOKING')) throw new Error(i18n.t('admin.noAccessMessage'));
    if (includesOthers && !can(actor.effectiveGrants, 'BOOK_FOR_OTHERS')) throw new Error(i18n.t('admin.noAccessMessage'));
    if (managedGuestNames.length > 0 && !this.groupSettings.guestsEnabled) throw new Error(i18n.t('admin.noAccessMessage'));
    if (includesOthers && !command.reason?.trim()) throw new Error(i18n.t('booking.reasonRequired'));
    const guestMembershipIds = managedGuestNames.map((displayName) => {
      const membership: Membership = {
        id: identifier('member-guest'),
        userId: identifier('user-guest'),
        displayName,
        email: null,
        initials: displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join(''),
        isGuest: true,
        roles: ['MEMBER'],
        roleIds: [],
        effectiveGrants: [],
        groupPermissions: [],
        categoryPermissions: [],
        roleAssignmentsVersion: 1,
        active: true,
      };
      this.members.push(membership);
      return membership.id;
    });
    return [...targets, ...guestMembershipIds].map((targetMembershipId) => this.createBooking(groupId, { ...command, targetMembershipId }));
  }

  private listBookings(groupId: string): Booking[] {
    const actor = this.currentMembership(groupId);
    if (!actor) return [];
    const canViewAll = can(actor.effectiveGrants, 'VIEW_ALL_BOOKING_ACTIVITY');
    return clone(this.bookings
      .filter((booking) => canViewAll || booking.memberId === actor.id || booking.bookedByMemberId === actor.id)
      .map((booking) => this.bookingWithPermissions(booking, actor)));
  }

  private bookingWithPermissions(booking: Booking, actor: Membership): Booking {
    const createdByActor = booking.bookedByMemberId === actor.id;
    const affectsActor = booking.memberId === actor.id;
    const canVoid = booking.status === 'POSTED' && (can(actor.effectiveGrants, 'VOID_ANY_BOOKING') || (createdByActor || affectsActor) && can(actor.effectiveGrants, 'VOID_OWN_BOOKING'));
    const deadline = booking.voidWithoutReasonUntil ?? booking.undoUntil ?? new Date(Date.parse(booking.bookedAt) + 30_000).toISOString();
    const withinReasonlessWindow = createdByActor && Date.parse(deadline) > Date.now();
    const reasonRequired = canVoid && !withinReasonlessWindow;
    return { ...booking, canVoid, voidReasonRequired: reasonRequired, voidWithoutReasonUntil: canVoid && withinReasonlessWindow ? deadline : undefined, undoUntil: undefined };
  }

  private reverseBooking(groupId: string, id: string, reason: string): Booking {
    const booking = this.bookings.find((entry) => entry.id === id);
    const actor = this.currentMembership(groupId);
    if (!booking) throw new Error(i18n.t('errors.bookingNotFound'));
    if (!actor) throw new Error(i18n.t('errors.memberNotFound'));
    const authorized = this.bookingWithPermissions(booking, actor);
    if (!authorized.canVoid) throw new Error(i18n.t('admin.noAccessMessage'));
    if (authorized.voidReasonRequired && !reason.trim()) throw new Error(i18n.t('activities.reasonRequired'));
    if (booking.status === 'POSTED') this.adjustAccountBalance(booking.memberId, -BigInt(booking.total.minorUnits));
    booking.status = 'REVERSED';
    booking.canVoid = false;
    return clone(this.bookingWithPermissions(booking, actor));
  }

  private updatePermissions(groupId: string, id: string, update: PermissionUpdate & { categoryGrants?: Record<string, string[]> }, expectedVersion: number): Membership {
    this.requirePermission(groupId, 'GROUP_ADMINISTRATION');
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
    const adminRole = this.roles.find((entry) => entry.presetKey === 'GROUP_ADMINISTRATOR');
    if (adminRole && member.roleIds?.includes(adminRole.id) && this.activeAdministratorCount() <= 1) {
      throw new Error('The last active administrator cannot be removed.');
    }
    member.active = false;
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
    if (input.roleIds !== undefined) this.requirePermission(groupId, 'ROLE_MANAGEMENT');
    const email = input.email.trim().toLowerCase();
    if (this.members.some((member) => member.active && member.email?.toLowerCase() === email)) throw new Error('An active membership already exists for this email address.');
    if (this.invitations.some((item) => !item.acceptedAt && !item.revokedAt && Date.parse(item.expiresAt) > Date.now() && item.email.toLowerCase() === email)) throw new Error('An active invitation already exists for this email address.');
    const token = crypto.randomUUID();
    const selectedRoleIds = this.normalizedRoleIds(input.roleIds ?? []);
    if (selectedRoleIds.length === 0) throw new Error('At least one role is required.');
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

  private createPayment(command: PaymentCommand & { amountMinor?: number }): Payment {
    const member = this.members.find((entry) => entry.id === command.membershipId);
    if (!member) throw new Error(i18n.t('errors.memberNotFound'));
    const payment: Payment = {
      id: identifier('payment'),
      memberName: member.displayName,
      status: 'POSTED',
      ...command,
      amount: command.amount ?? { minorUnits: String(command.amountMinor ?? 0), currency: 'EUR' },
    };
    this.payments.unshift(payment);
    const paymentMinor = BigInt(payment.amount.minorUnits);
    this.adjustAccountBalance(member.id, -paymentMinor);
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

  private createOwnPayment(groupId: string, command: SelfPaymentCommand & { amountMinor?: number }): Payment {
    const membershipId = this.session.groups.find((group) => group.id === groupId)?.membership?.id;
    const member = this.members.find((entry) => entry.id === membershipId && entry.active);
    if (!member) throw new Error(i18n.t('errors.memberNotFound'));
    if (!can(member.effectiveGrants, 'RECORD_OWN_PAYMENT')) throw new Error(i18n.t('financeWorkspace.noAccessMessage'));
    const amountMinor = BigInt(command.amount?.minorUnits ?? command.amountMinor ?? 0);
    if (amountMinor <= 0n) throw new Error(i18n.t('errors.amountFormat'));
    if (amountMinor > 100_000_000_000n) throw new Error(i18n.t('errors.amountRange'));
    if (!command.receivedAt || Number.isNaN(Date.parse(command.receivedAt))) throw new Error(i18n.t('errors.requestFailed'));
    if (!['BANK_TRANSFER', 'CASH', 'PAYPAL', 'OTHER'].includes(command.method)) throw new Error(i18n.t('errors.requestFailed'));
    if (!command.reference?.trim()) throw new Error(i18n.t('selfPayment.referenceRequired'));
    return this.createPayment({
      membershipId: member.id,
      amount: command.amount ?? { minorUnits: amountMinor.toString(), currency: 'EUR' },
      receivedAt: command.receivedAt,
      method: command.method,
      reference: command.reference.trim(),
    });
  }

  private reversePayment(id: string): void {
    const payment = this.payments.find((entry) => entry.id === id);
    if (!payment) throw new Error(i18n.t('errors.paymentNotFound'));
    if (payment.status === 'POSTED') this.adjustAccountBalance(payment.membershipId, BigInt(payment.amount.minorUnits));
    payment.status = 'REVERSED';
  }

  /** Applies an exact balance movement to one demo account summary. */
  private adjustAccountBalance(membershipId: string, amount: bigint): void {
    const account = this.accountSummaries.find((entry) => entry.membershipId === membershipId);
    if (!account) return;
    account.balance.minorUnits = (BigInt(account.balance.minorUnits) + amount).toString();
  }

  private closePeriod(id: string, input: { label: string; dueAt: string }): Period {
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
