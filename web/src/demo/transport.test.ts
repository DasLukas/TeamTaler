import { describe, expect, it } from 'vitest';
import type { AccountSummary, ActivityEntry, ActivityFilterOptions, AuthenticationCapabilities, Booking, Category, CreatedInvitation, Dashboard, Group, GroupSettings, InvitationImportResult, InvitationMetadata, LedgerEntry, Membership, Payment, PermissionDefinition, Product, PublicJoinLink, PublicJoinPreview, Role, RoleAssignment, Session, User } from '@/api/types';
import i18n from '@/i18n';
import { DemoTransport } from './transport';

const jsonRequest = (method: string, body: unknown = {}): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('DemoTransport account security', () => {
  it('fails closed for mail features while supporting local name and password changes', async () => {
    const transport = new DemoTransport();

    await expect(transport.request<AuthenticationCapabilities>('/auth/capabilities')).resolves.toEqual({ passwordResetAvailable: false, emailChangeAvailable: false });
    await expect(transport.request<User>('/me/profile', jsonRequest('PATCH', { displayName: 'Demo Changed' }))).resolves.toMatchObject({ displayName: 'Demo Changed' });
    await expect(transport.request<void>('/me/password', jsonRequest('PUT', { currentPassword: 'teamtaler-demo', newPassword: 'changed-passphrase' }))).resolves.toBeUndefined();
    await expect(transport.request<Session>('/session')).resolves.toMatchObject({ user: { displayName: 'Demo Changed' } });
  });
});

describe('DemoTransport statistics projections', () => {
  it('returns complete exact default projections with server-selected range metadata', async () => {
    const transport = new DemoTransport();
    const statistics = await transport.request<{
      meta: { preset: string; bucket: string; generatedAt: string; toExclusive: string; currentPeriodAvailable: boolean };
      members: {
        activity: Array<{ periodStart: string }>;
        topCategories: { items: Array<{ validBookedUnits: number; series: Array<{ periodStart: string; validBookedUnits: number | null; privacySuppressed: boolean; isPartial: boolean }> }> };
        topProducts: { items: Array<{ validBookedUnits: number; series: Array<{ periodStart: string; validBookedUnits: number | null; privacySuppressed: boolean; isPartial: boolean }> }> };
      };
      finance: {
        flows: { openingNetReceivableMinor: string; netBookingChargesMinor: string; netPaymentsMinor: string; netAdjustmentsMinor: string; closingNetReceivableMinor: string };
        series: Array<{ periodStart: string }>;
      };
    }>('/groups/group-sv-adler/statistics');

    expect(statistics.meta).toMatchObject({ preset: 'LAST_30_DAYS', bucket: 'DAY', currentPeriodAvailable: false });
    expect(statistics.meta.toExclusive).toBe(statistics.meta.generatedAt);
    expect(statistics.members.activity).toHaveLength(30);
    expect(statistics.members.activity[0].periodStart).toContain('2026-07-30');
    expect(statistics.members.activity.at(-1)?.periodStart).toContain('2026-08-28');
    expect(statistics.members.topCategories.items.every((item) => item.series.length === 30)).toBe(true);
    expect(statistics.members.topProducts.items.every((item) => item.series.length === 30)).toBe(true);
    expect(statistics.members.topProducts.items[0].series.at(-1)).toMatchObject({ privacySuppressed: false, isPartial: true });
    for (const item of [...statistics.members.topCategories.items, ...statistics.members.topProducts.items]) {
      expect(item.series.reduce((sum, point) => sum + (point.validBookedUnits ?? 0), 0)).toBe(item.validBookedUnits);
    }
    expect(statistics.finance.series).toHaveLength(30);
    expect(
      BigInt(statistics.finance.flows.openingNetReceivableMinor)
      + BigInt(statistics.finance.flows.netBookingChargesMinor)
      - BigInt(statistics.finance.flows.netPaymentsMinor)
      + BigInt(statistics.finance.flows.netAdjustmentsMinor),
    ).toBe(BigInt(statistics.finance.flows.closingNetReceivableMinor));
  });

  it('accepts inclusive custom dates, caps today at generation time, and rejects unavailable current period', async () => {
    const transport = new DemoTransport();
    const historical = await transport.request<{
      meta: { preset: string; bucket: string; toExclusive: string };
      members: { activity: unknown[]; topProducts: { items: Array<{ series: Array<{ isPartial: boolean }> }> } };
    }>('/groups/group-sv-adler/statistics?range=CUSTOM&from=2026-08-01&to=2026-08-05');
    const currentDay = await transport.request<{
      meta: { generatedAt: string; toExclusive: string };
      members: { activity: unknown[]; topProducts: { items: Array<{ series: Array<{ isPartial: boolean }> }> } };
    }>('/groups/group-sv-adler/statistics?range=CUSTOM&from=2026-08-28&to=2026-08-28');

    expect(historical.meta).toMatchObject({ preset: 'CUSTOM', bucket: 'DAY', toExclusive: '2026-08-06T00:00:00+02:00' });
    expect(historical.members.activity).toHaveLength(5);
    expect(historical.members.topProducts.items[0].series.at(-1)?.isPartial).toBe(false);
    expect(currentDay.meta.toExclusive).toBe(currentDay.meta.generatedAt);
    expect(currentDay.members.activity).toHaveLength(1);
    expect(currentDay.members.topProducts.items[0].series[0].isPartial).toBe(true);
    await expect(transport.request('/groups/group-sv-adler/statistics?range=CURRENT_PERIOD')).rejects.toThrow(/not available/i);
  });

  it.each([
    ['LAST_90_DAYS', 'WEEK', 14],
    ['LAST_12_MONTHS', 'MONTH', 12],
    ['ALL_TIME', 'MONTH', 32],
  ])('aligns every %s series to the shared %s bucket axis', async (range, expectedBucket, expectedLength) => {
    const transport = new DemoTransport();
    const statistics = await transport.request<{
      meta: { bucket: string };
      members: {
        activity: Array<{ periodStart: string }>;
        topCategories: { items: Array<{ isOther: boolean; series: Array<{ periodStart: string; validBookedUnits: number | null }> }> };
        topProducts: { items: Array<{ isOther: boolean; series: Array<{ periodStart: string; validBookedUnits: number | null }> }> };
      };
      finance: { series: Array<{ periodStart: string }> };
    }>(`/groups/group-sv-adler/statistics?range=${range}`);
    const sharedAxis = statistics.members.activity.map((point) => point.periodStart);

    expect(statistics.meta.bucket).toBe(expectedBucket);
    expect(sharedAxis).toHaveLength(expectedLength);
    expect(statistics.finance.series.map((point) => point.periodStart)).toEqual(sharedAxis);
    for (const item of [...statistics.members.topCategories.items, ...statistics.members.topProducts.items]) {
      expect(item.series.map((point) => point.periodStart)).toEqual(sharedAxis);
    }
    expect(statistics.members.topCategories.items.at(-1)?.isOther).toBe(true);
    expect(statistics.members.topProducts.items.at(-1)?.isOther).toBe(true);
  });

  it('follows the statistics master switch and enables the current period with settlements', async () => {
    const transport = new DemoTransport();
    await transport.request('/groups/group-sv-adler/settings', jsonRequest('PATCH', { settlementsEnabled: true }));
    await expect(transport.request<{ meta: { preset: string; currentPeriodAvailable: boolean } }>('/groups/group-sv-adler/statistics')).resolves.toMatchObject({
      meta: { preset: 'CURRENT_PERIOD', currentPeriodAvailable: true },
    });

    await transport.request('/groups/group-sv-adler/settings', jsonRequest('PATCH', { statisticsEnabled: false }));
    await expect(transport.request('/groups/group-sv-adler/statistics')).rejects.toThrow(/disabled/i);
    await expect(transport.request<Dashboard>('/groups/group-sv-adler/dashboard')).resolves.toMatchObject({
      groupCategoryTotals: [],
    });
    const dashboard = await transport.request<Dashboard>('/groups/group-sv-adler/dashboard');
    expect(dashboard.groupOutstanding).toBeUndefined();
  });
});

