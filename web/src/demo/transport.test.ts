import { describe, expect, it } from 'vitest';
import type { AccountSummary, Booking, Category, CreatedInvitation, Dashboard, Group, GroupSettings, InvitationImportResult, InvitationMetadata, LedgerEntry, Membership, Payment, PermissionDefinition, Product, PublicJoinLink, PublicJoinPreview, Role, RoleAssignment, Session } from '@/api/types';
import i18n from '@/i18n';
import { DemoTransport } from './transport';

const jsonRequest = (method: string, body: unknown = {}): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
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
      expect.objectContaining({ email: 'new.member@example.test', roleIds: ['role-member'], emailDeliveryStatus: 'SENDING' }),
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

  it('preserves custom and custom-administrative roles during legacy invitation updates', async () => {
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

    expect(updated.roleIds).toEqual(expect.arrayContaining(['role-catalog', customRole.id, customAdminRole.id]));
    expect(updated.roleIds).not.toContain('role-member');
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

  it('creates, renames, and offers a claim invitation for a managed guest', async () => {
    const transport = new DemoTransport();
    const settings = await transport.request<GroupSettings>('/groups/group-sv-adler/guest-settings', jsonRequest('PUT', { guestsEnabled: true, createGuestRole: true }));
    expect(settings).toMatchObject({ guestsEnabled: true, defaultRoleId: settings.guestRoleId });

    const [booking] = await transport.request<Booking[]>('/groups/group-sv-adler/bookings/batch', jsonRequest('POST', {
      productId: 'product-water',
      productVersion: 1,
      expectedPeriodId: 'period-august',
      quantity: 1,
      targetMembershipIds: [],
      managedGuestDisplayNames: ['Guest One'],
      reason: 'Guest purchase',
    }));
    const members = await transport.request<Membership[]>('/groups/group-sv-adler/members');
    const guest = members.find((member) => member.id === booking.memberId);
    expect(guest).toMatchObject({ displayName: 'Guest One', email: null, isGuest: true, roleIds: [] });

    await expect(transport.request<Membership>(`/groups/group-sv-adler/members/${guest?.id}`, jsonRequest('PATCH', { displayName: 'Renamed Guest' }))).resolves.toMatchObject({ displayName: 'Renamed Guest' });
    await expect(transport.request<CreatedInvitation>(`/groups/group-sv-adler/members/${guest?.id}/claim-invitation`, jsonRequest('POST', { email: 'guest@example.test' }))).resolves.toMatchObject({ email: 'guest@example.test', targetMembershipId: guest?.id });
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
      ['/groups/group-sv-adler/members'],
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
  });

  it('allows a pure role manager to list invitations but not mutate their lifecycle', async () => {
    const transport = new DemoTransport();
    const role = await transport.request<Role>('/groups/group-sv-adler/roles', jsonRequest('POST', {
      name: 'Role manager',
      grants: [{ permission: 'ROLE_MANAGEMENT', scope: { type: 'GROUP' } }],
    }));
    await demoteCurrentAdministrator(transport, ['role-member', role.id]);

    await expect(transport.request<InvitationMetadata[]>('/groups/group-sv-adler/invitations')).resolves.toEqual([]);
    await expect(transport.request<Membership[]>('/groups/group-sv-adler/members')).rejects.toThrow(i18n.t('admin.noAccessMessage'));
    await expect(transport.request('/groups/group-sv-adler/invitations', jsonRequest('POST', {
      email: 'new@example.test',
      displayName: 'New Member',
      roleIds: ['role-member'],
    }))).rejects.toThrow(i18n.t('admin.noAccessMessage'));
  });

  it('allows group-only administrators to read roles and transfer only the reserved administrator assignment', async () => {
    const transport = new DemoTransport();
    const groupAdministrator = await transport.request<Role>('/groups/group-sv-adler/roles', jsonRequest('POST', {
      name: 'Group administration only',
      grants: [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }],
    }));
    await demoteCurrentAdministrator(transport, ['role-member', groupAdministrator.id]);

    await expect(transport.request<Role[]>('/groups/group-sv-adler/roles')).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'role-admin' })]));
    const assignments = await transport.request<RoleAssignment[]>('/groups/group-sv-adler/role-assignments');
    const mara = assignments.find((assignment) => assignment.subjectId === 'member-mara')!;
    const transferred = await transport.request<RoleAssignment>('/groups/group-sv-adler/members/member-mara/roles', {
      ...jsonRequest('PUT', { roleIds: [...mara.roleIds, 'role-admin'] }),
      headers: { 'Content-Type': 'application/json', 'If-Match': `"v${mara.version}"` },
    });

    expect(transferred.roleIds).toContain('role-admin');
    await expect(transport.request<RoleAssignment>('/groups/group-sv-adler/members/member-mara/roles', {
      ...jsonRequest('PUT', { roleIds: [...transferred.roleIds, 'role-catalog'] }),
      headers: { 'Content-Type': 'application/json', 'If-Match': `"v${transferred.version}"` },
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
    await expect(transport.request<GroupSettings>('/groups/group-sv-adler/settings')).resolves.toEqual({ notificationEmailsEnabled: false, notificationEmailDeliveryAvailable: true, defaultRoleId: 'role-member', guestsEnabled: false, guestRoleId: null });
    await expect(transport.request<GroupSettings>('/groups/group-sv-adler/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationEmailsEnabled: true }),
    })).resolves.toEqual({ notificationEmailsEnabled: true, notificationEmailDeliveryAvailable: true, defaultRoleId: 'role-member', guestsEnabled: false, guestRoleId: null });
    await expect(transport.request<GroupSettings>('/groups/group-sv-adler/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultRoleId: 'role-finance' }),
    })).resolves.toEqual({ notificationEmailsEnabled: true, notificationEmailDeliveryAvailable: true, defaultRoleId: 'role-finance', guestsEnabled: false, guestRoleId: null });
    await expect(transport.request<GroupSettings>('/groups/group-sv-adler/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultRoleId: 'role-admin' }),
    })).rejects.toThrow(/must not grant group administration/i);
    await expect(transport.request<GroupSettings>('/groups/group-sv-adler/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
      body: JSON.stringify({ membersCanViewAllBookings: true }),
    })).rejects.toThrow();
    await expect(transport.request<GroupSettings>('/groups/group-sv-adler/settings')).resolves.toEqual({ notificationEmailsEnabled: true, notificationEmailDeliveryAvailable: true, defaultRoleId: 'role-finance', guestsEnabled: false, guestRoleId: null });
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
  it('lists active and archived summaries and applies booking movements', async () => {
    const transport = new DemoTransport();
    const before = await transport.request<AccountSummary[]>('/groups/group-sv-adler/accounts');
    const lukasBefore = before.find((account) => account.membershipId === 'member-lukas');
    expect(before.some((account) => account.status === 'ARCHIVED')).toBe(true);

    await transport.request<Booking>('/groups/group-sv-adler/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: 'product-water', productVersion: 1, expectedPeriodId: 'period-august', quantity: 1 }),
    });
    const after = await transport.request<AccountSummary[]>('/groups/group-sv-adler/accounts');
    const lukasAfter = after.find((account) => account.membershipId === 'member-lukas');

    expect(BigInt(lukasAfter?.balance.minorUnits ?? '0') - BigInt(lukasBefore?.balance.minorUnits ?? '0')).toBe(100n);
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
    expect(after.openBalance.minorUnits).toBe('-660');
    expect(ledger[0]).toMatchObject({ kind: 'PAYMENT', referenceId: payment.id, balance: { minorUnits: '-660', currency: 'EUR' } });
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
    expect(uploaded.avatarUrl).toMatch(/^blob:/);
    expect(session.user.avatarUrl).toBe(uploaded.avatarUrl);
    expect(members.find((member) => member.userId === session.user.id)?.avatarUrl).toBe(uploaded.avatarUrl);

    await transport.request<void>('/me/avatar', { method: 'DELETE' });
    const removedSession = await transport.request<Session>('/session');
    const removedMembers = await transport.request<Membership[]>('/groups/group-sv-adler/members');
    expect(removedSession.user.avatarUrl).toBeUndefined();
    expect(removedMembers.find((member) => member.userId === session.user.id)?.avatarUrl).toBeUndefined();
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
