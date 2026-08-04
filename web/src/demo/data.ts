import type {
  AuditEntry,
  Booking,
  Category,
  Dashboard,
  LedgerEntry,
  Membership,
  Notification,
  Payment,
  Period,
  Session,
  Settlement,
} from '@/api/types';
import beerImageUrl from './assets/beer.webp';
import sodaImageUrl from './assets/soda.webp';
import waterImageUrl from './assets/water.webp';

/** Demo session used only by the development transport. */
export const demoSession: Session = {
  user: {
    id: 'user-lukas',
    displayName: 'Lukas Waschul',
    email: 'lukas@example.test',
  },
  groups: [
    { id: 'group-sv-adler', name: 'SV Adler', currency: 'EUR', membership: { id: 'member-lukas', roles: ['ADMIN', 'MEMBER'] } },
    { id: 'group-freunde', name: 'Kegelclub', currency: 'EUR', membership: { id: 'member-lukas-kegelclub', roles: ['MEMBER'] } },
  ],
  activeGroupId: 'group-sv-adler',
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
    sortOrder: 1,
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
        sortOrder: 1,
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
        sortOrder: 2,
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
        sortOrder: 3,
      },
    ],
  },
  {
    id: 'category-penalties',
    version: 1,
    name: 'Strafen',
    icon: 'penalty',
    active: true,
    sortOrder: 2,
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
        sortOrder: 1,
      },
      {
        id: 'product-kit',
        categoryId: 'category-penalties',
        version: 1,
        name: 'Ausrüstung vergessen',
        pricingMode: 'USER_DEFINED',
        currency: 'EUR',
        active: true,
        sortOrder: 2,
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
    roles: ['ADMIN', 'MEMBER'],
    categoryPermissions: [
      { categoryId: 'category-drinks', assignToOthers: true, voidBookings: true },
      { categoryId: 'category-penalties', assignToOthers: true, voidBookings: true },
    ],
    active: true,
    etag: '"member-lukas-v1"',
  },
  {
    id: 'member-mara',
    userId: 'user-mara',
    displayName: 'Mara Becker',
    email: 'mara@example.test',
    initials: 'MB',
    roles: ['FINANCE_MANAGER', 'MEMBER'],
    categoryPermissions: [
      { categoryId: 'category-drinks', assignToOthers: false, voidBookings: false },
      { categoryId: 'category-penalties', assignToOthers: true, voidBookings: true },
    ],
    active: true,
    etag: '"member-mara-v1"',
  },
  {
    id: 'member-jonas',
    userId: 'user-jonas',
    displayName: 'Jonas Krüger',
    email: 'jonas@example.test',
    initials: 'JK',
    roles: ['CATALOG_MANAGER', 'MEMBER'],
    categoryPermissions: [
      { categoryId: 'category-drinks', assignToOthers: false, voidBookings: false },
      { categoryId: 'category-penalties', assignToOthers: true, voidBookings: false },
    ],
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
    productId: 'product-beer',
    productName: 'Bier',
    categoryId: 'category-drinks',
    categoryName: 'Getränke',
    quantity: 1,
    unitPrice: { minorUnits: '200', currency: 'EUR' },
    total: { minorUnits: '200', currency: 'EUR' },
    bookedAt: '2026-08-04T19:45:00+02:00',
    bookedByName: 'Lukas Waschul',
    status: 'POSTED',
    undoUntil: '2026-08-04T19:45:30+02:00',
    canVoid: true,
  },
  {
    id: 'booking-2',
    memberId: 'member-mara',
    memberName: 'Mara Becker',
    productId: 'product-spezi',
    productName: 'Spezi',
    categoryId: 'category-drinks',
    categoryName: 'Getränke',
    quantity: 1,
    unitPrice: { minorUnits: '150', currency: 'EUR' },
    total: { minorUnits: '150', currency: 'EUR' },
    bookedAt: '2026-08-04T19:10:00+02:00',
    bookedByName: 'Mara Becker',
    status: 'POSTED',
    canVoid: true,
  },
  {
    id: 'booking-3',
    memberId: 'member-jonas',
    memberName: 'Jonas Krüger',
    productId: 'product-late',
    productName: 'Zu spät zum Training',
    categoryId: 'category-penalties',
    categoryName: 'Strafen',
    quantity: 1,
    unitPrice: { minorUnits: '500', currency: 'EUR' },
    total: { minorUnits: '500', currency: 'EUR' },
    bookedAt: '2026-08-04T18:32:00+02:00',
    bookedByName: 'Mara Becker',
    reason: '15 Minuten zu spät',
    status: 'POSTED',
    canVoid: true,
  },
];