describe('DemoTransport appearance preferences', () => {
  it('persists account mode, membership overrides, and administrator-managed defaults', async () => {
    const transport = new DemoTransport();

    await expect(transport.request('/me/appearance', jsonRequest('PUT', { colorMode: 'DARK' }))).resolves.toEqual({ colorMode: 'DARK' });
    await expect(transport.request('/groups/group-sv-adler/theme-preference', jsonRequest('PUT', { themeOverride: 'FIRE' }))).resolves.toEqual({ themeOverride: 'FIRE' });
    await expect(transport.request('/groups/group-sv-adler/settings', jsonRequest('PATCH', { defaultTheme: 'NRW' }))).resolves.toMatchObject({ defaultTheme: 'NRW' });

    const updated = await transport.request<Session>('/session');
    expect(updated.colorMode).toBe('DARK');
    expect(updated.groups.find((group) => group.id === 'group-sv-adler')).toMatchObject({
      defaultTheme: 'NRW',
      membership: { themeOverride: 'FIRE' },
    });
  });

  it('rejects unsupported appearance values without changing the session', async () => {
    const transport = new DemoTransport();

    await expect(transport.request('/me/appearance', jsonRequest('PUT', { colorMode: 'SEPIA' }))).rejects.toThrow(/not supported/i);
    await expect(transport.request('/groups/group-sv-adler/theme-preference', jsonRequest('PUT', { themeOverride: 'CUSTOM' }))).rejects.toThrow(/not supported/i);
    await expect(transport.request<Session>('/session')).resolves.toMatchObject({ colorMode: 'SYSTEM' });
  });
});

async function demoteCurrentAdministrator(transport: DemoTransport, replacementRoleIds: string[] = ['role-member']): Promise<void> {
  await transport.request<RoleAssignment>('/groups/group-sv-adler/members/member-jonas/roles', {
    ...jsonRequest('PUT', { roleIds: ['role-admin', 'role-member'] }),
    headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
  });
  await transport.request<RoleAssignment>('/groups/group-sv-adler/members/member-lukas/roles', {
    ...jsonRequest('PUT', { roleIds: replacementRoleIds }),
    headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
  });
}

describe('DemoTransport invitation import', () => {
  it('accepts raw CSV and advances queued email delivery while listing invitations', async () => {
    const transport = new DemoTransport();
    const result = await transport.request<InvitationImportResult>('/groups/group-sv-adler/invitations/import', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv; charset=utf-8' },
      body: [
        'email,display_name,roles',
        'new.member@example.test,New Member,',
        'invalid-address,Invalid Member,',
        'finance.member@example.test,Finance Member,FINANZVERWALTUNG',
      ].join('\n'),
    });

    expect(result.summary).toEqual({ totalRows: 3, created: 2, invalid: 1, skipped: 0 });
    expect(result.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        email: 'new.member@example.test',
        invitationStatus: 'CREATED',
        emailDeliveryStatus: 'PENDING',
      }),
      expect.objectContaining({
        email: 'invalid-address',
        invitationStatus: 'INVALID',
        code: 'invalid_email',
      }),
    ]));

    const sending = await transport.request<InvitationMetadata[]>('/groups/group-sv-adler/invitations');
    expect(sending).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: 'new.member@example.test', roleIds: ['role-guest'], emailDeliveryStatus: 'SENDING' }),
      expect.objectContaining({ email: 'finance.member@example.test', roleIds: ['role-finance'], emailDeliveryStatus: 'SENDING' }),
    ]));

    const sent = await transport.request<InvitationMetadata[]>('/groups/group-sv-adler/invitations');
    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: 'new.member@example.test', emailDeliveryStatus: 'SENT' }),
    ]));
  });

  it('enforces assignment ETags for role-based invitation updates', async () => {
    const transport = new DemoTransport();
    const created = await transport.request<CreatedInvitation>('/groups/group-sv-adler/invitations', jsonRequest('POST', {
      email: 'role-update@example.test',
      displayName: 'Role Update',
      roleIds: ['role-member'],
    }));
    const updated = await transport.request<InvitationMetadata>(`/groups/group-sv-adler/invitations/${created.id}`, {
      ...jsonRequest('PATCH', { displayName: 'Updated Role', roleIds: ['role-member', 'role-finance'] }),
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
    });

    expect(updated).toMatchObject({
      displayName: 'Updated Role',
      roleIds: ['role-member', 'role-finance'],
      roleAssignmentsVersion: 2,
    });
    await expect(transport.request(`/groups/group-sv-adler/invitations/${created.id}`, {
      ...jsonRequest('PATCH', { displayName: 'Stale', roleIds: ['role-member'] }),
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
    })).rejects.toThrow(/another session/i);
  });

  it('enforces assignment ETags for legacy invitation updates', async () => {
    const transport = new DemoTransport();
    const created = await transport.request<CreatedInvitation>('/groups/group-sv-adler/invitations', jsonRequest('POST', {
      email: 'legacy-update@example.test',
      displayName: 'Legacy Update',
      roleIds: ['role-member'],
    }));
    const updated = await transport.request<InvitationMetadata>(`/groups/group-sv-adler/invitations/${created.id}`, {
      ...jsonRequest('PATCH', { displayName: 'Updated Legacy', roles: ['FINANCE_MANAGER'], groupPermissions: [], categoryGrants: {} }),
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
    });

    expect(updated).toMatchObject({ displayName: 'Updated Legacy', roleAssignmentsVersion: 2 });
    await expect(transport.request(`/groups/group-sv-adler/invitations/${created.id}`, {
      ...jsonRequest('PATCH', { displayName: 'Stale Legacy', roles: [], groupPermissions: [], categoryGrants: {} }),
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
    })).rejects.toThrow(/another session/i);
  });

  it('preserves ordinary seeded, custom, and custom-administrative roles during legacy invitation updates', async () => {
    const transport = new DemoTransport();
    const customRole = await transport.request<Role>('/groups/group-sv-adler/roles', jsonRequest('POST', {
      name: 'Event coordinator',
      grants: [{ permission: 'BOOK_FOR_OTHERS', scope: { type: 'GROUP' } }],
    }));
    const customAdminRole = await transport.request<Role>('/groups/group-sv-adler/roles', jsonRequest('POST', {
      name: 'Deputy administrator',
      grants: [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }],
    }));
    const created = await transport.request<CreatedInvitation>('/groups/group-sv-adler/invitations', jsonRequest('POST', {
      email: 'preserved-roles@example.test',
      displayName: 'Preserved Roles',
      roleIds: ['role-member', 'role-finance', 'role-self-payment', customRole.id, customAdminRole.id],
    }));

    const updated = await transport.request<InvitationMetadata>(`/groups/group-sv-adler/invitations/${created.id}`, {
      ...jsonRequest('PATCH', { displayName: 'Legacy Edit', roles: ['CATALOG_MANAGER'], groupPermissions: [], categoryGrants: {} }),
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
    });

    expect(updated.roleIds).toEqual(expect.arrayContaining(['role-member', 'role-catalog', customRole.id, customAdminRole.id]));
    expect(updated.roleIds).not.toEqual(expect.arrayContaining(['role-finance', 'role-self-payment']));
    expect(updated).toMatchObject({ roles: ['CATALOG_MANAGER'], groupPermissions: [], roleAssignmentsVersion: 2 });
  });
});

