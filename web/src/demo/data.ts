import type {
  AccountSummary,
  AuditEntry,
  Booking,
  Category,
  Dashboard,
  LedgerEntry,
  Membership,
  Notification,
  Payment,
  PermissionDefinition,
  PermissionGrant,
  PermissionKey,
  Period,
  Role,
  Session,
  Settlement,
} from '@/api/types';
import beerImageUrl from './assets/beer.webp';
import sodaImageUrl from './assets/soda.webp';
import waterImageUrl from './assets/water.webp';

const grants = (...permissions: PermissionKey[]): PermissionGrant[] => permissions.map((permission) => ({ permission, scope: { type: 'GROUP' } }));

const demoAdministratorRoleIds = ['role-admin', 'role-member', 'role-finance', 'role-catalog'];
const demoAdministratorGrants = grants('GROUP_ADMINISTRATION', 'MEMBER_MANAGEMENT', 'ROLE_MANAGEMENT', 'FINANCE_MANAGEMENT', 'CATALOG_MANAGEMENT', 'VIEW_MEMBER_DIRECTORY', 'VIEW_MEMBER_STATISTICS', 'VIEW_GROUP_STATISTICS', 'VIEW_ALL_BOOKING_ACTIVITY', 'RECORD_OWN_PAYMENT', 'CREATE_OWN_BOOKING', 'VOID_OWN_BOOKING', 'VOID_ANY_BOOKING', 'BOOK_FOR_OTHERS', 'BOOK_FOR_GUESTS');

/** Stable permission registry returned by the development transport. */
export const demoPermissionDefinitions: PermissionDefinition[] = [
  { key: 'GROUP_ADMINISTRATION' },
  { key: 'MEMBER_MANAGEMENT', impliedPermissions: ['VIEW_MEMBER_DIRECTORY'] },
  { key: 'ROLE_MANAGEMENT' },
  { key: 'FINANCE_MANAGEMENT' },
  { key: 'CATALOG_MANAGEMENT' },
  { key: 'VIEW_MEMBER_DIRECTORY' },
  { key: 'VIEW_MEMBER_STATISTICS' },
  { key: 'VIEW_GROUP_STATISTICS' },
  { key: 'VIEW_ALL_BOOKING_ACTIVITY', impliedPermissions: ['VIEW_MEMBER_STATISTICS'] },
  { key: 'RECORD_OWN_PAYMENT' },
  { key: 'CREATE_OWN_BOOKING' },
  { key: 'VOID_OWN_BOOKING' },
  { key: 'VOID_ANY_BOOKING', impliedPermissions: ['VOID_OWN_BOOKING', 'VIEW_ALL_BOOKING_ACTIVITY'] },
  { key: 'BOOK_FOR_OTHERS' },
  { key: 'BOOK_FOR_GUESTS' },
];

/** Group-owned demo roles including one migrated direct-permission role. */
export const demoRoles: Role[] = [
  {
    id: 'role-admin',
    groupId: 'group-sv-adler',
    presetKey: 'GROUP_ADMINISTRATOR',
    name: 'Group administrator',
    description: 'Standardrolle für Administratorrolle mit vollständigem Zugriff auf die Gruppe',
    nameLocked: true,
    deletable: false,
    grants: grants('GROUP_ADMINISTRATION', 'MEMBER_MANAGEMENT', 'ROLE_MANAGEMENT', 'VIEW_MEMBER_DIRECTORY'),
    version: 1,
    memberCount: 1,
    pendingInvitationCount: 0,
  },
  { id: 'role-member', groupId: 'group-sv-adler', name: 'Mitglied', description: 'Standardrolle für reguläre Gruppenmitglieder', nameLocked: false, deletable: true, grants: grants('CREATE_OWN_BOOKING', 'VIEW_MEMBER_DIRECTORY'), version: 1, memberCount: 3, pendingInvitationCount: 0 },
  { id: 'role-finance', groupId: 'group-sv-adler', name: 'Finanzverwaltung', description: 'Standardrolle für Finanzverwaltung', nameLocked: false, deletable: true, grants: grants('FINANCE_MANAGEMENT', 'RECORD_OWN_PAYMENT', 'VIEW_ALL_BOOKING_ACTIVITY', 'VIEW_GROUP_STATISTICS', 'VIEW_MEMBER_DIRECTORY'), version: 1, memberCount: 2, pendingInvitationCount: 0 },
  { id: 'role-catalog', groupId: 'group-sv-adler', name: 'Katalogverwaltung', description: 'Standardrolle für Katalogverwaltung', nameLocked: false, deletable: true, grants: grants('CATALOG_MANAGEMENT', 'VIEW_MEMBER_DIRECTORY'), version: 1, memberCount: 2, pendingInvitationCount: 0 },
  { id: 'role-guest', groupId: 'group-sv-adler', name: 'Gast', description: 'Standardrolle für Gäste', nameLocked: false, deletable: true, grants: grants('CREATE_OWN_BOOKING'), version: 1, memberCount: 0, pendingInvitationCount: 0 },
  { id: 'role-self-payment', groupId: 'group-sv-adler', name: 'Eigene Einzahlungen', description: 'Aus dem bisherigen Einzelrecht migriert', nameLocked: false, deletable: true, grants: grants('RECORD_OWN_PAYMENT'), version: 1, memberCount: 1, pendingInvitationCount: 0 },
];

