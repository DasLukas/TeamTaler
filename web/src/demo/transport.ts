import type {
  Booking,
  BookingCommand,
  Category,
  CreatedInvitation,
  InvitationEmailRetryResult,
  InvitationImportResult,
  InvitationImportRow,
  InvitationCommand,
  InvitationMetadata,
  LoginCommand,
  Membership,
  Notification,
  Payment,
  PaymentCommand,
  Period,
  PermissionUpdate,
  Product,
  Session,
} from '@/api/types';
import {
  demoAudit,
  demoBookings,
  demoCategories,
  demoDashboard,
  demoLedger,
  demoMembers,
  demoNotifications,
  demoPayments,
  demoPeriods,
  demoSession,
  demoSettlements,
} from './data';
import i18n from '@/i18n';

type DemoRequestInit = RequestInit;

const clone = <T,>(value: T): T => structuredClone(value);
const identifier = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

interface DemoImportCandidate {
  row: number;
  email: string;
  displayName: string;
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
  if (emailIndex < 0) throw new Error('The CSV header must contain an email column.');
  const result: DemoImportCandidate[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    const cells = parseDemoCsvRecord(lines[index], delimiter);
    result.push({
      row: index + 1,
      email: (cells[emailIndex] ?? '').trim().toLowerCase(),
      displayName: displayNameIndex >= 0 ? (cells[displayNameIndex] ?? '').trim() : '',
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
  private payments = clone(demoPayments);
  private periods = clone(demoPeriods);
  private settlements = clone(demoSettlements);
  private notifications = clone(demoNotifications);
  private audit = clone(demoAudit);
  private invitations: InvitationMetadata[] = [];

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
    if (cleanPath === '/auth/login' && method === 'POST') return this.login(body as LoginCommand) as T;
    if (cleanPath === '/auth/logout' && method === 'POST') return undefined as T;
    if ((cleanPath === '/auth/invitations/accept' || cleanPath === '/invitations/accept') && method === 'POST') return this.acceptInvitation(body as InvitationCommand) as T;
    if (cleanPath === '/groups') return clone(this.session.groups) as T;

    const groupMatch = cleanPath.match(/^\/groups\/([^/]+)\/(.+)$/);
    if (!groupMatch) throw new Error(`Development demo endpoint not implemented: ${method} ${path}`);
    const [, groupId, resource] = groupMatch;

    if (resource === 'dashboard') return clone(this.dashboard) as T;
    if (resource === 'members' && method === 'GET') return clone(this.members) as T;
    if (resource === 'categories' && method === 'GET') return clone(this.categories) as T;
    if (resource === 'bookings' && method === 'GET') return clone(this.bookings) as T;
    if (resource === 'bookings' && method === 'POST') return this.createBooking(body as BookingCommand) as T;
    if (resource === 'accounts/me') return clone(this.ledger) as T;
    if (resource === 'payments' && method === 'GET') return clone(this.payments) as T;
    if (resource === 'payments' && method === 'POST') return this.createPayment(body as PaymentCommand) as T;
    if (resource === 'periods' && method === 'GET') return clone(this.periods) as T;
    if (resource === 'settlements' && method === 'GET') return clone(this.settlements) as T;
    if (resource === 'notifications' && method === 'GET') return clone(this.notifications) as T;
    if (resource === 'audit' && method === 'GET') return clone(this.audit) as T;
    if (resource === 'invitations/import' && method === 'POST') return this.importInvitations(body as string) as T;
    if (resource === 'invitations' && method === 'GET') return this.listInvitations() as T;
    if (resource === 'invitations' && method === 'POST') return this.createInvitation(body as { email?: string; displayName?: string; expiresInDays?: number }) as T;
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
    if (permissionMatch && method === 'PATCH') return this.updatePermissions(permissionMatch[1], body as PermissionUpdate & { categoryGrants?: Record<string, string[]> }) as T;
    const bookingReversalMatch = resource.match(/^bookings\/([^/]+)\/(?:reversal|void)$/);
    if (bookingReversalMatch && method === 'POST') return this.reverseBooking(bookingReversalMatch[1]) as T;
    const periodCloseMatch = resource.match(/^periods\/([^/]+)\/close$/);
    if (periodCloseMatch && method === 'POST') return this.closePeriod(periodCloseMatch[1], body as { label: string; dueAt: string }) as T;
    const notificationMatch = resource.match(/^notifications\/([^/]+)$/);
    if (notificationMatch && method === 'PATCH') return this.markNotificationRead(notificationMatch[1]) as T;
    const paymentReverseMatch = resource.match(/^payments\/([^/]+)\/reverse$/);
    if (paymentReverseMatch && method === 'POST') return this.reversePayment(paymentReverseMatch[1]) as T;
    const productCreateMatch = resource.match(/^categories\/([^/]+)\/products$/);
    if (productCreateMatch && method === 'POST') {
      const input = body as { name?: string; priceMinor?: number; sortOrder?: number };
      return this.createProduct({ categoryId: productCreateMatch[1], name: input.name, price: { minorUnits: String(input.priceMinor ?? 0), currency: 'EUR' }, sortOrder: input.sortOrder } as Partial<Product>) as T;
    }
    const productImageMatch = resource.match(/^products\/([^/]+)\/image$/);
    if (productImageMatch && method === 'POST') return { imageUrl: '' } as T;
    const invitationEmailRetryMatch = resource.match(/^invitations\/([^/]+)\/email\/retry$/);
    if (invitationEmailRetryMatch && method === 'POST') return this.retryInvitationEmail(invitationEmailRetryMatch[1]) as T;

    throw new Error(`Development demo endpoint not implemented: ${method} ${path}`);
  }

  private login(command: LoginCommand): Session {
    if (!command.email.includes('@') || command.password.length < 8) {
      throw new Error(i18n.t('errors.invalidDemoCredentials'));
    }
    return clone(this.session);
  }

  private acceptInvitation(command: InvitationCommand): Session {
    this.session.user.displayName = command.displayName;
    return clone(this.session);
  }

  private createBooking(command: BookingCommand): Booking {
    const product = this.categories.flatMap((category) => category.products).find((entry) => entry.id === command.productId);
    const target = this.members.find((member) => member.id === command.targetMembershipId) ?? this.members.find((member) => member.userId === this.session.user.id);
    const category = this.categories.find((entry) => entry.id === product?.categoryId);
    if (!product || !target || !category) throw new Error(i18n.t('errors.missingProductOrMember'));
    const totalMinorUnits = BigInt(product.price.minorUnits) * BigInt(command.quantity);
    const booking: Booking = {
      id: identifier('booking'),
      memberId: target.id,
      memberName: target.displayName,
      productId: product.id,
      productName: product.name,
      categoryId: category.id,
      categoryName: category.name,
      quantity: command.quantity,
      unitPrice: product.price,
      total: { minorUnits: totalMinorUnits.toString(), currency: product.price.currency },
      bookedAt: new Date().toISOString(),
      bookedByName: this.session.user.displayName,
      reason: command.reason,
      status: 'POSTED',
      undoUntil: new Date(Date.now() + 30_000).toISOString(),
      canVoid: true,
    };
    this.bookings.unshift(booking);
    this.dashboard.recentBookings.unshift(booking);
    this.dashboard.recentBookings = this.dashboard.recentBookings.slice(0, 5);
    this.dashboard.openBalance.minorUnits = (BigInt(this.dashboard.openBalance.minorUnits) + totalMinorUnits).toString();
    const categoryTotal = this.dashboard.categoryTotals.find((entry) => entry.categoryId === category.id);
    if (categoryTotal) categoryTotal.total.minorUnits = (BigInt(categoryTotal.total.minorUnits) + totalMinorUnits).toString();
    const groupCategoryTotal = this.dashboard.groupCategoryTotals.find((entry) => entry.categoryId === category.id);
    if (groupCategoryTotal) {
      groupCategoryTotal.total.minorUnits = (BigInt(groupCategoryTotal.total.minorUnits) + totalMinorUnits).toString();
      groupCategoryTotal.quantity = (groupCategoryTotal.quantity ?? 0) + command.quantity;
    }
    return clone(booking);
  }

  private reverseBooking(id: string): Booking {
    const booking = this.bookings.find((entry) => entry.id === id);
    if (!booking) throw new Error(i18n.t('errors.bookingNotFound'));
    booking.status = 'REVERSED';
    return clone(booking);
  }

  private updatePermissions(id: string, update: PermissionUpdate & { categoryGrants?: Record<string, string[]> }): Membership {
    const member = this.members.find((entry) => entry.id === id);
    if (!member) throw new Error(i18n.t('errors.memberNotFound'));
    member.roles = update.roles;
    member.categoryPermissions = update.categoryPermissions ?? Object.entries(update.categoryGrants ?? {}).map(([categoryId, permissions]) => ({ categoryId, assignToOthers: permissions.includes('ASSIGN_TO_OTHERS'), voidBookings: permissions.includes('VOID_BOOKINGS') }));
    member.etag = `"${id}-${Date.now()}"`;
    return clone(member);
  }

  private createCategory(input: Partial<Category>): Category {
    const category: Category = {
      id: identifier('category'),
      name: input.name ?? i18n.t('demo.newCategory'),
      icon: input.icon ?? 'other',
      active: true,
      products: [],
    };
    this.categories.push(category);
    return clone(category);
  }

  private createInvitation(input: { email?: string; displayName?: string; expiresInDays?: number }): CreatedInvitation {
    const token = crypto.randomUUID();
    const invitation: CreatedInvitation = {
      id: identifier('invitation'),
      email: input.email,
      expiresAt: new Date(Date.now() + (input.expiresInDays || 7) * 86_400_000).toISOString(),
      acceptUrl: `${window.location.origin}/invite#token=${token}`,
    };
    this.invitations.unshift({
      id: invitation.id,
      email: input.email ?? '',
      displayName: input.displayName,
      expiresAt: invitation.expiresAt,
      emailDeliveryStatus: 'NOT_REQUESTED',
    });
    return invitation;
  }

  /**
   * Imports member invitation rows and queues simulated email delivery.
   *
   * @param document - UTF-8 CSV text containing the invitation candidates.
   * @returns Row-level import outcomes and aggregate counters.
   * @throws Error when the CSV header or data rows are missing.
   */
  private importInvitations(document: string): InvitationImportResult {
    const candidates = parseDemoMemberCsv(document);
    const memberEmails = new Set(this.members.map((member) => member.email.toLowerCase()));
    const existingInvitations = new Map(this.invitations.map((invitation) => [invitation.email.toLowerCase(), invitation]));
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
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        emailDeliveryStatus: 'PENDING',
      };
      this.invitations.unshift(invitation);
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
    const invitation = this.invitations.find((item) => item.id === invitationId);
    if (!invitation) throw new Error('Invitation not found.');
    invitation.emailDeliveryStatus = 'PENDING';
    delete invitation.emailSentAt;
    return { invitationId, emailDeliveryStatus: 'PENDING' };
  }

  private createProduct(input: Partial<Product>): Product {
    const category = this.categories.find((entry) => entry.id === input.categoryId);
    if (!category) throw new Error(i18n.t('errors.categoryNotFound'));
    const product: Product = {
      id: identifier('product'),
      categoryId: category.id,
      version: 1,
      name: input.name ?? i18n.t('demo.newProduct'),
      price: input.price ?? { minorUnits: '0', currency: 'EUR' },
      imageUrl: input.imageUrl,
      active: true,
      sortOrder: category.products.length + 1,
    };
    category.products.push(product);
    return clone(product);
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
    return clone(payment);
  }

  private reversePayment(id: string): void {
    const payment = this.payments.find((entry) => entry.id === id);
    if (!payment) throw new Error(i18n.t('errors.paymentNotFound'));
    payment.status = 'REVERSED';
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