describe('DemoTransport dynamic roles', () => {
  it('creates, assigns, releases, and deletes a group-scoped role with version checks', async () => {
    const transport = new DemoTransport();
    const definitions = await transport.request<PermissionDefinition[]>('/permission-definitions');
    const created = await transport.request<Role>('/groups/group-sv-adler/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Booking desk',
        grants: [{ permission: 'BOOK_FOR_OTHERS', scope: { type: 'GROUP' } }],
      }),
    });

    expect(definitions.map((definition) => definition.key)).toContain('VOID_ANY_BOOKING');
    expect(created).toMatchObject({ groupId: 'group-sv-adler', nameLocked: false, deletable: true, version: 1 });
    const assigned = await transport.request<RoleAssignment>('/groups/group-sv-adler/members/member-mara/roles', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
      body: JSON.stringify({ roleIds: [created.id] }),
    });
    expect(assigned).toEqual({ subjectType: 'MEMBERSHIP', subjectId: 'member-mara', roleIds: [created.id], version: 2 });

    await expect(transport.request<void>(`/groups/group-sv-adler/roles/${created.id}`, {
      method: 'DELETE',
      headers: { 'If-Match': '"v1"' },
    })).rejects.toThrow(/assigned/i);
    await expect(transport.request<RoleAssignment>('/groups/group-sv-adler/members/member-mara/roles', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
      body: JSON.stringify({ roleIds: ['role-member'] }),
    })).rejects.toThrow(/another session/i);

    await transport.request<RoleAssignment>('/groups/group-sv-adler/members/member-mara/roles', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v2"' },
      body: JSON.stringify({ roleIds: ['role-member'] }),
    });
    await transport.request<void>(`/groups/group-sv-adler/roles/${created.id}`, {
      method: 'DELETE',
      headers: { 'If-Match': '"v1"' },
    });

    const roles = await transport.request<Role[]>('/groups/group-sv-adler/roles');
    expect(roles.some((role) => role.id === created.id)).toBe(false);
  });

  it('uses server-style void metadata for the short self-window and foreign actor bookings', async () => {
    const transport = new DemoTransport();
    const selfBooking = await transport.request<Booking>('/groups/group-sv-adler/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: 'product-water', productVersion: 1, expectedPeriodId: 'period-august', quantity: 1 }),
    });

    expect(selfBooking).toMatchObject({ canVoid: true, voidReasonRequired: false });
    expect(selfBooking.voidWithoutReasonUntil).toBeTruthy();
    await expect(transport.request<Booking>(`/groups/group-sv-adler/bookings/${selfBooking.id}/void`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '' }),
    })).resolves.toMatchObject({ status: 'REVERSED', canVoid: false });

    const foreign = (await transport.request<Booking[]>('/groups/group-sv-adler/bookings')).find((booking) => booking.id === 'booking-3');
    expect(foreign).toMatchObject({ canVoid: true, voidReasonRequired: true, voidWithoutReasonUntil: undefined });
    await expect(transport.request<void>('/groups/group-sv-adler/bookings/booking-3/void', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '' }),
    })).rejects.toThrow();
  });

  it('creates one booking for every target in a multi-member command', async () => {
    const transport = new DemoTransport();
    const created = await transport.request<Booking[]>('/groups/group-sv-adler/bookings/batch', jsonRequest('POST', {
      productId: 'product-water',
      productVersion: 1,
      expectedPeriodId: 'period-august',
      quantity: 2,
      targetMembershipIds: ['member-lukas', 'member-mara', 'member-jonas'],
      reason: 'Shared team order',
    }));

    expect(created).toHaveLength(3);
    expect(created.map((booking) => booking.memberId)).toEqual(['member-lukas', 'member-mara', 'member-jonas']);
    expect(created).toEqual(expect.arrayContaining([
      expect.objectContaining({ quantity: 2, reason: 'Shared team order', total: { minorUnits: '200', currency: 'EUR' } }),
    ]));
  });

  it('creates every ordered product-target combination from one bulk cart command', async () => {
    const transport = new DemoTransport();
    const created = await transport.request<Booking[]>('/groups/group-sv-adler/bookings/bulk', jsonRequest('POST', {
      expectedPeriodId: 'period-august',
      items: [
        { productId: 'product-water', productVersion: 1, quantity: 2 },
        { productId: 'product-late', productVersion: 1, quantity: 1 },
      ],
      targetMembershipIds: ['member-lukas', 'member-mara'],
      reason: 'Shared cart',
    }));

    expect(created).toHaveLength(4);
    expect(created.map((booking) => [booking.productId, booking.memberId])).toEqual([
      ['product-water', 'member-lukas'],
      ['product-water', 'member-mara'],
      ['product-late', 'member-lukas'],
      ['product-late', 'member-mara'],
    ]);
    expect(created.every((booking) => booking.reason === 'Shared cart')).toBe(true);
  });

  it('creates, renames, and offers a claim invitation for a temporary guest', async () => {
    const transport = new DemoTransport();

    const [booking] = await transport.request<Booking[]>('/groups/group-sv-adler/bookings/batch', jsonRequest('POST', {
      productId: 'product-water',
      productVersion: 1,
      expectedPeriodId: 'period-august',
      quantity: 1,
      targetMembershipIds: [],
      temporaryGuestDisplayNames: ['Guest One'],
    }));
    const members = await transport.request<Membership[]>('/groups/group-sv-adler/members');
    const guest = members.find((member) => member.id === booking.memberId);
    expect(guest).toMatchObject({ displayName: 'Guest One', email: null, isTemporaryGuest: true, roleIds: [] });

    await expect(transport.request<Membership>(`/groups/group-sv-adler/members/${guest?.id}`, jsonRequest('PATCH', { displayName: 'Renamed Guest' }))).resolves.toMatchObject({ displayName: 'Renamed Guest' });
    await expect(transport.request<CreatedInvitation>(`/groups/group-sv-adler/members/${guest?.id}/claim-invitation`, jsonRequest('POST', { email: 'guest@example.test', roleIds: ['role-member'] }))).resolves.toMatchObject({ email: 'guest@example.test', targetMembershipId: guest?.id, roleIds: ['role-member'] });
  });

  it('omits void controls on newly created bookings when current grants do not allow voiding', async () => {
    const transport = new DemoTransport();
    await transport.request<Role>('/groups/group-sv-adler/roles/role-member', {
      ...jsonRequest('PUT', { name: 'Mitglied', description: 'Bearbeitbare Startrolle für reguläre Gruppenmitglieder', grants: [{ permission: 'CREATE_OWN_BOOKING', scope: { type: 'GROUP' } }] }),
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
    });
    await demoteCurrentAdministrator(transport);

    const booking = await transport.request<Booking>('/groups/group-sv-adler/bookings', jsonRequest('POST', {
      productId: 'product-water',
      productVersion: 1,
      expectedPeriodId: 'period-august',
      quantity: 1,
    }));

    expect(booking).toMatchObject({ canVoid: false, voidReasonRequired: false });
    expect(booking.voidWithoutReasonUntil).toBeUndefined();
  });
});