/** Demo session used only by the development transport. */
export const demoSession: Session = {
  user: {
    id: 'user-lukas',
    displayName: 'Lukas Waschul',
    email: 'lukas@example.test',
  },
  groups: [
    { id: 'group-sv-adler', name: 'SV Adler', currency: 'EUR', defaultTheme: 'TEAMTALER', statisticsEnabled: true, membership: { id: 'member-lukas', roleIds: demoAdministratorRoleIds, effectiveGrants: demoAdministratorGrants, roles: ['ADMIN', 'MEMBER', 'FINANCE_MANAGER', 'CATALOG_MANAGER'], groupPermissions: ['SELF_RECORD_PAYMENT'], themeOverride: null } },
    { id: 'group-freunde', name: 'Kegelclub', currency: 'EUR', defaultTheme: 'NRW', statisticsEnabled: false, membership: { id: 'member-lukas-kegelclub', roleIds: ['role-member-kegel'], effectiveGrants: grants('CREATE_OWN_BOOKING', 'VOID_OWN_BOOKING'), roles: ['MEMBER'], groupPermissions: [], themeOverride: 'TIEF_IM_WESTEN' } },
  ],
  activeGroupId: 'group-sv-adler',
  defaultGroupId: null,
  colorMode: 'SYSTEM',
  systemRoles: [],
  demo: true,
};

/** Demo accounting periods used for visual and interaction testing. */
export const demoPeriods: Period[] = [
  { id: 'period-august', label: 'August 2026', status: 'OPEN', startsAt: '2026-08-01T00:00:00+02:00' },
  {
    id: 'period-july',
    label: 'Juli 2026',
    status: 'CLOSED',
    startsAt: '2026-07-01T00:00:00+02:00',
    closedAt: '2026-08-01T08:00:00+02:00',
    dueAt: '2026-08-15',
  },
];

/** Demo catalogue with representative product images. */
export const demoCategories: Category[] = [
  {
    id: 'category-drinks',
    version: 1,
    name: 'Getränke',
    icon: 'drink',
    active: true,
    sortOrder: 0,
    products: [
      {
        id: 'product-water',
        categoryId: 'category-drinks',
        version: 1,
        name: 'Wasser',
        pricingMode: 'FIXED',
        currency: 'EUR',
        price: { minorUnits: '100', currency: 'EUR' },
        imageUrl: waterImageUrl,
        active: true,
        sortOrder: 0,
      },
      {
        id: 'product-spezi',
        categoryId: 'category-drinks',
        version: 1,
        name: 'Spezi',
        pricingMode: 'FIXED',
        currency: 'EUR',
        price: { minorUnits: '150', currency: 'EUR' },
        imageUrl: sodaImageUrl,
        active: true,
        sortOrder: 1,
      },
      {
        id: 'product-beer',
        categoryId: 'category-drinks',
        version: 2,
        name: 'Bier',
        pricingMode: 'FIXED',
        currency: 'EUR',
        price: { minorUnits: '200', currency: 'EUR' },
        imageUrl: beerImageUrl,
        active: true,
        sortOrder: 2,
      },
    ],
  },
  {
    id: 'category-penalties',
    version: 1,
    name: 'Strafen',
    icon: 'penalty',
    active: true,
    sortOrder: 1,
    products: [
      {
        id: 'product-late',
        categoryId: 'category-penalties',
        version: 1,
        name: 'Zu spät zum Training',
        pricingMode: 'FIXED',
        currency: 'EUR',
        price: { minorUnits: '500', currency: 'EUR' },
        active: true,
        sortOrder: 0,
      },
      {
        id: 'product-kit',
        categoryId: 'category-penalties',
        version: 1,
        name: 'Ausrüstung vergessen',
        pricingMode: 'USER_DEFINED',
        currency: 'EUR',
        active: true,
        sortOrder: 1,
      },
    ],
  },
];

