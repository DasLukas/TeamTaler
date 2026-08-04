import type {
  Booking,
  BookingCommand,
  Category,
  InvitationCommand,
  Invitation,
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
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    const cleanPath = path.split('?')[0];

    if (cleanPath === '/session' || cleanPath === '/me') return clone(this.session) as T;
    if (cleanPath === '/auth/login' && method === 'POST') return this.login(body as LoginCommand) as T;
    if (cleanPath === '/auth/logout' && method === 'POST') return undefined as T;
    if ((cleanPath === '/auth/invitations/accept' || cleanPath === '/invitations/accept') && method === 'POST') return this.acceptInvitation(body as InvitationCommand) as T;
    if (cleanPath === '/groups') return clone(this.session.groups) as T;

    const groupMatch = cleanPath.match(/^\/groups\/([^/]+)\/(.+)$/);
    if (!groupMatch) throw new Error(`Development demo endpoint not implemented: ${method} ${path}`);
    const [, , resource] = groupMatch;

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
    if (resource === 'invitations' && method === 'POST') return this.createInvitation(body as { email?: string; expiresInDays: number }) as T;
    if (resource === 'categories' && method === 'POST') return this.createCategory(body as Partial<Category>) as T;

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
      type: input.type ?? 'STANDARD',
      icon: input.icon ?? 'other',
      active: true,
      products: [],
    };
    this.categories.push(category);
    return clone(category);
  }

  private createInvitation(input: { email?: string; expiresInDays: number }): Invitation {
    const token = crypto.randomUUID();
    return {
      id: identifier('invitation'),
      email: input.email,
      expiresAt: new Date(Date.now() + (input.expiresInDays || 7) * 86_400_000).toISOString(),
      acceptUrl: `${window.location.origin}/invite#${token}`,
    };
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