describe('DemoTransport legacy member permissions', () => {
  it('requires the current assignment ETag and rejects missing or stale versions', async () => {
    const transport = new DemoTransport();
    const update = { roles: ['CATALOG_MANAGER'], groupPermissions: ['SELF_RECORD_PAYMENT'], categoryGrants: {} };

    await expect(transport.request('/groups/group-sv-adler/members/member-mara/permissions', jsonRequest('PATCH', update))).rejects.toThrow();

    const persisted = await transport.request<Membership>('/groups/group-sv-adler/members/member-mara/permissions', {
      ...jsonRequest('PATCH', update),
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
    });
    expect(persisted).toMatchObject({
      roleIds: expect.arrayContaining(['role-catalog', 'role-self-payment']),
      roleAssignmentsVersion: 2,
    });
    expect(persisted.roleIds).not.toContain('role-finance');

    await expect(transport.request('/groups/group-sv-adler/members/member-mara/permissions', {
      ...jsonRequest('PATCH', update),
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
    })).rejects.toThrow(/another session/i);
  });
});

describe('DemoTransport protected route policy', () => {
  it('denies protected finance, period, audit, invitation, catalog, and group-management routes after immediate role withdrawal', async () => {
    const transport = new DemoTransport();
    await demoteCurrentAdministrator(transport);
    const requests: Array<[string, RequestInit?]> = [
      ['/groups/group-sv-adler/settings'],
      ['/groups/group-sv-adler/accounts'],
      ['/groups/group-sv-adler/accounts/member-mara'],
      ['/groups/group-sv-adler/payments'],
      ['/groups/group-sv-adler/payments', jsonRequest('POST', { membershipId: 'member-mara' })],
      ['/groups/group-sv-adler/payments/payment-1/reverse', jsonRequest('POST', { reason: 'Correction' })],
      ['/groups/group-sv-adler/periods'],
      ['/groups/group-sv-adler/periods/period-august/close', jsonRequest('POST', { label: 'August', dueAt: '2026-08-15' })],
      ['/groups/group-sv-adler/periods/period-july/statements'],
      ['/groups/group-sv-adler/settlements'],
      ['/groups/group-sv-adler/audit'],
      ['/groups/group-sv-adler/invitations'],
      ['/groups/group-sv-adler/invitations', jsonRequest('POST', { email: 'new@example.test', displayName: '', roleIds: ['role-member'] })],
      ['/groups/group-sv-adler/invitations/import', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: 'email\nnew@example.test' }],
      ['/groups/group-sv-adler/invitations/invitation-a', jsonRequest('PATCH', { displayName: 'Updated' })],
      ['/groups/group-sv-adler/invitations/invitation-a', { method: 'DELETE' }],
      ['/groups/group-sv-adler/invitations/invitation-a/roles', { ...jsonRequest('PUT', { roleIds: ['role-member'] }), headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' } }],
      ['/groups/group-sv-adler/invitations/invitation-a/email/retry', { method: 'POST' }],
      ['/groups/group-sv-adler/invitations/invitation-a/email/resend', { method: 'POST' }],
      ['/groups/group-sv-adler/catalog/order', jsonRequest('PUT', {})],
      ['/groups/group-sv-adler/categories', jsonRequest('POST', { name: 'New', icon: 'other' })],
      ['/groups/group-sv-adler/categories/category-drinks', jsonRequest('PATCH', {})],
      ['/groups/group-sv-adler/categories/category-drinks', { method: 'DELETE' }],
      ['/groups/group-sv-adler/categories/category-drinks/products', jsonRequest('POST', {})],
      ['/groups/group-sv-adler/products/product-water', jsonRequest('PATCH', {})],
      ['/groups/group-sv-adler/products/product-water', { method: 'DELETE' }],
      ['/groups/group-sv-adler/products/product-water/image', { method: 'POST', body: new FormData() }],
    ];

    await Promise.all(requests.map(async ([path, init]) => {
      await expect(transport.request(path, init)).rejects.toThrow(i18n.t('admin.noAccessMessage'));
    }));
    await expect(transport.request<Membership[]>('/groups/group-sv-adler/members')).resolves.toEqual(expect.any(Array));
  });

  it('keeps invitations unavailable to a pure role manager while preserving seeded directory access', async () => {
    const transport = new DemoTransport();
    const role = await transport.request<Role>('/groups/group-sv-adler/roles', jsonRequest('POST', {
      name: 'Role manager',
      grants: [{ permission: 'ROLE_MANAGEMENT', scope: { type: 'GROUP' } }],
    }));
    await demoteCurrentAdministrator(transport, ['role-member', role.id]);

    await expect(transport.request<InvitationMetadata[]>('/groups/group-sv-adler/invitations')).rejects.toThrow(i18n.t('admin.noAccessMessage'));
    await expect(transport.request<Membership[]>('/groups/group-sv-adler/members')).resolves.toEqual(expect.any(Array));
    await expect(transport.request('/groups/group-sv-adler/invitations', jsonRequest('POST', {
      email: 'new@example.test',
      displayName: 'New Member',
      roleIds: ['role-member'],
    }))).rejects.toThrow(i18n.t('admin.noAccessMessage'));
  });

  it('keeps role data unavailable to group-only administrators while preserving seeded directory access', async () => {
    const transport = new DemoTransport();
    const groupAdministrator = await transport.request<Role>('/groups/group-sv-adler/roles', jsonRequest('POST', {
      name: 'Group administration only',
      grants: [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }],
    }));
    await demoteCurrentAdministrator(transport, ['role-member', groupAdministrator.id]);

    await expect(transport.request<Role[]>('/groups/group-sv-adler/roles')).rejects.toThrow(i18n.t('admin.noAccessMessage'));
    await expect(transport.request<RoleAssignment[]>('/groups/group-sv-adler/role-assignments')).rejects.toThrow(i18n.t('admin.noAccessMessage'));
    await expect(transport.request<Membership[]>('/groups/group-sv-adler/members')).resolves.toEqual(expect.any(Array));
  });

  it('allows member managers to assign ordinary roles but not protected administration', async () => {
    const transport = new DemoTransport();
    const memberManager = await transport.request<Role>('/groups/group-sv-adler/roles', jsonRequest('POST', {
      name: 'Member manager',
      grants: [{ permission: 'MEMBER_MANAGEMENT', scope: { type: 'GROUP' } }],
    }));
    await demoteCurrentAdministrator(transport, ['role-member', memberManager.id]);

    await expect(transport.request<Membership[]>('/groups/group-sv-adler/members')).resolves.toEqual(expect.any(Array));
    await expect(transport.request<InvitationMetadata[]>('/groups/group-sv-adler/invitations')).resolves.toEqual([]);
    await expect(transport.request<Role[]>('/groups/group-sv-adler/roles')).resolves.toEqual(expect.any(Array));
    await expect(transport.request<Role>('/groups/group-sv-adler/roles/role-member')).rejects.toThrow(i18n.t('admin.noAccessMessage'));
    const assignments = await transport.request<RoleAssignment[]>('/groups/group-sv-adler/role-assignments');
    const mara = assignments.find((assignment) => assignment.subjectId === 'member-mara')!;
    const updated = await transport.request<RoleAssignment>('/groups/group-sv-adler/members/member-mara/roles', {
      ...jsonRequest('PUT', { roleIds: [...mara.roleIds, 'role-catalog'] }),
      headers: { 'Content-Type': 'application/json', 'If-Match': `"v${mara.version}"` },
    });
    expect(updated.roleIds).toContain('role-catalog');

    await expect(transport.request<RoleAssignment>('/groups/group-sv-adler/members/member-mara/roles', {
      ...jsonRequest('PUT', { roleIds: [...updated.roleIds, 'role-admin'] }),
      headers: { 'Content-Type': 'application/json', 'If-Match': `"v${updated.version}"` },
    })).rejects.toThrow(i18n.t('admin.noAccessMessage'));
  });
});