/** Demo memberships and their effective permissions. */
export const demoMembers: Membership[] = [
  {
    id: 'member-lukas',
    userId: 'user-lukas',
    displayName: 'Lukas Waschul',
    email: 'lukas@example.test',
    initials: 'LW',
    isTemporaryGuest: false,
    roles: ['ADMIN', 'MEMBER', 'FINANCE_MANAGER', 'CATALOG_MANAGER'],
    roleIds: demoAdministratorRoleIds,
    effectiveGrants: demoAdministratorGrants,
    groupPermissions: ['SELF_RECORD_PAYMENT'],
    categoryPermissions: [
      { categoryId: 'category-drinks', assignToOthers: true, voidBookings: true },
      { categoryId: 'category-penalties', assignToOthers: true, voidBookings: true },
    ],
    themeOverride: null,
    status: 'ACTIVE',
    active: true,
    etag: '"member-lukas-v1"',
  },
  {
    id: 'member-mara',
    userId: 'user-mara',
    displayName: 'Mara Becker',
    email: 'mara@example.test',
    initials: 'MB',
    isTemporaryGuest: false,
    roles: ['FINANCE_MANAGER', 'MEMBER'],
    roleIds: ['role-finance', 'role-member'],
    effectiveGrants: grants('FINANCE_MANAGEMENT', 'RECORD_OWN_PAYMENT', 'VIEW_ALL_BOOKING_ACTIVITY', 'VIEW_GROUP_STATISTICS', 'VIEW_MEMBER_DIRECTORY', 'CREATE_OWN_BOOKING'),
    groupPermissions: [],
    categoryPermissions: [
      { categoryId: 'category-drinks', assignToOthers: false, voidBookings: false },
      { categoryId: 'category-penalties', assignToOthers: true, voidBookings: true },
    ],
    themeOverride: null,
    status: 'ACTIVE',
    active: true,
    etag: '"member-mara-v1"',
  },
  {
    id: 'member-jonas',
    userId: 'user-jonas',
    displayName: 'Jonas Krüger',
    email: 'jonas@example.test',
    initials: 'JK',
    isTemporaryGuest: false,
    roles: ['CATALOG_MANAGER', 'MEMBER'],
    roleIds: ['role-catalog', 'role-member', 'role-self-payment'],
    effectiveGrants: grants('CATALOG_MANAGEMENT', 'VIEW_MEMBER_DIRECTORY', 'RECORD_OWN_PAYMENT', 'CREATE_OWN_BOOKING'),
    groupPermissions: ['SELF_RECORD_PAYMENT'],
    categoryPermissions: [
      { categoryId: 'category-drinks', assignToOthers: false, voidBookings: false },
      { categoryId: 'category-penalties', assignToOthers: true, voidBookings: false },
    ],
    themeOverride: null,
    status: 'ACTIVE',
    active: true,
    etag: '"member-jonas-v1"',
  },
];

