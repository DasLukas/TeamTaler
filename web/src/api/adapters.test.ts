import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { adaptAccountSummaries, adaptActivity, adaptAppearancePreference, adaptBooking, adaptCategories, adaptDashboard, adaptGroupSettings, adaptInstanceCapabilities, adaptLedger, adaptMembership, adaptNotification, adaptNotificationDestination, adaptNotificationPreferences, adaptPayment, adaptPaymentTarget, adaptPermissionDefinition, adaptPermissionGrants, adaptProduct, adaptPushSubscriptions, adaptRole, adaptSession, adaptSettlement, adaptStatisticsDashboard, adaptSystemAudit, adaptSystemGroupDeletionImpact, adaptSystemGroups, adaptSystemSettings, adaptThemePreference, adaptTransactionSettings } from './adapters';

describe('API adapters', () => {
  it('adapts the exact privacy-aware member section of the unified statistics contract', () => {
    const statistics = adaptStatisticsDashboard({
      meta: { generatedAt: '2026-08-28T10:00:00Z', timezone: 'Europe/Berlin', preset: 'ALL_TIME', fromInclusive: '2024-01-01T00:00:00Z', toExclusive: '2026-08-29T00:00:00Z', bucket: 'YEAR', privacyThresholdApplied: true, currentPeriodAvailable: false },
      members: {
        memberSnapshot: { regularMembers: 2, temporaryGuests: 1, asOf: '2026-08-28T10:00:00Z' },
        summary: { activeParticipants: 0, bookingCount: 0, validBookedUnits: 0, cancellationRate: null },
        activity: [{ periodStart: '2026-01-01T00:00:00Z', postedUnits: 0, reversedUnits: 0 }],
        topCategories: { suppressed: true, items: [] },
        topProducts: { suppressed: false, items: [{
          productId: '', productName: 'Other', categoryId: '', categoryName: 'Other', validBookedUnits: 4, isOther: true,
          series: [
            { periodStart: '2026-01-01T00:00:00Z', validBookedUnits: 3, privacySuppressed: false, isPartial: false },
            { periodStart: '2026-02-01T00:00:00Z', validBookedUnits: null, privacySuppressed: true, isPartial: false },
            { periodStart: '2026-03-01T00:00:00Z', validBookedUnits: -1, privacySuppressed: false, isPartial: true },
            { periodStart: '2026-04-01T00:00:00Z', validBookedUnits: 0 },
            { periodStart: '2026-05-01T00:00:00Z', validBookedUnits: 1.5 },
          ],
        }] },
      },
      finance: { currency: 'EUR', receivableSnapshot: {}, flows: {}, series: [], categories: [], overdue: null },
    });

    expect(statistics.meta).toMatchObject({ preset: 'ALL_TIME', bucket: 'YEAR', privacyThresholdApplied: true, currentPeriodAvailable: false });
    expect(statistics.members.summary.cancellationRate).toBeNull();
    expect(statistics.members.topCategories).toEqual({ suppressed: true, items: [] });
    expect(statistics.members.topProducts.items[0]).toMatchObject({ productId: '', categoryId: '', isOther: true });
    expect(statistics.members.topProducts.items[0].series).toEqual([
      { periodStart: '2026-01-01T00:00:00Z', validBookedUnits: 3, privacySuppressed: false, isPartial: false },
      { periodStart: '2026-02-01T00:00:00Z', validBookedUnits: null, privacySuppressed: true, isPartial: false },
      { periodStart: '2026-03-01T00:00:00Z', validBookedUnits: null, privacySuppressed: false, isPartial: true },
      { periodStart: '2026-04-01T00:00:00Z', validBookedUnits: 0, privacySuppressed: false, isPartial: false },
      { periodStart: '2026-05-01T00:00:00Z', validBookedUnits: null, privacySuppressed: false, isPartial: false },
    ]);
  });

  it('retains exact int64 strings in the unified finance statistics contract', () => {
    const statistics = adaptStatisticsDashboard({
      meta: { generatedAt: '2026-08-28T10:00:00Z', timezone: 'Europe/Berlin', preset: 'LAST_30_DAYS', fromInclusive: '2026-07-30T00:00:00Z', toExclusive: '2026-08-29T00:00:00Z', bucket: 'DAY', privacyThresholdApplied: false, currentPeriodAvailable: true },
      members: { memberSnapshot: {}, summary: {}, activity: [], topCategories: {}, topProducts: {} },
      finance: {
        currency: 'EUR',
        receivableSnapshot: { asOf: '2026-08-29T00:00:00Z', grossReceivableMinor: '9223372036854775807', memberCreditMinor: '1', netReceivableMinor: '9223372036854775806', openAccountCount: 1, balancedAccountCount: 0, creditAccountCount: 1 },
        flows: { openingNetReceivableMinor: '10', netBookingChargesMinor: '5', netPaymentsMinor: '2', netAdjustmentsMinor: '-1', closingNetReceivableMinor: '12' },
        series: [{ periodStart: '2026-08-01T00:00:00Z', netBookingChargesMinor: '5', netPaymentsMinor: '2', netAdjustmentsMinor: '-1', closingNetReceivableMinor: '12' }],
        categories: [{ categoryId: '', categoryName: 'Other', icon: 'other', netBookingChargesMinor: '-1', isOther: true }],
        overdue: { amountMinor: '100', accountCount: 1, periodCount: 2, asOf: '2026-08-28T10:00:00Z' },
      },
    });

    expect(statistics.finance.receivableSnapshot.grossReceivable).toEqual({ minorUnits: '9223372036854775807', currency: 'EUR' });
    expect(statistics.finance.flows.netPayments.minorUnits).toBe('2');
    expect(statistics.finance.categories[0]).toMatchObject({ isOther: true, netBookingCharges: { minorUnits: '-1', currency: 'EUR' } });
    expect(statistics.finance.overdue?.amount.minorUnits).toBe('100');
  });
  it('adapts signed unified activities and source action metadata', () => {
    expect(adaptActivity({
      id: 'payment:pay-a', sourceId: 'pay-a', kind: 'PAYMENT',
      targetMembershipId: 'member-a', targetDisplayName: 'Alex', targetMembershipStatus: 'ACTIVE',
      actorMembershipId: 'member-manager', actorDisplayName: 'Manager', actorMembershipStatus: 'ARCHIVED',
      detailName: 'Cash', detailNote: 'August', paymentMethod: 'CASH', amountMinor: '-1250', currency: 'EUR',
      occurredAt: '2026-08-20T10:00:00Z', status: 'POSTED', canReverse: true,
      reversalReasonRequired: true, attachment: { fileName: 'receipt.pdf', mediaType: 'application/pdf', sizeBytes: 42, url: '/receipt' },
    })).toMatchObject({
      id: 'payment:pay-a', sourceId: 'pay-a', kind: 'PAYMENT', amount: { minorUnits: '-1250', currency: 'EUR' },
      actorMembershipStatus: 'ARCHIVED', detailName: 'Bar', paymentMethod: 'CASH', canReverse: true, reversalReasonRequired: true,
      attachment: { fileName: 'receipt.pdf' },
    });
    expect(adaptActivity({
      id: 'payment:legacy', sourceId: 'legacy', kind: 'PAYMENT',
      targetMembershipId: 'member-a', targetDisplayName: 'Alex', targetMembershipStatus: 'ACTIVE',
      detailName: '', paymentMethod: 'CASH', amountMinor: '-500', currency: 'EUR',
      occurredAt: '2026-08-20T10:00:00Z', status: 'POSTED', canReverse: false, reversalReasonRequired: false,
    })).toMatchObject({ detailName: 'Bar', paymentMethod: 'CASH' });
  });

  it('enforces reversal linkage metadata and strips inapplicable actions', () => {
    expect(adaptActivity({
      id: 'reversal:payment:pay-a', sourceId: 'pay-a', kind: 'REVERSAL', reversalSourceKind: 'PAYMENT',
      relatedActivityId: 'payment:pay-a', targetMembershipId: 'member-a', targetDisplayName: 'Alex', targetMembershipStatus: 'ACTIVE',
      actorMembershipId: 'member-manager', actorDisplayName: 'Manager', actorMembershipStatus: 'ACTIVE',
      detailName: 'Cash', detailNote: 'Duplicate payment', paymentMethod: 'CASH', amountMinor: '1250', currency: 'EUR',
      occurredAt: '2026-08-20T11:00:00Z', status: 'REVERSED', canReverse: true, reversalReasonRequired: true,
      attachment: { fileName: 'receipt.pdf', mediaType: 'application/pdf', sizeBytes: 42, url: '/receipt' },
    })).toMatchObject({
      id: 'reversal:payment:pay-a', kind: 'REVERSAL', relatedActivityId: 'payment:pay-a', reversalSourceKind: 'PAYMENT',
      detailName: 'Bar', amount: { minorUnits: '1250', currency: 'EUR' }, status: 'POSTED', canReverse: false, reversalReasonRequired: false,
    });
    expect(adaptActivity({
      id: 'reversal:payment:pay-a', sourceId: 'pay-a', kind: 'REVERSAL', reversalSourceKind: 'PAYMENT',
      relatedActivityId: 'payment:pay-a', targetMembershipId: 'member-a', targetDisplayName: 'Alex', targetMembershipStatus: 'ACTIVE',
      detailName: 'Cash', amountMinor: '1250', currency: 'EUR', occurredAt: '2026-08-20T11:00:00Z',
    })).not.toHaveProperty('attachment');
    expect(() => adaptActivity({ kind: 'REVERSAL' })).toThrow('Reversal activities require a BOOKING or PAYMENT reversalSourceKind.');
  });

  it('validates appearance enums while preserving safe inheritance defaults', () => {
    expect(adaptAppearancePreference({ colorMode: 'DARK' })).toEqual({ colorMode: 'DARK' });
    expect(adaptAppearancePreference({ colorMode: 'SEPIA' })).toEqual({ colorMode: 'SYSTEM' });
    expect(adaptThemePreference({ themeOverride: 'TIEF_IM_WESTEN' })).toEqual({ themeOverride: 'TIEF_IM_WESTEN' });
    expect(adaptThemePreference({ themeOverride: 'CUSTOM' })).toEqual({ themeOverride: null });

    expect(adaptSession({
      user: { id: 'user-a', displayName: 'Alex', email: 'alex@example.test' },
      colorMode: 'LIGHT',
      groups: [{ id: 'group-a', name: 'Group A', defaultTheme: 'NRW', membership: { id: 'member-a', themeOverride: 'FIRE' } }],
      activeGroupId: 'group-a',
    })).toMatchObject({
      colorMode: 'LIGHT',
      groups: [{ defaultTheme: 'NRW', membership: { themeOverride: 'FIRE' } }],
    });
  });

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
    expect(adaptInstanceCapabilities({ instanceName: 'Club Cloud', maintenanceMode: true, publicJoinEnabled: false, mediaUploadMaxBytes: 786432, attachmentUploadMaxBytes: 15728640, emailNotificationsAvailable: true, webPushAvailable: true, webPushPublicKey: 'public-key', webPushKeyId: 'key-a' })).toEqual({
      instanceName: 'Club Cloud', maintenanceMode: true, maintenanceMessage: '', publicJoinEnabled: false, mediaUploadMaxBytes: 786432, attachmentUploadMaxBytes: 15728640,
      emailNotificationsAvailable: true, webPushAvailable: true, webPushPublicKey: 'public-key', webPushKeyId: 'key-a',
    });
    const settings = adaptSystemSettings({
      revision: 9,
      instanceName: { value: 'Club Cloud', source: 'DATABASE', overrideVersion: 3, updatedAt: '2026-08-15T10:00:00Z' },
      defaultCurrency: { value: 'CHF', source: 'ENVIRONMENT' },
      timeZone: { value: 'Europe/Berlin', source: 'DATABASE' },
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
      webPush: {
        enabled: { value: true, source: 'DATABASE' },
        subject: { value: 'mailto:admin@example.test', source: 'DATABASE' },
        vapidPrivateKey: { configured: true, source: 'DATABASE', updatedAt: '2026-08-15T10:30:00Z' },
        publicKey: 'public-key', keyId: 'key-a', revision: 2, storageKeyConfigured: true, configurationValid: true, active: true,
      },
      updatedAt: '2026-08-15T11:00:00Z',
    });
    expect(settings).toMatchObject({ revision: 9, timeZone: { value: 'Europe/Berlin', source: 'DATABASE' }, mediaUploadHardLimitBytes: 1048576, smtp: { passwordConfigured: true, passwordSource: 'DATABASE', tlsMode: { value: 'starttls' }, testStatus: 'VERIFIED', revision: 4 } });
    expect(settings.webPush).toMatchObject({ enabled: { value: true }, privateKeyConfigured: true, privateKeySource: 'DATABASE', publicKey: 'public-key', keyId: 'key-a', active: true });
    expect(settings.smtp).not.toHaveProperty('password');

	const unconfiguredSMTP = adaptSystemSettings({ smtp: { port: { value: 0, source: 'CODE' } } }).smtp;
	expect(unconfiguredSMTP.port).toMatchObject({ value: 587, source: 'CODE' });
  });

  it('normalizes notification preferences and redacted device contracts', () => {
    const event = {
      type: 'SETTLEMENT_DUE_SOON', category: 'SETTLEMENTS', label: 'Settlement due soon', description: 'A settlement is due soon.',
      supportedChannels: ['EMAIL', 'PUSH'],
    };
    expect(adaptNotificationPreferences({
      version: 2, availableChannels: ['PUSH'], events: [{ ...event, email: true, push: false, emailAvailable: false, pushAvailable: true }],
    })).toMatchObject({
      version: 2, channels: { email: false, push: true },
      events: [{ eventType: 'SETTLEMENT_DUE_SOON', email: true, push: false, emailAvailable: false, pushAvailable: true }],
    });
    expect(adaptPushSubscriptions({ items: [{ id: 'device-a', deviceLabel: 'Safari on iPhone', keyId: 'key-a', createdAt: '2026-08-20T10:00:00Z', lastUsedAt: '2026-08-20T11:00:00Z', current: true, endpoint: 'must-not-leak' }] })).toEqual([{
      id: 'device-a', label: 'Safari on iPhone', keyId: 'key-a', createdAt: '2026-08-20T10:00:00Z', lastUsedAt: '2026-08-20T11:00:00Z', current: true,
    }]);
  });

  it('accepts direct and enveloped notification destinations but rejects missing ownership data', () => {
    expect(adaptNotificationDestination({ groupId: ' group-b ' })).toEqual({ groupId: 'group-b' });
    expect(adaptNotificationDestination({ destination: { groupId: 'group-c' } })).toEqual({ groupId: 'group-c' });
    expect(() => adaptNotificationDestination({ destination: {} })).toThrow('missing groupId');
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

  it('defaults legacy payment attachment policies and exposes only safe receipt metadata', () => {
    expect(adaptTransactionSettings({ paymentMethods: [
      { id: 'CASH', label: 'Cash' },
      { id: 'SHOPPING', label: 'Shopping', attachmentMode: 'REQUIRED' },
    ] }).paymentMethods).toEqual([
      { id: 'CASH', label: 'Bar', attachmentMode: 'OFF', paymentTarget: null },
      { id: 'SHOPPING', label: 'Einkauf', attachmentMode: 'REQUIRED', paymentTarget: null },
    ]);
    expect(adaptPayment({
      id: 'payment-a', membershipId: 'member-a', memberName: 'Alex', amountMinor: 1234, currency: 'EUR', receivedAt: '2026-08-20', method: 'SHOPPING', status: 'POSTED',
      attachment: { fileName: 'receipt.pdf', mediaType: 'application/pdf', sizeBytes: 1024, url: '/api/v1/groups/group-a/payments/payment-a/attachment', storageKey: 'secret' },
    }).attachment).toEqual({ fileName: 'receipt.pdf', mediaType: 'application/pdf', sizeBytes: 1024, url: '/api/v1/groups/group-a/payments/payment-a/attachment' });
  });

  it('adapts canonical payment targets and drops unsafe nested values', () => {
    expect(adaptPaymentTarget({ type: 'PAYPAL_ME', paypalMeHandle: ' TeamTaler42 ' })).toEqual({ type: 'PAYPAL_ME', paypalMeHandle: 'TeamTaler42' });
    expect(adaptPaymentTarget({ type: 'PAYPAL_ME', paypalMeHandle: 'https://paypal.me/TeamTaler42' })).toBeNull();
    expect(adaptPaymentTarget({ type: 'SEPA_TRANSFER', recipientName: ' TeamTaler Club ', iban: 'de89 3704 0044 0532 0130 00', bic: 'cobadeffxxx' })).toEqual({
      type: 'SEPA_TRANSFER', recipientName: 'TeamTaler Club', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX',
    });
    expect(adaptPaymentTarget({ type: 'SEPA_TRANSFER', recipientName: 'TeamTaler Club', iban: 'DE89370400440532013001' })).toBeNull();
    expect(adaptPaymentTarget({ type: 'SEPA_TRANSFER', recipientName: 'TeamTaler Club', iban: 'CH9300762011623852957' })).toBeNull();
    expect(adaptPaymentTarget({ type: 'SEPA_TRANSFER', recipientName: 'TeamTaler Club', iban: 'CH9300762011623852957', bic: 'POFICHBEXXX' })).toEqual({
      type: 'SEPA_TRANSFER', recipientName: 'TeamTaler Club', iban: 'CH9300762011623852957', bic: 'POFICHBEXXX',
    });
    expect(adaptPaymentTarget({ type: 'SEPA_TRANSFER', recipientName: 'TeamTaler Club', iban: 'DE89370400440532013000', bic: 42 })).toBeNull();
    expect(adaptPaymentTarget({ type: 'SEPA_TRANSFER', recipientName: 'TeamTaler Club', iban: 'DE89370400440532013000', paypalMeHandle: 'TeamTaler42' })).toBeNull();
    expect(adaptPaymentTarget({ type: 'PAYPAL_ME', paypalMeHandle: 'TeamTaler42', iban: 'DE89370400440532013000' })).toBeNull();
    expect(adaptPaymentTarget({ type: 'UNKNOWN' })).toBeNull();
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

  it('formats settlement due dates in German notification copy', () => {
    const notification = adaptNotification({
      id: 'notification-settlement',
      type: 'SETTLEMENT_CREATED',
      createdAt: '2026-08-21T16:48:00Z',
      context: { periodLabel: 'August', amountMinor: '3200', currency: 'EUR', dueAt: '2026-09-07' },
    });

    expect(notification.message).toContain('Fällig am 07.09.2026.');
    expect(notification.message).not.toContain('2026-09-07');
  });

  it('includes cross-period corrections in settlement obligations and payments', () => {
    const settlement = adaptSettlement({
      id: 'statement-1',
      periodId: 'period-1',
      membershipId: 'member-1',
      membershipStatus: 'ARCHIVED',
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
    expect(settlement.membershipStatus).toBe('ARCHIVED');
  });
});