describe('DemoTransport group settings', () => {
  it('persists a normalized group name in the demo session', async () => {
    const transport = new DemoTransport();
    await expect(transport.request<{ name: string }>('/groups/group-sv-adler', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '  Renamed Group  ' }),
    })).resolves.toEqual({ name: 'Renamed Group' });

    const groups = await transport.request<Group[]>('/groups');
    expect(groups.find((group) => group.id === 'group-sv-adler')?.name).toBe('Renamed Group');
  });

  it('persists typed behavior settings', async () => {
    const transport = new DemoTransport();
    await expect(transport.request<GroupSettings>('/groups/group-sv-adler/settings')).resolves.toMatchObject({
      settlementsEnabled: false,
      settlementDueSoonDays: 3,
      settlementOverdueRepeatDays: 7,
      defaultRoleId: 'role-guest',
      ownBookingReasonMode: 'OFF',
      foreignBookingReasonMode: 'REQUIRED',
      ownPaymentReasonMode: 'REQUIRED',
      otherPaymentReasonMode: 'OPTIONAL',
      paymentMethods: [
        { id: 'BANK_TRANSFER', label: 'Bank transfer', attachmentMode: 'OFF' },
        { id: 'SHOPPING', label: 'Shopping', attachmentMode: 'REQUIRED' },
        { id: 'CASH', label: 'Cash', attachmentMode: 'OFF' },
        { id: 'PAYPAL', label: 'PayPal', attachmentMode: 'OFF' },
        { id: 'OTHER', label: 'Other', attachmentMode: 'OPTIONAL' },
      ],
    });
    await expect(transport.request<GroupSettings>('/groups/group-sv-adler/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settlementsEnabled: true }),
    })).resolves.toMatchObject({ settlementsEnabled: true });
    await expect(transport.request<GroupSettings>('/groups/group-sv-adler/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settlementDueSoonDays: 5, settlementOverdueRepeatDays: 10 }),
    })).resolves.toMatchObject({ settlementDueSoonDays: 5, settlementOverdueRepeatDays: 10, defaultRoleId: 'role-guest' });
    await expect(transport.request<GroupSettings>('/groups/group-sv-adler/settings', jsonRequest('PATCH', {
      ownBookingReasonMode: 'OPTIONAL',
      foreignBookingReasonMode: 'OFF',
      ownPaymentReasonMode: 'OFF',
      otherPaymentReasonMode: 'REQUIRED',
    }))).resolves.toMatchObject({
      ownBookingReasonMode: 'OPTIONAL',
      foreignBookingReasonMode: 'OFF',
      ownPaymentReasonMode: 'OFF',
      otherPaymentReasonMode: 'REQUIRED',
      foreignBookingReasonRequired: false,
      ownPaymentReasonRequired: false,
      otherPaymentReasonRequired: true,
    });
    await expect(transport.request<GroupSettings>('/groups/group-sv-adler/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultRoleId: 'role-finance' }),
    })).resolves.toMatchObject({ settlementDueSoonDays: 5, settlementOverdueRepeatDays: 10, defaultRoleId: 'role-finance' });
    await expect(transport.request<GroupSettings>('/groups/group-sv-adler/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultRoleId: 'role-admin' }),
    })).rejects.toThrow(/must not grant administration permissions/i);
    await expect(transport.request<GroupSettings>('/groups/group-sv-adler/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
      body: JSON.stringify({ membersCanViewAllBookings: true }),
    })).rejects.toThrow();
    await expect(transport.request<GroupSettings>('/groups/group-sv-adler/settings')).resolves.toMatchObject({ settlementDueSoonDays: 5, settlementOverdueRepeatDays: 10, defaultRoleId: 'role-finance' });
  });

  it('roundtrips nullable PayPal.Me and SEPA payment targets through member settings', async () => {
    const transport = new DemoTransport();
    const paymentMethods = [
      { id: 'PAYPAL', label: 'PayPal', attachmentMode: 'OFF' as const, paymentTarget: { type: 'PAYPAL_ME' as const, paypalMeHandle: 'TeamTaler42' } },
      { id: 'BANK_TRANSFER', label: 'Bank transfer', attachmentMode: 'OFF' as const, paymentTarget: { type: 'SEPA_TRANSFER' as const, recipientName: 'TeamTaler Club', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' } },
      { id: 'CASH', label: 'Cash', attachmentMode: 'OFF' as const, paymentTarget: null },
    ];

    await expect(transport.request<GroupSettings>('/groups/group-sv-adler/settings', jsonRequest('PATCH', { paymentMethods }))).resolves.toMatchObject({ paymentMethods });
    await expect(transport.request('/groups/group-sv-adler/transaction-settings')).resolves.toMatchObject({ paymentMethods });

    const legacyPaymentMethods = paymentMethods.map((method) => ({ id: method.id, label: method.label, attachmentMode: method.attachmentMode }));
    await expect(transport.request<GroupSettings>('/groups/group-sv-adler/settings', jsonRequest('PATCH', { paymentMethods: legacyPaymentMethods }))).resolves.toMatchObject({ paymentMethods });

    const withPaypalCleared = legacyPaymentMethods.map((method) => method.id === 'PAYPAL' ? { ...method, paymentTarget: null } : method);
    await expect(transport.request<GroupSettings>('/groups/group-sv-adler/settings', jsonRequest('PATCH', { paymentMethods: withPaypalCleared }))).resolves.toMatchObject({
      paymentMethods: [
        expect.objectContaining({ id: 'PAYPAL', paymentTarget: null }),
        expect.objectContaining({ id: 'BANK_TRANSFER', paymentTarget: paymentMethods[1]?.paymentTarget }),
        expect.objectContaining({ id: 'CASH', paymentTarget: null }),
      ],
    });
  });

  it('accepts either role or group management for the default role', async () => {
    const groupTransport = new DemoTransport();
    const groupOnly = await groupTransport.request<Role>('/groups/group-sv-adler/roles', jsonRequest('POST', {
      name: 'Group configuration',
      grants: [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }],
    }));
    await demoteCurrentAdministrator(groupTransport, ['role-member', groupOnly.id]);
    await expect(groupTransport.request('/groups/group-sv-adler/settings', jsonRequest('PATCH', { settlementsEnabled: true }))).resolves.toMatchObject({ settlementsEnabled: true });
    await expect(groupTransport.request('/groups/group-sv-adler/settings', jsonRequest('PATCH', { defaultRoleId: 'role-finance' }))).resolves.toMatchObject({ defaultRoleId: 'role-finance' });

    const roleTransport = new DemoTransport();
    const roleOnly = await roleTransport.request<Role>('/groups/group-sv-adler/roles', jsonRequest('POST', {
      name: 'Role definitions',
      grants: [{ permission: 'ROLE_MANAGEMENT', scope: { type: 'GROUP' } }],
    }));
    await demoteCurrentAdministrator(roleTransport, ['role-member', roleOnly.id]);
    await expect(roleTransport.request('/groups/group-sv-adler/settings', jsonRequest('PATCH', { defaultRoleId: 'role-finance' }))).resolves.toMatchObject({ defaultRoleId: 'role-finance' });
    await expect(roleTransport.request('/groups/group-sv-adler/settings', jsonRequest('PATCH', { settlementsEnabled: true }))).rejects.toThrow(i18n.t('admin.noAccessMessage'));

    const financeTransport = new DemoTransport();
    const financeOnly = await financeTransport.request<Role>('/groups/group-sv-adler/roles', jsonRequest('POST', {
      name: 'Finance configuration',
      grants: [{ permission: 'FINANCE_MANAGEMENT', scope: { type: 'GROUP' } }],
    }));
    await demoteCurrentAdministrator(financeTransport, ['role-member', financeOnly.id]);
    await expect(financeTransport.request('/groups/group-sv-adler/settings', jsonRequest('PATCH', { settlementsEnabled: true }))).resolves.toMatchObject({ settlementsEnabled: true });
    await expect(financeTransport.request('/groups/group-sv-adler/settings', jsonRequest('PATCH', { defaultRoleId: 'role-finance' }))).rejects.toThrow(i18n.t('admin.noAccessMessage'));

    const combinedTransport = new DemoTransport();
    const combined = await combinedTransport.request<Role>('/groups/group-sv-adler/roles', jsonRequest('POST', {
      name: 'Default role administration',
      grants: [
        { permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } },
        { permission: 'ROLE_MANAGEMENT', scope: { type: 'GROUP' } },
      ],
    }));
    await demoteCurrentAdministrator(combinedTransport, ['role-member', combined.id]);
    await expect(combinedTransport.request('/groups/group-sv-adler/settings', jsonRequest('PATCH', { defaultRoleId: 'role-finance' }))).resolves.toMatchObject({ defaultRoleId: 'role-finance' });
    await expect(combinedTransport.request('/groups/group-sv-adler/settings', jsonRequest('PATCH', { defaultRoleId: 'role-member', settlementsEnabled: true }))).resolves.toMatchObject({ defaultRoleId: 'role-member', settlementsEnabled: true });
  });

  it('rejects period closing until settlements are enabled', async () => {
    const transport = new DemoTransport();
    const before = await transport.request<Dashboard>('/groups/group-sv-adler/dashboard');

    await expect(transport.request('/groups/group-sv-adler/periods/period-august/close', jsonRequest('POST', { label: 'August 2026', dueAt: '2026-08-15' }))).rejects.toThrow(/disabled/i);
    await transport.request('/groups/group-sv-adler/settings', jsonRequest('PATCH', { settlementsEnabled: true }));
    await expect(transport.request('/groups/group-sv-adler/periods/period-august/close', jsonRequest('POST', { label: 'August 2026', dueAt: '2026-08-15' }))).resolves.toMatchObject({ status: 'CLOSED' });
    const after = await transport.request<Dashboard>('/groups/group-sv-adler/dashboard');

    expect(after.groupOutstanding).toEqual(before.groupOutstanding);
  });
});