/** Demo dashboard values matching the approved desktop concept. */
export const demoDashboard: Dashboard = {
  openBalance: { minorUnits: '2340', currency: 'EUR' },
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

/** Demo account ledger. */
export const demoLedger: LedgerEntry[] = [
  { id: 'ledger-1', occurredAt: '2026-08-04T19:45:00+02:00', kind: 'BOOKING', description: 'Bier', amount: { minorUnits: '200', currency: 'EUR' }, balance: { minorUnits: '2340', currency: 'EUR' }, referenceId: 'booking-1' },
  { id: 'ledger-2', occurredAt: '2026-08-02T17:10:00+02:00', kind: 'BOOKING', description: 'Zu spät zum Training', amount: { minorUnits: '500', currency: 'EUR' }, balance: { minorUnits: '2140', currency: 'EUR' }, referenceId: 'booking-old-2' },
  { id: 'ledger-3', occurredAt: '2026-08-01T09:00:00+02:00', kind: 'PAYMENT', description: 'Zahlungseingang', amount: { minorUnits: '-2000', currency: 'EUR' }, balance: { minorUnits: '1640', currency: 'EUR' }, referenceId: 'payment-1' },
];

/** Demo payments managed by finance users. */
export const demoPayments: Payment[] = [
  { id: 'payment-1', membershipId: 'member-lukas', memberName: 'Lukas Waschul', amount: { minorUnits: '2000', currency: 'EUR' }, receivedAt: '2026-08-01', method: 'BANK_TRANSFER', reference: 'Juli', status: 'POSTED' },
  { id: 'payment-2', membershipId: 'member-mara', memberName: 'Mara Becker', amount: { minorUnits: '1500', currency: 'EUR' }, receivedAt: '2026-07-30', method: 'CASH', status: 'POSTED' },
];

/** Demo settlements generated from closed periods. */
export const demoSettlements: Settlement[] = [
  { id: 'settlement-1', periodId: 'period-july', periodLabel: 'Juli 2026', membershipId: 'member-lukas', memberName: 'Lukas Waschul', amount: { minorUnits: '3200', currency: 'EUR' }, paidAmount: { minorUnits: '2000', currency: 'EUR' }, openAmount: { minorUnits: '1200', currency: 'EUR' }, dueAt: '2026-08-15', status: 'PARTIAL' },
  { id: 'settlement-2', periodId: 'period-july', periodLabel: 'Juli 2026', membershipId: 'member-mara', memberName: 'Mara Becker', amount: { minorUnits: '1500', currency: 'EUR' }, paidAmount: { minorUnits: '1500', currency: 'EUR' }, openAmount: { minorUnits: '0', currency: 'EUR' }, dueAt: '2026-08-15', status: 'PAID' },
];

/** Demo in-app notifications. */
export const demoNotifications: Notification[] = [
  { id: 'notification-1', title: 'Strafe gebucht', message: 'Mara hat dir „Zu spät zum Training“ über 5,00 € zugewiesen.', createdAt: '2026-08-04T18:32:00+02:00', kind: 'BOOKING' },
  { id: 'notification-2', title: 'Zahlung erfasst', message: 'Deine Zahlung über 20,00 € wurde verbucht.', createdAt: '2026-08-01T09:00:00+02:00', readAt: '2026-08-01T09:10:00+02:00', kind: 'PAYMENT' },
];

/** Demo append-only audit records. */
export const demoAudit: AuditEntry[] = [
  { id: 'audit-1', occurredAt: '2026-08-04T18:32:00+02:00', actorName: 'Mara Becker', action: 'Buchung erstellt', subject: 'Jonas Krüger', details: 'Zu spät zum Training · 5,00 €' },
  { id: 'audit-2', occurredAt: '2026-08-01T09:00:00+02:00', actorName: 'Mara Becker', action: 'Zahlung erfasst', subject: 'Lukas Waschul', details: '20,00 € · Überweisung' },
];