/** Demo bookings shown in the activity feed. */
export const demoBookings: Booking[] = [
  {
    id: 'booking-1',
    memberId: 'member-lukas',
    memberName: 'Lukas Waschul',
    memberStatus: 'ACTIVE',
    productId: 'product-beer',
    productName: 'Bier',
    categoryId: 'category-drinks',
    categoryName: 'Getränke',
    quantity: 1,
    unitPrice: { minorUnits: '200', currency: 'EUR' },
    total: { minorUnits: '200', currency: 'EUR' },
    bookedAt: '2026-08-04T19:45:00+02:00',
    bookedByName: 'Lukas Waschul',
    bookedByStatus: 'ACTIVE',
    bookedByMemberId: 'member-lukas',
    status: 'POSTED',
    voidWithoutReasonUntil: '2026-08-04T19:45:30+02:00',
    voidReasonRequired: true,
    canVoid: true,
  },
  {
    id: 'booking-2',
    memberId: 'member-mara',
    memberName: 'Mara Becker',
    memberStatus: 'ACTIVE',
    productId: 'product-spezi',
    productName: 'Spezi',
    categoryId: 'category-drinks',
    categoryName: 'Getränke',
    quantity: 1,
    unitPrice: { minorUnits: '150', currency: 'EUR' },
    total: { minorUnits: '150', currency: 'EUR' },
    bookedAt: '2026-08-04T19:10:00+02:00',
    bookedByName: 'Mara Becker',
    bookedByStatus: 'ACTIVE',
    bookedByMemberId: 'member-mara',
    status: 'POSTED',
    voidReasonRequired: true,
    canVoid: true,
  },
  {
    id: 'booking-3',
    memberId: 'member-jonas',
    memberName: 'Jonas Krüger',
    memberStatus: 'ACTIVE',
    productId: 'product-late',
    productName: 'Zu spät zum Training',
    categoryId: 'category-penalties',
    categoryName: 'Strafen',
    quantity: 1,
    unitPrice: { minorUnits: '500', currency: 'EUR' },
    total: { minorUnits: '500', currency: 'EUR' },
    bookedAt: '2026-08-04T18:32:00+02:00',
    bookedByName: 'Mara Becker',
    bookedByStatus: 'ACTIVE',
    bookedByMemberId: 'member-mara',
    reason: '15 Minuten zu spät',
    status: 'POSTED',
    voidReasonRequired: true,
    canVoid: true,
  },
];

/** Demo dashboard values matching the approved desktop concept. */
export const demoDashboard: Dashboard = {
  openBalance: { minorUnits: '2340', currency: 'EUR' },
  groupOutstanding: { minorUnits: '2590', currency: 'EUR' },
  currentPeriod: demoPeriods[0],
  categoryTotals: [
    { categoryId: 'category-drinks', categoryName: 'Getränke', icon: 'drink', total: { minorUnits: '1840', currency: 'EUR' } },
    { categoryId: 'category-penalties', categoryName: 'Strafen', icon: 'penalty', total: { minorUnits: '500', currency: 'EUR' } },
  ],
  groupCategoryTotals: [
    { categoryId: 'category-drinks', categoryName: 'Getränke', icon: 'drink', quantity: 42, total: { minorUnits: '6240', currency: 'EUR' } },
    { categoryId: 'category-penalties', categoryName: 'Strafen', icon: 'penalty', quantity: 6, total: { minorUnits: '2500', currency: 'EUR' } },
  ],
  recentBookings: demoBookings,
};

/** Anonymous member-statistics wire projection used by the development API. */
export const demoMemberStatisticsWire = {
  meta: {
    generatedAt: '2026-08-28T12:30:00+02:00',
    timezone: 'Europe/Berlin',
    preset: 'LAST_30_DAYS',
    fromInclusive: '2026-07-30T00:00:00+02:00',
    toExclusive: '2026-08-28T12:30:00+02:00',
    bucket: 'DAY',
    privacyThresholdApplied: false,
    currentPeriodAvailable: false,
  },
  memberSnapshot: { regularMembers: 3, temporaryGuests: 0, asOf: '2026-08-28T12:30:00+02:00' },
  summary: { activeParticipants: 3, bookingCount: 47, validBookedUnits: 61, cancellationRate: 4 / 47 },
  activity: Array.from({ length: 30 }, (_, index) => ({
    periodStart: `${new Date(Date.UTC(2026, 6, 30 + index)).toISOString().slice(0, 10)}T00:00:00+02:00`,
    postedUnits: 2 + (index < 6 ? 1 : 0),
    reversedUnits: index < 5 ? 1 : 0,
  })),
  topCategories: {
    suppressed: false,
    items: [
      { categoryId: 'category-drinks', categoryName: 'Getränke', icon: 'drink', validBookedUnits: 51, isOther: false },
      { categoryId: 'category-penalties', categoryName: 'Strafen', icon: 'penalty', validBookedUnits: 8, isOther: false },
      { categoryId: '', categoryName: 'Other', icon: 'other', validBookedUnits: 2, isOther: true },
    ],
  },
  topProducts: {
    suppressed: false,
    items: [
      { productId: 'product-beer', productName: 'Bier', categoryId: 'category-drinks', categoryName: 'Getränke', validBookedUnits: 27, isOther: false },
      { productId: 'product-water', productName: 'Wasser', categoryId: 'category-drinks', categoryName: 'Getränke', validBookedUnits: 15, isOther: false },
      { productId: 'product-spezi', productName: 'Spezi', categoryId: 'category-drinks', categoryName: 'Getränke', validBookedUnits: 9, isOther: false },
      { productId: '', productName: 'Other', categoryId: '', categoryName: 'Other', validBookedUnits: 10, isOther: true },
    ],
  },
};