describe('DemoTransport catalog order', () => {
  it('persists category and product positions across catalog and dashboard reads', async () => {
    const transport = new DemoTransport();
    const reordered = await transport.request<Category[]>('/groups/group-sv-adler/catalog/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        categoryIds: ['category-penalties', 'category-drinks'],
        productIdsByCategory: {
          'category-penalties': ['product-kit', 'product-late'],
          'category-drinks': ['product-beer', 'product-water', 'product-spezi'],
        },
      }),
    });
    const catalog = await transport.request<Category[]>('/groups/group-sv-adler/categories');
    const dashboard = await transport.request<Dashboard>('/groups/group-sv-adler/dashboard');

    expect(reordered.map((category) => category.id)).toEqual(['category-penalties', 'category-drinks']);
    expect(catalog[0].products.map((product) => product.id)).toEqual(['product-kit', 'product-late']);
    expect(catalog[1].products.map((product) => product.id)).toEqual(['product-beer', 'product-water', 'product-spezi']);
    expect(dashboard.categoryTotals.map((total) => total.categoryId)).toEqual(['category-penalties', 'category-drinks']);
    expect(dashboard.groupCategoryTotals.map((total) => total.categoryId)).toEqual(['category-penalties', 'category-drinks']);
  });

  it('rejects incomplete orders without changing the catalog', async () => {
    const transport = new DemoTransport();
    await expect(transport.request<Category[]>('/groups/group-sv-adler/catalog/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryIds: ['category-drinks'], productIdsByCategory: { 'category-drinks': [] } }),
    })).rejects.toThrow();

    const catalog = await transport.request<Category[]>('/groups/group-sv-adler/categories');
    expect(catalog.map((category) => category.id)).toEqual(['category-drinks', 'category-penalties']);
  });
});

