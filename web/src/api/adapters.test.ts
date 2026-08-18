import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { adaptAccountSummaries, adaptBooking, adaptCategories, adaptDashboard, adaptGroupSettings, adaptInstanceCapabilities, adaptLedger, adaptMembership, adaptNotification, adaptPermissionDefinition, adaptPermissionGrants, adaptProduct, adaptRole, adaptSession, adaptSettlement, adaptSystemAudit, adaptSystemGroupDeletionImpact, adaptSystemGroups, adaptSystemSettings, adaptTransactionSettings } from './adapters';

describe('API adapters', () => {
  it('keeps group-less system-administrator sessions valid', () => {
    expect(adaptSession({
      user: { id: 'system-user', displayName: 'System Admin', email: 'admin@example.test' },
      groups: [],
      activeGroupId: null,
      defaultGroupId: null,
      systemRoles: ['SYSTEM_ADMINISTRATOR', 'UNSUPPORTED'],
    })).toMatchObject({ activeGroupId: null, groups: [], systemRoles: ['SYSTEM_ADMINISTRATOR'] });
  });

  it('adapts public capabilities and exact system settings without exposing SMTP secrets', () => {
    expect(adaptInstanceCapabilities({ instanceName: 'Club Cloud', maintenanceMode: true, publicJoinEnabled: false, mediaUploadMaxBytes: 786432 })).toEqual({
      instanceName: 'Club Cloud', maintenanceMode: true, maintenanceMessage: '', publicJoinEnabled: false, mediaUploadMaxBytes: 786432,
    });
    const settings = adaptSystemSettings({
      revision: 9,
      instanceName: { value: 'Club Cloud', source: 'DATABASE', overrideVersion: 3, updatedAt: '2026-08-15T10:00:00Z' },
      defaultCurrency: { value: 'CHF', source: 'ENVIRONMENT' },
      mediaUploadMaxBytes: { value: 786432, source: 'DATABASE', overrideVersion: 1 },
      mediaUploadHardLimitBytes: 1048576,
      publicJoinEnabled: { value: false, source: 'DATABASE' },
      maintenanceMode: { value: true, source: 'DATABASE' },
      maintenanceMessage: { value: 'Upgrade', source: 'DATABASE' },
      smtp: {
        enabled: { value: false, source: 'DATABASE' }, host: { value: 'smtp.example.test', source: 'DATABASE' },
        port: { value: 587, source: 'DATABASE' }, tlsMode: { value: 'starttls', source: 'DATABASE' },
        username: { value: 'mailer', source: 'DATABASE' }, password: { configured: true, source: 'DATABASE' },
        fromAddress: { value: 'mail@example.test', source: 'DATABASE' }, fromName: { value: 'Club Cloud', source: 'DATABASE' },
        revision: 4, testedRevision: 4, testedAt: '2026-08-15T11:00:00Z', requiresTest: true, configurationValid: true, active: false,
      },
      updatedAt: '2026-08-15T11:00:00Z',
    });
    expect(settings).toMatchObject({ revision: 9, mediaUploadHardLimitBytes: 1048576, smtp: { passwordConfigured: true, passwordSource: 'DATABASE', tlsMode: { value: 'starttls' }, testStatus: 'VERIFIED', revision: 4 } });
    expect(settings.smtp).not.toHaveProperty('password');

	const unconfiguredSMTP = adaptSystemSettings({ smtp: { port: { value: 0, source: 'CODE' } } }).smtp;
	expect(unconfiguredSMTP.port).toMatchObject({ value: 587, source: 'CODE' });
  });

  it('adapts item envelopes, flat managed-group counts, deletion impact, and system audit', () => {
    expect(adaptSystemGroups({ items: [{ id: 'group-a', name: 'Group A', currency: 'EUR', status: 'ARCHIVED', version: 4, logoUrl: '/api/v1/system/groups/group-a/logo', memberCount: 3, pendingInvitationCount: 2, bookingCount: 8, financialRecordCount: 5, auditEventCount: 7, mediaCount: 1 }] })[0]).toMatchObject({
      id: 'group-a', status: 'ARCHIVED', logoUrl: '/api/v1/system/groups/group-a/logo', impact: { members: 3, invitations: 2, bookings: 8, financialRecords: 5, auditEntries: 7, mediaFiles: 1 },
    });
    expect(adaptSystemGroupDeletionImpact({ groupId: 'group-a', groupName: 'Group A', currency: 'EUR', version: 5, memberCount: 3, openBalanceMinor: '1234', invitationCount: 2, bookingCount: 8, financialRecordCount: 5, auditEventCount: 7, mediaCount: 1 })).toMatchObject({ groupId: 'group-a', version: 5, financialRecords: 5, openBalance: { minorUnits: '1234', currency: 'EUR' } });
    expect(adaptSystemAudit({ items: [{ id: 'audit-a', actorUserId: 'user-a', actorDisplayName: 'Ada Admin', action: 'group.purged', resourceType: 'group', resourceId: 'group-a', metadata: { groupName: 'Group A' }, occurredAt: '2026-08-15T12:00:00Z' }] })[0]).toMatchObject({ actorDisplayName: 'Ada Admin', targetType: 'group', targetId: 'group-a', createdAt: '2026-08-15T12:00:00Z' });
  });

  it('defaults optional settlement flags to disabled for older API responses', () => {
    expect(adaptGroupSettings({}).settlementsEnabled).toBe(false);
    expect(adaptTransactionSettings({}).settlementsEnabled).toBe(false);
    expect(adaptGroupSettings({ settlementsEnabled: true }).settlementsEnabled).toBe(true);
    expect(adaptTransactionSettings({ settlementsEnabled: true }).settlementsEnabled).toBe(true);
  });

  it('normalizes reason modes and maps legacy requirement flags', () => {
    expect(adaptGroupSettings({})).toMatchObject({
      ownBookingReasonMode: 'OFF',
      foreignBookingReasonMode: 'REQUIRED',
      ownPaymentReasonMode: 'REQUIRED',
      otherPaymentReasonMode: 'OPTIONAL',
    });
    expect(adaptTransactionSettings({
      ownBookingReasonMode: 'OPTIONAL',
      foreignBookingReasonRequired: false,
      ownPaymentReasonMode: 'OFF',
      otherPaymentReasonRequired: true,
    })).toMatchObject({
      ownBookingReasonMode: 'OPTIONAL',
      foreignBookingReasonMode: 'OPTIONAL',
      ownPaymentReasonMode: 'OFF',
      otherPaymentReasonMode: 'REQUIRED',
      foreignBookingReasonRequired: false,
      ownPaymentReasonRequired: false,
      otherPaymentReasonRequired: true,
    });
  });

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
    expect(adaptBooking({
      id: 'booking-wire',
      targetMembershipId: 'member-target',
      targetAvatarUrl: '/api/v1/users/target/avatar/target.png',
      actorMembershipId: 'member-actor',
      actorAvatarUrl: '/api/v1/users/actor/avatar/actor.png',
      productId: 'product-a',
      categoryId: 'category-a',
      quantity: 1,
      unitPriceMinor: 100,
      totalMinor: 100,
      currency: 'EUR',
      createdAt: '2026-08-05T00:00:00Z',
    })).toMatchObject({
      memberAvatarUrl: '/api/v1/users/target/avatar/target.png',
      bookedByAvatarUrl: '/api/v1/users/actor/avatar/actor.png',
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

  it('adapts the optional signed group outstanding amount without losing precision', () => {
    const dashboard = adaptDashboard({
      account: { balanceMinor: '0', currency: 'EUR', categoryStatistics: [], groupCategoryStatistics: [] },
      openPeriod: { id: 'period', label: 'Current', status: 'OPEN', startsAt: '2026-08-01T00:00:00Z' },
      recentBookings: [],
      groupOutstandingMinor: '-9007199254740993123',
    });
    const unauthorizedDashboard = adaptDashboard({
      account: { balanceMinor: '0', currency: 'EUR', categoryStatistics: [], groupCategoryStatistics: [] },
      openPeriod: { id: 'period', label: 'Current', status: 'OPEN', startsAt: '2026-08-01T00:00:00Z' },
      recentBookings: [],
    });

    expect(dashboard.groupOutstanding).toEqual({ minorUnits: '-9007199254740993123', currency: 'EUR' });
    expect(unauthorizedDashboard.groupOutstanding).toBeUndefined();
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
      isTemporaryGuest: true,
      status: 'ARCHIVED',
      currency: 'EUR',
      balanceMinor: '9007199254740993123',
    }]);

    expect(summary).toEqual({
      membershipId: 'member-large',
      displayName: 'Large Balance',
      avatarUrl: '/api/v1/users/user-large/avatar/hash.png',
      isTemporaryGuest: true,
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