/** Exact-money finance-statistics wire projection used by the development API. */
export const demoFinanceStatisticsWire = {
  meta: {
    ...demoMemberStatisticsWire.meta,
  },
  currency: 'EUR',
  receivableSnapshot: {
    asOf: '2026-08-28T12:30:00+02:00',
    grossReceivableMinor: '3340',
    memberCreditMinor: '750',
    netReceivableMinor: '2590',
    openAccountCount: 2,
    balancedAccountCount: 1,
    creditAccountCount: 1,
  },
  flows: {
    openingNetReceivableMinor: '1800',
    netBookingChargesMinor: '8240',
    netPaymentsMinor: '6900',
    netAdjustmentsMinor: '-550',
    closingNetReceivableMinor: '2590',
  },
  series: (() => {
    let closing = 1800;
    return Array.from({ length: 30 }, (_, index) => {
      const charges = 274 + (index < 20 ? 1 : 0);
      const payments = 230;
      const adjustments = index < 11 ? -50 : 0;
      closing += charges - payments + adjustments;
      return {
        periodStart: `${new Date(Date.UTC(2026, 6, 30 + index)).toISOString().slice(0, 10)}T00:00:00+02:00`,
        netBookingChargesMinor: String(charges),
        netPaymentsMinor: String(payments),
        netAdjustmentsMinor: String(adjustments),
        closingNetReceivableMinor: String(closing),
      };
    });
  })(),
  categories: [
    { categoryId: 'category-drinks', categoryName: 'Getränke', icon: 'drink', netBookingChargesMinor: '6240', isOther: false },
    { categoryId: 'category-penalties', categoryName: 'Strafen', icon: 'penalty', netBookingChargesMinor: '2500', isOther: false },
    { categoryId: '', categoryName: 'Other', icon: 'other', netBookingChargesMinor: '-500', isOther: true },
  ],
  overdue: null,
};

/** Demo account ledger. */
export const demoLedger: LedgerEntry[] = [
  { id: 'ledger-1', occurredAt: '2026-08-04T19:45:00+02:00', kind: 'BOOKING', description: 'Bier', amount: { minorUnits: '200', currency: 'EUR' }, balance: { minorUnits: '2340', currency: 'EUR' }, referenceId: 'booking-1' },
  { id: 'ledger-correction-1', occurredAt: '2026-08-03T14:20:00+02:00', kind: 'CREDIT', description: 'Manual correction', amount: { minorUnits: '-150', currency: 'EUR' }, balance: { minorUnits: '2140', currency: 'EUR' }, referenceId: 'correction-1' },
  { id: 'ledger-2', occurredAt: '2026-08-02T17:10:00+02:00', kind: 'BOOKING', description: 'Zu spät zum Training', amount: { minorUnits: '500', currency: 'EUR' }, balance: { minorUnits: '2140', currency: 'EUR' }, referenceId: 'booking-old-2' },
  { id: 'ledger-3', occurredAt: '2026-08-01T09:00:00+02:00', kind: 'PAYMENT', description: 'Zahlungseingang', amount: { minorUnits: '-2000', currency: 'EUR' }, balance: { minorUnits: '1640', currency: 'EUR' }, referenceId: 'payment-1' },
];