describe('DemoTransport finance accounts', () => {
  it('serves one globally sorted activity collection with signed filters', async () => {
    const transport = new DemoTransport();
    const payments = await transport.request<ActivityEntry[]>('/groups/group-sv-adler/activities?kind=PAYMENT&amountMin=-2500&amountMax=-1000&sort=amount&direction=asc');
    const options = await transport.request<ActivityFilterOptions>('/groups/group-sv-adler/activities/filter-options');

    expect(payments).not.toHaveLength(0);
    expect(payments.every((entry) => entry.kind === 'PAYMENT' && BigInt(entry.amount.minorUnits) < 0n)).toBe(true);
    expect(payments.map((entry) => BigInt(entry.amount.minorUnits))).toEqual([...payments].map((entry) => BigInt(entry.amount.minorUnits)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
    expect(options.kinds).toEqual(['BOOKING', 'PAYMENT', 'ADJUSTMENT']);
    expect(options.members.some((member) => member.membershipId === 'member-lukas')).toBe(true);
    expect(options.categories.some((category) => category.categoryId === 'category-drinks')).toBe(true);
    expect(options.products.some((product) => product.productId === 'product-beer' && product.categoryId === 'category-drinks')).toBe(true);
  });

  it('projects linked booking and payment reversals and resolves anchored context', async () => {
    const transport = new DemoTransport();
    await transport.request<Booking>('/groups/group-sv-adler/bookings/booking-1/void', jsonRequest('POST', { reason: 'Duplicate booking' }));
    await transport.request<void>('/groups/group-sv-adler/payments/payment-1/reverse', jsonRequest('POST', { reason: 'Duplicate payment' }));

    const activities = await transport.request<ActivityEntry[]>('/groups/group-sv-adler/activities?sort=occurredAt&direction=desc');
    const booking = activities.find((entry) => entry.id === 'booking:booking-1');
    const bookingReversal = activities.find((entry) => entry.id === 'reversal:booking:booking-1');
    const payment = activities.find((entry) => entry.id === 'payment:payment-1');
    const paymentReversal = activities.find((entry) => entry.id === 'reversal:payment:payment-1');

    expect(booking).toMatchObject({ status: 'REVERSED', relatedActivityId: 'reversal:booking:booking-1', amount: { minorUnits: '200' } });
    expect(bookingReversal).toMatchObject({
      kind: 'REVERSAL',
      reversalSourceKind: 'BOOKING',
      relatedActivityId: 'booking:booking-1',
      detailNote: 'Duplicate booking',
      status: 'POSTED',
      amount: { minorUnits: '-200' },
      canReverse: false,
    });
    expect(payment).toMatchObject({ status: 'REVERSED', relatedActivityId: 'reversal:payment:payment-1', amount: { minorUnits: '-2000' } });
    expect(paymentReversal).toMatchObject({
      kind: 'REVERSAL',
      reversalSourceKind: 'PAYMENT',
      relatedActivityId: 'payment:payment-1',
      detailNote: 'Duplicate payment',
      status: 'POSTED',
      amount: { minorUnits: '2000' },
      canReverse: false,
    });

    const reversals = await transport.request<ActivityEntry[]>('/groups/group-sv-adler/activities?kind=REVERSAL');
    const anchored = await transport.request<ActivityEntry[]>('/groups/group-sv-adler/activities?kind=BOOKING&anchorId=reversal%3Apayment%3Apayment-1&limit=3');
    const options = await transport.request<ActivityFilterOptions>('/groups/group-sv-adler/activities/filter-options');
    expect(reversals.map((entry) => entry.id)).toEqual(expect.arrayContaining(['reversal:booking:booking-1', 'reversal:payment:payment-1']));
    expect(anchored.some((entry) => entry.id === 'reversal:payment:payment-1')).toBe(true);
    expect(options.kinds).toContain('REVERSAL');
    await expect(transport.request('/groups/group-sv-adler/activities?anchorId=booking%3Abooking-1&cursor=cursor-a')).rejects.toThrow(/anchor/i);
  });

  it('lists active and archived summaries and applies booking movements', async () => {
    const transport = new DemoTransport();
    const before = await transport.request<AccountSummary[]>('/groups/group-sv-adler/accounts');
    const dashboardBefore = await transport.request<Dashboard>('/groups/group-sv-adler/dashboard');
    const lukasBefore = before.find((account) => account.membershipId === 'member-lukas');
    expect(before.some((account) => account.status === 'ARCHIVED')).toBe(true);

    await transport.request<Booking>('/groups/group-sv-adler/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: 'product-water', productVersion: 1, expectedPeriodId: 'period-august', quantity: 1 }),
    });
    const after = await transport.request<AccountSummary[]>('/groups/group-sv-adler/accounts');
    const dashboardAfter = await transport.request<Dashboard>('/groups/group-sv-adler/dashboard');
    const lukasAfter = after.find((account) => account.membershipId === 'member-lukas');

    expect(BigInt(lukasAfter?.balance.minorUnits ?? '0') - BigInt(lukasBefore?.balance.minorUnits ?? '0')).toBe(100n);
    expect(BigInt(dashboardAfter.groupOutstanding?.minorUnits ?? '0') - BigInt(dashboardBefore.groupOutstanding?.minorUnits ?? '0')).toBe(100n);
  });

  it('posts an authorized own payment to the session membership and exposes resulting credit', async () => {
    const transport = new DemoTransport();
    const before = await transport.request<Dashboard>('/groups/group-sv-adler/dashboard');

    const payment = await transport.request<Payment>('/groups/group-sv-adler/payments/self', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountMinor: 3000, receivedAt: '2026-08-06T00:00:00.000Z', method: 'PAYPAL', reference: 'PayPal advance' }),
    });
    const after = await transport.request<Dashboard>('/groups/group-sv-adler/dashboard');
    const ledger = await transport.request<LedgerEntry[]>('/groups/group-sv-adler/accounts/me');

    expect(payment).toMatchObject({ membershipId: 'member-lukas', method: 'PAYPAL', reference: 'PayPal advance', status: 'POSTED' });
    expect(BigInt(after.openBalance.minorUnits)).toBe(BigInt(before.openBalance.minorUnits) - 3000n);
    expect(BigInt(after.groupOutstanding?.minorUnits ?? '0')).toBe(BigInt(before.groupOutstanding?.minorUnits ?? '0') - 3000n);
    expect(after.openBalance.minorUnits).toBe('-660');
    expect(ledger[0]).toMatchObject({ kind: 'PAYMENT', referenceId: payment.id, balance: { minorUnits: '-660', currency: 'EUR' } });
  });

  it('supports custom required-receipt methods and protected demo downloads', async () => {
    const transport = new DemoTransport();
    await transport.request('/groups/group-sv-adler/settings', jsonRequest('PATCH', {
      paymentMethods: [{ id: 'SHOPPING', label: 'Shopping', attachmentMode: 'REQUIRED' }],
    }));
    const command = { amountMinor: 1250, receivedAt: '2026-08-20', method: 'SHOPPING', reference: 'Supplies' };
    await expect(transport.request('/groups/group-sv-adler/payments/self', jsonRequest('POST', command))).rejects.toThrow('required');

    const receipt = new File(['receipt'], 'receipt.pdf', { type: 'application/pdf' });
    const form = new FormData();
    form.append('command', new Blob([JSON.stringify(command)], { type: 'application/json' }), 'command.json');
    form.append('attachment', receipt, receipt.name);
    const payment = await transport.request<Payment>('/groups/group-sv-adler/payments/self', { method: 'POST', body: form });

    expect(payment).toMatchObject({ method: 'SHOPPING', attachment: { fileName: 'receipt.pdf', mediaType: 'application/pdf', sizeBytes: 7 } });
    await expect(transport.request<Blob>(`/groups/group-sv-adler/payments/${payment.id}/attachment`)).resolves.toMatchObject({ size: 7, type: 'application/pdf' });
    const ledger = await transport.request<LedgerEntry[]>('/groups/group-sv-adler/accounts/me');
    expect(ledger[0]).toMatchObject({ referenceId: payment.id, attachment: { fileName: 'receipt.pdf' } });
  });
});

describe('DemoTransport profile images', () => {
  it('propagates upload and removal between session and memberships', async () => {
    const transport = new DemoTransport();
    const form = new FormData();
    form.set('image', new File(['avatar'], 'avatar.png', { type: 'image/png' }));

    const uploaded = await transport.request<{ avatarUrl: string }>('/me/avatar', { method: 'POST', body: form });
    const session = await transport.request<Session>('/session');
    const members = await transport.request<Membership[]>('/groups/group-sv-adler/members');
    const bookings = await transport.request<Booking[]>('/groups/group-sv-adler/bookings');
    const dashboard = await transport.request<Dashboard>('/groups/group-sv-adler/dashboard');
    const currentMembershipId = session.groups.find((group) => group.id === session.activeGroupId)?.membership?.id;
    const selfBooking = bookings.find((booking) => booking.memberId === currentMembershipId && booking.bookedByMemberId === currentMembershipId);
    const dashboardSelfBooking = dashboard.recentBookings.find((booking) => booking.memberId === currentMembershipId && booking.bookedByMemberId === currentMembershipId);
    expect(uploaded.avatarUrl).toMatch(/^blob:/);
    expect(session.user.avatarUrl).toBe(uploaded.avatarUrl);
    expect(members.find((member) => member.userId === session.user.id)?.avatarUrl).toBe(uploaded.avatarUrl);
    expect(selfBooking).toMatchObject({ memberAvatarUrl: uploaded.avatarUrl, bookedByAvatarUrl: uploaded.avatarUrl });
    expect(dashboardSelfBooking).toMatchObject({ memberAvatarUrl: uploaded.avatarUrl, bookedByAvatarUrl: uploaded.avatarUrl });

    await transport.request<void>('/me/avatar', { method: 'DELETE' });
    const removedSession = await transport.request<Session>('/session');
    const removedMembers = await transport.request<Membership[]>('/groups/group-sv-adler/members');
    const removedBookings = await transport.request<Booking[]>('/groups/group-sv-adler/bookings');
    expect(removedSession.user.avatarUrl).toBeUndefined();
    expect(removedMembers.find((member) => member.userId === session.user.id)?.avatarUrl).toBeUndefined();
    expect(removedBookings.find((booking) => booking.id === selfBooking?.id)).toMatchObject({ memberAvatarUrl: undefined, bookedByAvatarUrl: undefined });
  });
});

