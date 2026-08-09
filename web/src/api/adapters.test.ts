import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { adaptAccountSummaries, adaptBooking, adaptCategories, adaptDashboard, adaptLedger, adaptMembership, adaptNotification, adaptPermissionDefinition, adaptPermissionGrants, adaptProduct, adaptRole, adaptSession, adaptSettlement } from './adapters';

describe('API adapters', () => {
  it('accepts stable group grants and rejects unknown keys or disabled scopes', () => {
    expect(adaptPermissionGrants([
      { permission: 'FINANCE_MANAGEMENT', scope: { type: 'GROUP' } },
      { permission: 'FINANCE_MANAGEMENT', scope: { type: 'GROUP' } },
      { permission: 'CATALOG_MANAGEMENT', scope: { type: 'CATEGORY' }, categoryId: 'category-a' },
      { permission: 'CREATE_OWN_BOOKING', scope: { type: 'GROUP' }, categoryId: 'category-a' },
      { permission: 'CREATE_OWN_BOOKING', scope: { type: 'GROUP', categoryId: 'category-a' } },
      { permission: 'CREATE_OWN_BOOKING', scope: { type: 'GROUP', productId: 'product-a' } },
      { permission: 'UNSUPPORTED', scope: { type: 'GROUP' } },
      null,
    ])).toEqual([{ permission: 'FINANCE_MANAGEMENT', scope: { type: 'GROUP' } }]);
  });

  it('normalizes managed guest identity without inventing an email address', () => {
    const guest = adaptMembership({
      id: 'member-guest',
      userId: 'user-credentialless',
      displayName: 'Guest One',
      isTemporaryGuest: true,
      status: 'ACTIVE',
      roles: [],
      categoryGrants: {},
    });

    expect(guest).toMatchObject({
      id: 'member-guest',
      userId: 'user-credentialless',
      email: null,
      isTemporaryGuest: true,
      active: true,
    });
  });

  it('adapts permission registry aliases and protected role metadata', () => {
    expect(adaptPermissionDefinition({
      key: 'VOID_ANY_BOOKING',
      allowedScopes: ['GROUP', 'CATEGORY', 'UNSUPPORTED'],
      implies: ['VOID_OWN_BOOKING', 'VIEW_ALL_BOOKING_ACTIVITY', 'UNSUPPORTED'],
    })).toEqual({
      key: 'VOID_ANY_BOOKING',
      allowedScopes: ['GROUP', 'CATEGORY'],
      impliedPermissions: ['VOID_OWN_BOOKING', 'VIEW_ALL_BOOKING_ACTIVITY'],
    });
    expect(adaptRole({
      id: 'role-admin',
      groupId: 'group-a',
      presetKey: 'GROUP_ADMINISTRATOR',
      name: 'Group administrator',
      nameLocked: true,
      deletable: false,
      version: 4,
      memberCount: 1,
      pendingInvitationCount: 0,
      createdAt: '2026-08-07T12:00:00Z',
      updatedAt: '2026-08-07T13:00:00Z',
      grants: [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }],
    })).toMatchObject({
      id: 'role-admin',
      groupId: 'group-a',
      nameLocked: true,
      deletable: false,
      version: 4,
      grants: [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }],
    });
  });

  it('propagates protected profile-image URLs through sessions, memberships, and bookings', () => {
    const avatarUrl = '/api/v1/users/user-a/avatar/hash.png';
    const session = adaptSession({
      user: { id: 'user-a', displayName: 'Alex', email: 'alex@example.test', avatarUrl },
      groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: 'member-a', roles: [], groupPermissions: ['SELF_RECORD_PAYMENT'] } }],
      activeGroupId: 'group-a',
    });
    const member = adaptMembership({ id: 'member-a', userId: 'user-a', displayName: 'Alex', email: 'alex@example.test', avatarUrl, status: 'ACTIVE', roles: [], categoryGrants: {} });
    const booking = adaptBooking({
      id: 'booking-a',
      targetMembershipId: 'member-a',
      actorMembershipId: 'member-a',
      productId: 'product-a',
      productName: 'Water',
      categoryId: 'category-a',
      categoryName: 'Drinks',
      unitPriceMinor: 100,
      totalMinor: 100,
      currency: 'EUR',
      createdAt: '2026-08-05T00:00:00Z',
    }, [member]);

    expect(session.user.avatarUrl).toBe(avatarUrl);
    expect(session.groups[0]?.membership?.groupPermissions).toEqual(['SELF_RECORD_PAYMENT']);
    expect(member.groupPermissions).toEqual([]);
    expect(member.avatarUrl).toBe(avatarUrl);
    expect(booking).toMatchObject({ memberAvatarUrl: avatarUrl, bookedByAvatarUrl: avatarUrl });
    expect(adaptBooking({ ...booking, memberAvatarUrl: undefined, bookedByAvatarUrl: undefined }, [member])).toMatchObject({
      memberAvatarUrl: avatarUrl,
      bookedByAvatarUrl: avatarUrl,
    });
  });

  it('uses persisted category icons and safely falls back for unsupported values', () => {
    expect(adaptCategories([{ id: 'food', name: 'Meals', icon: 'food' }])[0]?.icon).toBe('food');
    expect(adaptCategories([{ id: 'unsafe', name: 'Unsafe', icon: '<script>' }])[0]?.icon).toBe('other');
    expect(adaptDashboard({
      account: {
        balanceMinor: '0', currency: 'EUR', categoryStatistics: [{ categoryId: 'sport', categoryName: 'Training', icon: 'sport', netMinor: '0' }], groupCategoryStatistics: [],
      },
      openPeriod: { id: 'period', label: 'Current', status: 'OPEN', startsAt: '2026-08-01T00:00:00Z' },
      recentBookings: [],
    }).categoryTotals[0]?.icon).toBe('sport');
  });

  it('adapts fixed and user-defined product pricing without inventing a custom price', () => {
    expect(adaptProduct({ id: 'fixed', name: 'Water', categoryId: 'drinks', pricingMode: 'FIXED', priceMinor: '100', currency: 'EUR' })).toMatchObject({
      pricingMode: 'FIXED', currency: 'EUR', price: { minorUnits: '100', currency: 'EUR' },
    });
    expect(adaptProduct({ id: 'custom', name: 'Donation', categoryId: 'other', pricingMode: 'USER_DEFINED', currency: 'EUR' })).toMatchObject({
      pricingMode: 'USER_DEFINED', currency: 'EUR', price: undefined,
    });
  });

  it('reconstructs ledger balances without losing integer precision', () => {
    const entries = adaptLedger({
      balanceMinor: '9007199254740993123',
      currency: 'EUR',
      recentEntries: [{
        id: 'entry-1',
        createdAt: '2026-08-04T12:00:00Z',
        amountMinor: '123',
        description: 'Precision check',
        bookingId: 'booking-1',
      }],
    });

    expect(entries[0]?.balance.minorUnits).toBe('9007199254740993123');
    expect(entries[0]?.amount.minorUnits).toBe('123');
  });

  it('adapts consolidated account summaries without losing integer precision', () => {
    const [summary] = adaptAccountSummaries([{
      membershipId: 'member-large',
      displayName: 'Large Balance',
      avatarUrl: '/api/v1/users/user-large/avatar/hash.png',
      status: 'ARCHIVED',
      currency: 'EUR',
      balanceMinor: '9007199254740993123',
    }]);

    expect(summary).toEqual({
      membershipId: 'member-large',
      displayName: 'Large Balance',
      avatarUrl: '/api/v1/users/user-large/avatar/hash.png',
      status: 'ARCHIVED',
      currency: 'EUR',
      balance: { minorUnits: '9007199254740993123', currency: 'EUR' },
    });
  });

  it('localizes a received payment while preserving its reference', () => {
    const [entry] = adaptLedger({
      balanceMinor: '-1250',
      currency: 'EUR',
      recentEntries: [{
        id: 'entry-payment',
        paymentId: 'payment-1',
        createdAt: '2026-08-04T12:00:00Z',
        amountMinor: '-1250',
        description: 'Payment received: Advance installment',
      }],
    });

    expect(entry?.description).toBe(i18n.t('ledger.paymentReceivedWithReference', { reference: 'Advance installment' }));
    expect(entry?.kind).toBe('PAYMENT');
  });

  it('localizes payment and booking reversals without backend English labels', () => {
    const entries = adaptLedger({
      balanceMinor: '0',
      currency: 'EUR',
      recentEntries: [
        {
          id: 'entry-payment-reversal',
          paymentId: 'payment-1',
          reversalOf: 'entry-payment',
          createdAt: '2026-08-04T13:00:00Z',
          amountMinor: '1250',
          description: 'Reversal: Payment received: Advance installment',
        },
        {
          id: 'entry-booking-reversal',
          bookingId: 'booking-1',
          reversalOf: 'entry-booking',
          createdAt: '2026-08-04T14:00:00Z',
          amountMinor: '-200',
          description: 'Reversal: 2 x Water (Drinks)',
        },
      ],
    });

    expect(entries[0]?.description).toBe(i18n.t('ledger.paymentReversedWithReference', { reference: 'Advance installment' }));
    expect(entries[1]?.description).toBe(i18n.t('ledger.bookingReversed', { description: '2 × Water (Drinks)' }));
    expect(entries.every((entry) => !entry.description.includes('Payment received') && !entry.description.includes('Reversal:'))).toBe(true);
  });

  it('localizes structured backend notifications by event type', () => {
    const notification = adaptNotification({
      id: 'notification-1',
      type: 'PAYMENT_RECORDED',
      title: 'Payment recorded',
      body: 'A payment was recorded.',
      createdAt: '2026-08-04T12:00:00Z',
    });

    expect(notification.title).toBe(i18n.t('notifications.fallback.paymentTitle'));
    expect(notification.message).toBe(i18n.t('notifications.fallback.paymentMessage'));
  });

  it('includes cross-period corrections in settlement obligations and payments', () => {
    const settlement = adaptSettlement({
      id: 'statement-1',
      periodId: 'period-1',
      membershipId: 'member-1',
      displayName: 'Mara Becker',
      chargesMinor: '150',
      paymentsAllocatedMinor: '25',
      adjustmentsAppliedMinor: '75',
      adjustmentsProvidedMinor: '50',
      amountDueMinor: '100',
      currency: 'EUR',
      status: 'PARTIAL',
    }, [{ id: 'period-1', label: 'July 2026', status: 'CLOSED', startsAt: '2026-07-01', dueAt: '2026-08-15' }]);

    expect(settlement.amount.minorUnits).toBe('200');
    expect(settlement.paidAmount.minorUnits).toBe('100');
    expect(settlement.openAmount?.minorUnits).toBe('100');
    expect(settlement.email).toBeNull();
  });
});