/** Consolidated demo account balances for the finance overview. */
export const demoAccountSummaries: AccountSummary[] = [
  { membershipId: 'member-lukas', displayName: 'Lukas Waschul', isTemporaryGuest: false, status: 'ACTIVE', currency: 'EUR', balance: { minorUnits: '2340', currency: 'EUR' } },
  { membershipId: 'member-jonas', displayName: 'Jonas Krüger', isTemporaryGuest: false, status: 'ACTIVE', currency: 'EUR', balance: { minorUnits: '500', currency: 'EUR' } },
  { membershipId: 'member-mara', displayName: 'Mara Becker', isTemporaryGuest: false, status: 'ACTIVE', currency: 'EUR', balance: { minorUnits: '-250', currency: 'EUR' } },
  { membershipId: 'member-pia-archived', displayName: 'Pia Lehmann', isTemporaryGuest: false, status: 'ARCHIVED', currency: 'EUR', balance: { minorUnits: '0', currency: 'EUR' } },
];

/** Demo payments managed by finance users. */
export const demoPayments: Payment[] = [
  { id: 'payment-1', membershipId: 'member-lukas', memberName: 'Lukas Waschul', membershipStatus: 'ACTIVE', actorMembershipId: 'member-mara', actorName: 'Mara Becker', actorStatus: 'ACTIVE', amount: { minorUnits: '2000', currency: 'EUR' }, receivedAt: '2026-08-01T09:00:00+02:00', method: 'BANK_TRANSFER', methodLabel: 'Bank transfer', reference: 'Juli', status: 'POSTED' },
  { id: 'payment-2', membershipId: 'member-mara', memberName: 'Mara Becker', membershipStatus: 'ACTIVE', actorMembershipId: 'member-mara', actorName: 'Mara Becker', actorStatus: 'ACTIVE', amount: { minorUnits: '1500', currency: 'EUR' }, receivedAt: '2026-07-30T18:30:00+02:00', method: 'CASH', methodLabel: 'Cash', status: 'POSTED' },
];

/** Demo settlements generated from closed periods. */
export const demoSettlements: Settlement[] = [
  { id: 'settlement-1', periodId: 'period-july', periodLabel: 'Juli 2026', membershipId: 'member-lukas', membershipStatus: 'ACTIVE', memberName: 'Lukas Waschul', email: 'lukas@example.test', amount: { minorUnits: '3200', currency: 'EUR' }, paidAmount: { minorUnits: '2000', currency: 'EUR' }, openAmount: { minorUnits: '1200', currency: 'EUR' }, dueAt: '2026-08-15', status: 'PARTIAL' },
  { id: 'settlement-2', periodId: 'period-july', periodLabel: 'Juli 2026', membershipId: 'member-mara', membershipStatus: 'ACTIVE', memberName: 'Mara Becker', email: 'mara@example.test', amount: { minorUnits: '1500', currency: 'EUR' }, paidAmount: { minorUnits: '1500', currency: 'EUR' }, openAmount: { minorUnits: '0', currency: 'EUR' }, dueAt: '2026-08-15', status: 'PAID' },
];

/** Demo in-app notifications. */
export const demoNotifications: Notification[] = [
  { id: 'notification-1', title: 'Strafe gebucht', message: 'Mara hat dir „Zu spät zum Training“ über 5,00 € zugewiesen.', createdAt: '2026-08-04T18:32:00+02:00', kind: 'BOOKING', eventType: 'BOOKING_ASSIGNED', context: { actorName: 'Mara', itemName: 'Zu spät zum Training', quantity: 1, amountMinor: '500', currency: 'EUR' } },
  { id: 'notification-2', title: 'Zahlung erfasst', message: 'Deine Zahlung über 20,00 € wurde verbucht.', createdAt: '2026-08-01T09:00:00+02:00', readAt: '2026-08-01T09:10:00+02:00', kind: 'PAYMENT', eventType: 'PAYMENT_RECORDED', context: { actorName: 'Mara', amountMinor: '2000', currency: 'EUR' } },
];

/** Demo append-only audit records. */
export const demoAudit: AuditEntry[] = [
  { id: 'audit-1', occurredAt: '2026-08-04T18:32:00+02:00', actorName: 'Mara Becker', action: 'Buchung erstellt', resourceType: 'booking', subject: 'Jonas Krüger', details: 'Zu spät zum Training · 5,00 €' },
  { id: 'audit-2', occurredAt: '2026-08-01T09:00:00+02:00', actorName: 'Mara Becker', action: 'Zahlung erfasst', resourceType: 'payment', subject: 'Lukas Waschul', details: '20,00 € · Überweisung' },
];