describe('DemoTransport product pricing', () => {
  it('creates and books a user-defined-price product with production-equivalent totals', async () => {
    const transport = new DemoTransport();
    const product = await transport.request<Product>('/groups/group-sv-adler/categories/category-drinks/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Donation', pricingMode: 'USER_DEFINED', sortOrder: 0 }),
    });

    expect(product).toMatchObject({ pricingMode: 'USER_DEFINED', currency: 'EUR', price: undefined });
    const booking = await transport.request<Booking>('/groups/group-sv-adler/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: product.id, productVersion: 1, expectedPeriodId: 'period-august', quantity: 2, unitPriceMinor: 275 }),
    });

    expect(booking.unitPrice.minorUnits).toBe('275');
    expect(booking.total.minorUnits).toBe('550');
  });

  it('rejects a client price for a fixed-price demo product', async () => {
    const transport = new DemoTransport();
    await expect(transport.request<Booking>('/groups/group-sv-adler/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: 'product-water', productVersion: 1, expectedPeriodId: 'period-august', quantity: 1, unitPriceMinor: 250 }),
    })).rejects.toThrow();
  });

  it('updates categories and products with incremented versions', async () => {
    const transport = new DemoTransport();
    const category = await transport.request<Category>('/groups/group-sv-adler/categories/category-drinks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
      body: JSON.stringify({ name: 'Refreshments', icon: 'event', active: false, sortOrder: 5, version: 1 }),
    });
    const product = await transport.request<Product>('/groups/group-sv-adler/products/product-water', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
      body: JSON.stringify({ name: 'Still water', pricingMode: 'USER_DEFINED', active: false, sortOrder: 4, version: 1 }),
    });

    expect(category).toMatchObject({ name: 'Refreshments', icon: 'event', active: false, sortOrder: 5, version: 2 });
    expect(product).toMatchObject({ name: 'Still water', pricingMode: 'USER_DEFINED', price: undefined, active: false, sortOrder: 4, version: 2 });
  });

  it('deletes archived and unused catalog entries', async () => {
    const transport = new DemoTransport();
    const category = await transport.request<Category>('/groups/group-sv-adler/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Temporary', icon: 'other', sortOrder: 0 }),
    });
    const product = await transport.request<Product>(`/groups/group-sv-adler/categories/${category.id}/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Temporary item', pricingMode: 'FIXED', priceMinor: 100, sortOrder: 0 }),
    });

    await expect(transport.request<void>(`/groups/group-sv-adler/products/${product.id}`, { method: 'DELETE', headers: { 'If-Match': `"v${product.version}"` } })).rejects.toThrow();
    const archivedProduct = await transport.request<Product>(`/groups/group-sv-adler/products/${product.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: product.name, pricingMode: product.pricingMode, priceMinor: 100, active: false, sortOrder: product.sortOrder, version: product.version }),
    });
    await transport.request<void>(`/groups/group-sv-adler/products/${archivedProduct.id}`, { method: 'DELETE', headers: { 'If-Match': `"v${archivedProduct.version}"` } });
    const archivedCategory = await transport.request<Category>(`/groups/group-sv-adler/categories/${category.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: category.name, icon: category.icon, active: false, sortOrder: category.sortOrder, version: category.version }),
    });
    await transport.request<void>(`/groups/group-sv-adler/categories/${archivedCategory.id}`, { method: 'DELETE', headers: { 'If-Match': `"v${archivedCategory.version}"` } });

    const catalog = await transport.request<Category[]>('/groups/group-sv-adler/categories');
    expect(catalog.some((entry) => entry.id === category.id)).toBe(false);
  });

  it('removes an archived booked product while preserving its booking history', async () => {
    const transport = new DemoTransport();
    const booking = await transport.request<Booking>('/groups/group-sv-adler/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: 'product-water', productVersion: 1, expectedPeriodId: 'period-august', quantity: 1 }),
    });
    const archivedProduct = await transport.request<Product>('/groups/group-sv-adler/products/product-water', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
      body: JSON.stringify({ name: 'Mineral Water', pricingMode: 'FIXED', priceMinor: 150, active: false, sortOrder: 1, version: 1 }),
    });

    await transport.request<void>('/groups/group-sv-adler/products/product-water', {
      method: 'DELETE',
      headers: { 'If-Match': `"v${archivedProduct.version}"` },
    });

    const catalog = await transport.request<Category[]>('/groups/group-sv-adler/categories');
    const bookings = await transport.request<Booking[]>('/groups/group-sv-adler/bookings');
    expect(catalog.flatMap((category) => category.products).some((product) => product.id === 'product-water')).toBe(false);
    expect(bookings).toContainEqual(expect.objectContaining({ id: booking.id, productId: 'product-water', productName: booking.productName }));
  });
});

describe('DemoTransport public join links', () => {
  it('preserves lifetime edits and invalidates old tokens on rotation and disable', async () => {
    const transport = new DemoTransport();
    const created = await transport.request<PublicJoinLink>('/groups/group-sv-adler/public-join-link', jsonRequest('PUT', {
      enabled: true,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
    }));
    const firstToken = new URL(created.acceptUrl ?? '').hash.slice('#token='.length);
	await expect(transport.request<PublicJoinPreview>('/public-join-links/preview', jsonRequest('POST', { token: firstToken }))).resolves.toMatchObject({ groupName: 'SV Adler' });

    const unlimited = await transport.request<PublicJoinLink>('/groups/group-sv-adler/public-join-link', {
      ...jsonRequest('PUT', { enabled: true, expiresAt: null }),
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
    });
    expect(unlimited.acceptUrl).toBe(created.acceptUrl);
    const rotated = await transport.request<PublicJoinLink>('/groups/group-sv-adler/public-join-link/rotate', { method: 'POST', headers: { 'If-Match': '"v2"' } });
    const rotatedToken = new URL(rotated.acceptUrl ?? '').hash.slice('#token='.length);
    expect(rotatedToken).not.toBe(firstToken);
    await expect(transport.request('/public-join-links/preview', jsonRequest('POST', { token: firstToken }))).rejects.toThrow(/invalid or expired/i);

    const disabled = await transport.request<PublicJoinLink>('/groups/group-sv-adler/public-join-link', {
      ...jsonRequest('PUT', { enabled: false, expiresAt: null }),
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v3"' },
    });
    expect(disabled).toMatchObject({ enabled: false, expiresAt: null, version: 4 });
    expect(disabled.acceptUrl).toBeUndefined();
    await expect(transport.request('/public-join-links/preview', jsonRequest('POST', { token: rotatedToken }))).rejects.toThrow(/invalid or expired/i);
  });
});
