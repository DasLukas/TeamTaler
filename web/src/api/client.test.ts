import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Booking, BookingCommand, InvitationImportResult, InvitationMetadata, ProductCreateCommand, RoleInput, Session } from './types';
import { ApiError, api } from './client';

const command: BookingCommand = {
  productId: 'product-a',
  productVersion: 1,
  expectedPeriodId: 'period-a',
  quantity: 1,
};

const booking: Booking = {
  id: 'booking-a',
  memberId: 'member-a',
  memberName: 'Alex',
  memberStatus: 'ACTIVE',
  productId: 'product-a',
  productName: 'Water',
  categoryId: 'category-a',
  categoryName: 'Drinks',
  quantity: 1,
  unitPrice: { minorUnits: '100', currency: 'EUR' },
  total: { minorUnits: '100', currency: 'EUR' },
  bookedAt: '2026-08-04T12:00:00Z',
  bookedByName: 'Alex',
  bookedByStatus: 'ACTIVE',
  status: 'POSTED',
};

const importResult: InvitationImportResult = {
  summary: { totalRows: 1, created: 1, invalid: 0, skipped: 0 },
  rows: [{
    row: 2,
    email: 'new@example.test',
    displayName: 'New Member',
    invitationId: 'invitation-a',
    invitationStatus: 'CREATED',
    emailDeliveryStatus: 'PENDING',
  }],
};

function session(userId: string): Session {
  return {
    user: { id: userId, displayName: userId, email: `${userId}@example.test` },
    groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', defaultTheme: 'TEAMTALER', statisticsEnabled: false, membership: { id: `member-${userId}`, roles: ['MEMBER'], groupPermissions: [], themeOverride: null } }],
    activeGroupId: 'group-a',
    defaultGroupId: null,
    colorMode: 'SYSTEM',
    systemRoles: [],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function idempotencyKey(call: unknown[]): string | null {
  return new Headers((call[1] as RequestInit | undefined)?.headers).get('Idempotency-Key');
}

function requestBody(call: unknown[]): Record<string, unknown> {
  return JSON.parse(String((call[1] as RequestInit | undefined)?.body)) as Record<string, unknown>;
}

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsText(blob);
  });
}

describe('high-risk API idempotency', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('persists account color mode and a nullable group theme override through their stable endpoints', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ colorMode: 'DARK' }))
      .mockResolvedValueOnce(jsonResponse({ themeOverride: 'TIEF_IM_WESTEN' }))
      .mockResolvedValueOnce(jsonResponse({ themeOverride: null }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.updateAppearance('DARK')).resolves.toEqual({ colorMode: 'DARK' });
    await expect(api.updateThemePreference('group-a', 'TIEF_IM_WESTEN')).resolves.toEqual({ themeOverride: 'TIEF_IM_WESTEN' });
    await expect(api.updateThemePreference('group-a', null)).resolves.toEqual({ themeOverride: null });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/me/appearance');
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({ colorMode: 'DARK' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/groups/group-a/theme-preference');
    expect(requestBody(fetchMock.mock.calls[1])).toEqual({ themeOverride: 'TIEF_IM_WESTEN' });
    expect(requestBody(fetchMock.mock.calls[2])).toEqual({ themeOverride: null });
  });

  it('reuses the same key after a lost network response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(session('user-a')))
      .mockRejectedValueOnce(new TypeError('network lost'))
      .mockResolvedValueOnce(jsonResponse(booking));
    vi.stubGlobal('fetch', fetchMock);

    await api.getSession();
    await expect(api.createBooking('group-a', command)).rejects.toThrow('network lost');
    await expect(api.createBooking('group-a', command)).resolves.toEqual(booking);

    expect(idempotencyKey(fetchMock.mock.calls[1])).toBe(idempotencyKey(fetchMock.mock.calls[2]));
  });

  it.each([500, 408, 425, 429])('reuses the same key after transient HTTP %s', async (status) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(session('user-a')))
      .mockResolvedValueOnce(jsonResponse({ title: 'Transient failure', status }, status))
      .mockResolvedValueOnce(jsonResponse(booking));
    vi.stubGlobal('fetch', fetchMock);

    await api.getSession();
    await expect(api.createBooking('group-a', command)).rejects.toBeInstanceOf(ApiError);
    await api.createBooking('group-a', command);

    expect(idempotencyKey(fetchMock.mock.calls[1])).toBe(idempotencyKey(fetchMock.mock.calls[2]));
  });

  it('allocates a new key for a new successful intent with the same payload', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(session('user-a')))
      .mockResolvedValueOnce(jsonResponse(booking))
      .mockResolvedValueOnce(jsonResponse({ ...booking, id: 'booking-b' }));
    vi.stubGlobal('fetch', fetchMock);

    await api.getSession();
    await api.createBooking('group-a', command);
    await api.createBooking('group-a', command);

    expect(idempotencyKey(fetchMock.mock.calls[1])).not.toBe(idempotencyKey(fetchMock.mock.calls[2]));
  });

  it('isolates pending reservations by actor, group, and payload', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(session('user-a')))
      .mockRejectedValueOnce(new TypeError('lost-a'))
      .mockRejectedValueOnce(new TypeError('lost-group'))
      .mockRejectedValueOnce(new TypeError('lost-payload'))
      .mockResolvedValueOnce(jsonResponse(session('user-b')))
      .mockRejectedValueOnce(new TypeError('lost-actor'));
    vi.stubGlobal('fetch', fetchMock);

    await api.getSession();
    await expect(api.createBooking('group-a', command)).rejects.toThrow('lost-a');
    await expect(api.createBooking('group-b', command)).rejects.toThrow('lost-group');
    await expect(api.createBooking('group-a', { ...command, quantity: 2 })).rejects.toThrow('lost-payload');
    await api.getSession();
    await expect(api.createBooking('group-a', command)).rejects.toThrow('lost-actor');

    const keys = [1, 2, 3, 5].map((index) => idempotencyKey(fetchMock.mock.calls[index]));
    expect(new Set(keys)).toHaveLength(4);
  });

  it('clears pending reservations on logout', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(session('user-a')))
      .mockRejectedValueOnce(new TypeError('lost'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(session('user-a')))
      .mockRejectedValueOnce(new TypeError('lost again'));
    vi.stubGlobal('fetch', fetchMock);

    await api.getSession();
    await expect(api.createBooking('group-a', command)).rejects.toThrow('lost');
    const beforeLogout = idempotencyKey(fetchMock.mock.calls[1]);
    await api.logout();
    await api.getSession();
    await expect(api.createBooking('group-a', command)).rejects.toThrow('lost again');

    expect(idempotencyKey(fetchMock.mock.calls[4])).not.toBe(beforeLogout);
  });

  it('clears a reservation after a definitive client rejection', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(session('user-a')))
      .mockResolvedValueOnce(jsonResponse({ title: 'Invalid request', status: 400 }, 400))
      .mockResolvedValueOnce(jsonResponse(booking));
    vi.stubGlobal('fetch', fetchMock);

    await api.getSession();
    await expect(api.createBooking('group-a', command)).rejects.toBeInstanceOf(ApiError);
    await api.createBooking('group-a', command);

    expect(idempotencyKey(fetchMock.mock.calls[1])).not.toBe(idempotencyKey(fetchMock.mock.calls[2]));
  });

  it('sends product-create idempotency keys and renews them after success', async () => {
    const product = { id: 'product-a', categoryId: 'category-a', version: 1, name: 'Water', priceMinor: 100, pricingMode: 'FIXED', currency: 'EUR', active: true, sortOrder: 0 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(session('user-a')))
      .mockResolvedValueOnce(jsonResponse(product, 201))
      .mockResolvedValueOnce(jsonResponse({ ...product, id: 'product-b' }, 201));
    vi.stubGlobal('fetch', fetchMock);

    await api.getSession();
    const input = { categoryId: 'category-a', name: 'Water', pricingMode: 'FIXED', price: { minorUnits: '100', currency: 'EUR' } } satisfies ProductCreateCommand;
    await api.createProduct('group-a', input);
    await api.createProduct('group-a', input);

    expect(idempotencyKey(fetchMock.mock.calls[1])).toBeTruthy();
    expect(idempotencyKey(fetchMock.mock.calls[1])).not.toBe(idempotencyKey(fetchMock.mock.calls[2]));
    expect(requestBody(fetchMock.mock.calls[1])).toMatchObject({ pricingMode: 'FIXED', priceMinor: 100 });
  });

  it('sends the selected icon when creating a category', async () => {
    const category = { id: 'category-event', version: 1, name: 'Events', icon: 'event', active: true, sortOrder: 0, products: [] };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(category, 201));
    vi.stubGlobal('fetch', fetchMock);

    await api.createCategory('group-a', { name: 'Events', icon: 'event' });

    expect(requestBody(fetchMock.mock.calls[0])).toEqual({ name: 'Events', icon: 'event', sortOrder: 0 });
  });

  it('sends versioned category and product updates with strong preconditions', async () => {
    const category = { id: 'category-a', version: 4, name: 'Drinks', icon: 'drink' as const, active: false, sortOrder: 2, products: [] };
    const product = { id: 'product-a', categoryId: 'category-a', version: 8, name: 'Water', priceMinor: 125, pricingMode: 'FIXED', currency: 'EUR', active: true, sortOrder: 3 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(category))
      .mockResolvedValueOnce(jsonResponse(product));
    vi.stubGlobal('fetch', fetchMock);

    await api.updateCategory('group-a', category.id, { name: 'Drinks', icon: 'sport', active: false, sortOrder: 2, version: 3 });
    await api.updateProduct('group-a', product.id, { name: 'Water', pricingMode: 'FIXED', price: { minorUnits: '125', currency: 'EUR' }, active: true, sortOrder: 3, version: 7 });

    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('PATCH');
    expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get('If-Match')).toBe('"v3"');
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({ name: 'Drinks', icon: 'sport', active: false, sortOrder: 2, version: 3 });
    expect(new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers).get('If-Match')).toBe('"v7"');
    expect(requestBody(fetchMock.mock.calls[1])).toEqual({ name: 'Water', pricingMode: 'FIXED', priceMinor: 125, active: true, sortOrder: 3, version: 7 });
  });

  it('deletes archived catalog entries with their current version', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.deleteCategory('group-a', 'category-a', 4);
    await api.deleteProduct('group-a', 'product-a', 8);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/groups/group-a/categories/category-a');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
    expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get('If-Match')).toBe('"v4"');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/groups/group-a/products/product-a');
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('DELETE');
    expect(new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers).get('If-Match')).toBe('"v8"');
  });

  it('replaces the complete catalog order atomically', async () => {
    const categories = [
      { id: 'category-b', version: 2, name: 'Food', icon: 'food', active: true, sortOrder: 0, products: [] },
      { id: 'category-a', version: 2, name: 'Drinks', icon: 'drink', active: true, sortOrder: 1, products: [] },
    ];
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(categories));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.reorderCatalog('group-a', {
      categoryIds: ['category-b', 'category-a'],
      productIdsByCategory: { 'category-b': [], 'category-a': ['product-a'] },
    })).resolves.toEqual(categories);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/groups/group-a/catalog/order');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('PUT');
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({
      categoryIds: ['category-b', 'category-a'],
      productIdsByCategory: { 'category-b': [], 'category-a': ['product-a'] },
    });
  });

  it('serializes a user-chosen unit price as bounded integer minor units', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(session('user-a')))
      .mockResolvedValueOnce(jsonResponse({ ...booking, unitPriceMinor: '250', totalMinor: '500' }, 201));
    vi.stubGlobal('fetch', fetchMock);

    await api.getSession();
    await api.createBooking('group-a', { ...command, quantity: 2, unitPrice: { minorUnits: '250', currency: 'EUR' } });

    expect(requestBody(fetchMock.mock.calls[1])).toMatchObject({ quantity: 2, unitPriceMinor: 250 });
    expect(requestBody(fetchMock.mock.calls[1])).not.toHaveProperty('unitPrice');
  });

  it('creates one atomic batch intent for multiple target memberships', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(session('user-a')))
      .mockResolvedValueOnce(jsonResponse([
        { ...booking, id: 'booking-self', targetMembershipId: 'member-user-a' },
        { ...booking, id: 'booking-other', targetMembershipId: 'member-b' },
      ], 201));
    vi.stubGlobal('fetch', fetchMock);

    await api.getSession();
    await api.createBookings('group-a', {
      ...command,
      targetMembershipIds: ['member-user-a', 'member-b'],
      reason: 'Shared order',
    });

    const call = fetchMock.mock.calls[1];
    expect(call[0]).toBe('/api/v1/groups/group-a/bookings/batch');
    expect((call[1] as RequestInit).method).toBe('POST');
    expect(idempotencyKey(call)).toBeTruthy();
    expect(requestBody(call)).toEqual({
      ...command,
      targetMembershipIds: ['member-user-a', 'member-b'],
      reason: 'Shared order',
    });
  });

  it('serializes temporary guest names even when no existing membership is targeted', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(session('user-a')))
      .mockResolvedValueOnce(jsonResponse([{ ...booking, targetMembershipId: 'member-guest' }], 201));
    vi.stubGlobal('fetch', fetchMock);

    await api.getSession();
    await api.createBookings('group-a', {
      ...command,
      targetMembershipIds: [],
      temporaryGuestDisplayNames: ['Guest One'],
    });

    expect(requestBody(fetchMock.mock.calls[1])).toEqual({
      ...command,
      targetMembershipIds: [],
      temporaryGuestDisplayNames: ['Guest One'],
    });
  });

  it('serializes an ordered multi-product cart as one atomic bulk request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(session('user-a')))
      .mockResolvedValueOnce(jsonResponse([
        { ...booking, id: 'booking-water' },
        { ...booking, id: 'booking-donation', productId: 'product-donation', unitPriceMinor: '250', totalMinor: '500' },
      ], 201));
    vi.stubGlobal('fetch', fetchMock);

    await api.getSession();
    await api.createBulkBookings('group-a', {
      expectedPeriodId: 'period-a',
      items: [
        { productId: 'product-water', productVersion: 1, quantity: 1 },
        { productId: 'product-donation', productVersion: 3, quantity: 2, unitPrice: { minorUnits: '250', currency: 'EUR' } },
      ],
      targetMembershipIds: ['member-user-a', 'member-b'],
      reason: 'Shared order',
    });

    const call = fetchMock.mock.calls[1];
    expect(call[0]).toBe('/api/v1/groups/group-a/bookings/bulk');
    expect((call[1] as RequestInit).method).toBe('POST');
    expect(idempotencyKey(call)).toBeTruthy();
    expect(requestBody(call)).toEqual({
      expectedPeriodId: 'period-a',
      items: [
        { productId: 'product-water', productVersion: 1, quantity: 1 },
        { productId: 'product-donation', productVersion: 3, quantity: 2, unitPriceMinor: 250 },
      ],
      targetMembershipIds: ['member-user-a', 'member-b'],
      reason: 'Shared order',
    });
  });

  it('loads the minimal booking context without requesting the member directory', async () => {
    const context = {
      openPeriod: { id: 'period-a', label: 'August', status: 'OPEN', startsAt: '2026-08-01T00:00:00Z' },
      ownBalanceMinor: '1250',
      currentMembership: {
        id: 'member-a', userId: 'user-a', displayName: 'Alex', email: 'alex@example.test', initials: 'A', isTemporaryGuest: false,
        roles: ['MEMBER'], groupPermissions: [], categoryPermissions: [], active: true,
      },
      targets: [{ membershipId: 'member-a', displayName: 'Alex', isTemporaryGuest: false }, { membershipId: 'member-guest', displayName: 'Guest', isTemporaryGuest: true }],
      canBookForGuests: true,
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(context));
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.getBookingContext('group-a', 'EUR');

    expect(result.ownBalance).toEqual({ minorUnits: '1250', currency: 'EUR' });
    expect(result.targets[1]).toEqual({ membershipId: 'member-guest', displayName: 'Guest', isTemporaryGuest: true, avatarUrl: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/groups/group-a/booking-context');
  });

  it('renames and creates a claim invitation for a temporary guest', async () => {
    const guest = {
      id: 'member/guest', userId: 'user-guest', displayName: 'Renamed Guest', email: null, initials: 'RG', isTemporaryGuest: true,
      roles: ['MEMBER'], groupPermissions: [], categoryPermissions: [], active: true,
    };
    const invitation = {
      id: 'invitation-a', email: 'guest@example.test', displayName: 'Renamed Guest', roles: ['MEMBER'], groupPermissions: [], categoryPermissions: [],
      roleAssignmentsVersion: 1, expiresAt: '2026-08-11T12:00:00Z', emailDeliveryStatus: 'PENDING', targetMembershipId: 'member/guest', acceptUrl: 'https://example.test/invite',
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(guest)).mockResolvedValueOnce(jsonResponse(invitation));
    vi.stubGlobal('fetch', fetchMock);

    await api.renameMember('group-a', 'member/guest', 'Renamed Guest');
    const created = await api.createTemporaryGuestClaimInvitation('group-a', 'member/guest', 'guest@example.test', ['role-member']);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/groups/group-a/members/member%2Fguest');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('PATCH');
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({ displayName: 'Renamed Guest' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/groups/group-a/members/member%2Fguest/claim-invitation');
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('POST');
    expect(requestBody(fetchMock.mock.calls[1])).toEqual({ email: 'guest@example.test', roleIds: ['role-member'] });
    expect(created).toMatchObject({ targetMembershipId: 'member/guest', acceptUrl: 'https://example.test/invite' });
  });

  it('reactivates and permanently deletes memberships through explicit lifecycle endpoints', async () => {
    const restored = {
      id: 'member/former', userId: 'user-former', displayName: 'Former Member', email: 'former@example.test', initials: 'FM',
      isTemporaryGuest: false, status: 'ACTIVE', roles: ['MEMBER'], roleIds: ['role-member'], groupPermissions: [], categoryPermissions: [], active: true,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(restored))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.reactivateMember('group-a', 'member/former', { roleIds: ['role-member'] })).resolves.toMatchObject({ id: 'member/former', status: 'ACTIVE' });
    await api.permanentlyDeleteMember('group-a', 'member/former');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/groups/group-a/members/member%2Fformer/reactivate');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({ roleIds: ['role-member'] });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/groups/group-a/members/member%2Fformer/permanent');
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('DELETE');
  });

  it('uses display-name snapshots from bookings without fetching members', async () => {
    const wireBooking = {
      id: 'booking-a', targetMembershipId: 'member-target', targetDisplayName: 'Target Guest', actorMembershipId: 'member-actor', actorDisplayName: 'Booking Member',
      targetAvatarUrl: '/api/v1/users/target/avatar/target.png', actorAvatarUrl: '/api/v1/users/actor/avatar/actor.png',
      productId: 'product-a', productName: 'Water', categoryId: 'category-a', categoryName: 'Drinks', quantity: 1, unitPriceMinor: 100, totalMinor: 100,
      currency: 'EUR', createdAt: '2026-08-04T12:00:00Z', status: 'POSTED',
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([wireBooking]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.getBookings('group-a');

    expect(result[0]).toMatchObject({
      memberName: 'Target Guest',
      memberAvatarUrl: '/api/v1/users/target/avatar/target.png',
      bookedByName: 'Booking Member',
      bookedByAvatarUrl: '/api/v1/users/actor/avatar/actor.png',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/groups/group-a/bookings');
  });

  it('records an own payment without exposing a target membership identifier', async () => {
    const payment = {
      id: 'payment-self',
      membershipId: 'member-user-a',
      memberName: 'user-a',
      amountMinor: 2450,
      currency: 'EUR',
      receivedAt: '2026-08-06T00:00:00Z',
      method: 'PAYPAL',
      reference: 'August transfer',
      status: 'POSTED',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(session('user-a')))
      .mockResolvedValueOnce(jsonResponse(payment, 201));
    vi.stubGlobal('fetch', fetchMock);

    await api.getSession();
    await api.createOwnPayment('group-a', {
      amount: { minorUnits: '2450', currency: 'EUR' },
      receivedAt: '2026-08-06',
      method: 'PAYPAL',
      reference: 'August transfer',
    });

    const call = fetchMock.mock.calls[1];
    expect(call[0]).toBe('/api/v1/groups/group-a/payments/self');
    expect((call[1] as RequestInit).method).toBe('POST');
    expect(idempotencyKey(call)).toBeTruthy();
    expect(requestBody(call)).toEqual({
      amountMinor: 2450,
      receivedAt: '2026-08-06T00:00:00.000Z',
      method: 'PAYPAL',
      reference: 'August transfer',
    });
    expect(requestBody(call)).not.toHaveProperty('membershipId');
  });

  it('uploads a payment receipt as multipart and fingerprints its content for retries', async () => {
    const payment = {
      id: 'payment-receipt', membershipId: 'member-user-a', memberName: 'user-a', amountMinor: 2450, currency: 'EUR',
      receivedAt: '2026-08-06T00:00:00Z', method: 'OTHER', status: 'POSTED',
      attachment: { fileName: 'receipt.pdf', mediaType: 'application/pdf', sizeBytes: 7, url: '/api/v1/groups/group-a/payments/payment-receipt/attachment' },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(session('user-a')))
      .mockRejectedValueOnce(new TypeError('network lost'))
      .mockResolvedValueOnce(jsonResponse(payment, 201));
    vi.stubGlobal('fetch', fetchMock);

    await api.getSession();
    const command = { amount: { minorUnits: '2450', currency: 'EUR' }, receivedAt: '2026-08-06', method: 'OTHER' };
    await expect(api.createOwnPayment('group-a', command, new File(['receipt'], 'receipt.pdf', { type: 'application/pdf' }))).rejects.toThrow('network lost');
    await api.createOwnPayment('group-a', command, new File(['receipt'], 'renamed.pdf', { type: 'application/pdf' }));

    const firstRequest = fetchMock.mock.calls[1];
    const retryRequest = fetchMock.mock.calls[2];
    expect(idempotencyKey(firstRequest)).toBe(idempotencyKey(retryRequest));
    const body = (retryRequest[1] as RequestInit).body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get('attachment')).toBeInstanceOf(File);
    expect((form.get('attachment') as File).name).toBe('renamed.pdf');
    expect(JSON.parse(await blobText(form.get('command') as Blob))).toEqual({ amountMinor: 2450, receivedAt: '2026-08-06T00:00:00.000Z', method: 'OTHER' });
  });

  it('downloads a protected payment receipt as a blob', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('image', { headers: { 'Content-Type': 'image/jpeg' } }));
    vi.stubGlobal('fetch', fetchMock);

    const downloaded = await api.getPaymentAttachment('group-a', 'payment-a');
    expect(downloaded.size).toBe(5);
    expect(downloaded.type).toBe('image/jpeg');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/groups/group-a/payments/payment-a/attachment');
    expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get('Accept')).toContain('application/pdf');
  });

  it('sends raw CSV with its explicit media type and reuses the key after a network failure', async () => {
    const csv = 'email,display_name\nnew@example.test,New Member\n';
    const file = new File([csv], 'members.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'arrayBuffer', { value: vi.fn().mockResolvedValue(new TextEncoder().encode(csv).buffer) });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(session('user-a')))
      .mockRejectedValueOnce(new TypeError('network lost'))
      .mockResolvedValueOnce(jsonResponse(importResult));
    vi.stubGlobal('fetch', fetchMock);

    await api.getSession();
    await expect(api.importInvitations('group-a', file, ['role-member'])).rejects.toThrow('network lost');
    await expect(api.importInvitations('group-a', file, ['role-member'])).resolves.toEqual(importResult);

    const firstInit = fetchMock.mock.calls[1][1] as RequestInit;
    const secondInit = fetchMock.mock.calls[2][1] as RequestInit;
    expect(firstInit.body).toBe(csv);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/groups/group-a/invitations/import?roleId=role-member');
    expect(new Headers(firstInit.headers).get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(idempotencyKey(fetchMock.mock.calls[1])).toBe(idempotencyKey(fetchMock.mock.calls[2]));
    expect(secondInit.body).toBe(csv);
  });

  it('omits the deprecated shared role query when CSV rows use names or the group default', async () => {
    const csv = 'email,roles\nnew@example.test,Finance manager\n';
    const file = new File([csv], 'members.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'arrayBuffer', { value: vi.fn().mockResolvedValue(new TextEncoder().encode(csv).buffer) });
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(importResult));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.importInvitations('group-a', file)).resolves.toEqual(importResult);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/groups/group-a/invitations/import');
  });

  it('rejects malformed UTF-8 CSV bytes before creating an invitation request', async () => {
    const invalidBytes = Uint8Array.from([0x65, 0x6d, 0x61, 0x69, 0x6c, 0x0a, 0xff]);
    const file = new File([invalidBytes], 'members.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'arrayBuffer', { value: vi.fn().mockResolvedValue(invalidBytes.buffer) });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.importInvitations('group-a', file, ['role-member'])).rejects.toThrow('UTF-8');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads non-secret invitation delivery metadata', async () => {
    const invitations: InvitationMetadata[] = [{
      id: 'invitation-a',
      email: 'new@example.test',
      displayName: 'New Member',
      roles: ['MEMBER'],
      groupPermissions: [],
      categoryPermissions: [],
      roleAssignmentsVersion: 4,
      expiresAt: '2026-08-11T12:00:00Z',
      emailDeliveryStatus: 'SENT',
      emailSentAt: '2026-08-04T12:01:00Z',
    }];
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(invitations));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getInvitations('group-a')).resolves.toEqual(invitations);

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/groups/group-a/invitations', expect.objectContaining({ credentials: 'include' }));
  });

  it('uses the assignment version and excludes legacy fields for role-based invitation updates', async () => {
    const response = {
      id: 'invitation-a',
      email: 'new@example.test',
      displayName: 'Updated Member',
      roles: ['MEMBER'],
      roleIds: ['role-member', 'role-finance'],
      roleAssignmentsVersion: 5,
      groupPermissions: [],
      categoryPermissions: [],
      expiresAt: '2026-08-11T12:00:00Z',
      emailDeliveryStatus: 'SENT',
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.updateInvitation('group-a', 'invitation/a', {
      displayName: 'Updated Member',
      roleIds: ['role-member', 'role-finance'],
      roleAssignmentsVersion: 4,
    })).resolves.toEqual(response);

    const request = fetchMock.mock.calls[0];
    expect(request[0]).toBe('/api/v1/groups/group-a/invitations/invitation%2Fa');
    expect(new Headers((request[1] as RequestInit).headers).get('If-Match')).toBe('"v4"');
    expect(requestBody(request)).toEqual({ displayName: 'Updated Member', roleIds: ['role-member', 'role-finance'] });
  });

  it('uses the assignment version for legacy invitation updates without serializing it', async () => {
    const response = {
      id: 'invitation-a',
      email: 'legacy@example.test',
      displayName: 'Legacy Member',
      roles: ['FINANCE_MANAGER', 'MEMBER'],
      roleIds: ['role-member', 'role-finance'],
      roleAssignmentsVersion: 8,
      groupPermissions: ['SELF_RECORD_PAYMENT'],
      categoryPermissions: [],
      expiresAt: '2026-08-11T12:00:00Z',
      emailDeliveryStatus: 'SENT',
      emailSentAt: undefined,
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.updateInvitation('group-a', 'invitation-a', {
      displayName: 'Legacy Member',
      roleAssignmentsVersion: 7,
      roles: ['MEMBER', 'FINANCE_MANAGER'],
      groupPermissions: ['SELF_RECORD_PAYMENT'],
      categoryPermissions: [],
    })).resolves.toEqual(response);

    const request = fetchMock.mock.calls[0];
    expect(new Headers((request[1] as RequestInit).headers).get('If-Match')).toBe('"v7"');
    expect(requestBody(request)).toEqual({
      displayName: 'Legacy Member',
      roles: ['FINANCE_MANAGER'],
      groupPermissions: ['SELF_RECORD_PAYMENT'],
      categoryGrants: {},
    });
  });

  it('retries invitation email delivery as an idempotent bodyless request', async () => {
    const retryResult = { invitationId: 'invitation-a', emailDeliveryStatus: 'PENDING' as const };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(session('user-a')))
      .mockResolvedValueOnce(jsonResponse(retryResult));
    vi.stubGlobal('fetch', fetchMock);

    await api.getSession();
    await expect(api.retryInvitationEmail('group-a', 'invitation-a')).resolves.toEqual(retryResult);

    const retryCall = fetchMock.mock.calls[1];
    const retryInit = retryCall[1] as RequestInit;
    expect(retryCall[0]).toBe('/api/v1/groups/group-a/invitations/invitation-a/email/retry');
    expect(retryInit.method).toBe('POST');
    expect(retryInit.body).toBeUndefined();
    expect(idempotencyKey(retryCall)).toBeTruthy();
  });

  it('uploads and removes a group logo through the group branding resource', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ logoUrl: '/api/v1/groups/group-a/images/logo.png' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const logo = new File(['logo'], 'club.png', { type: 'image/png' });

    await expect(api.uploadGroupLogo('group-a', logo)).resolves.toEqual({ logoUrl: '/api/v1/groups/group-a/images/logo.png' });
    await api.removeGroupLogo('group-a');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/groups/group-a/logo');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: expect.any(FormData) });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/groups/group-a/logo');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'DELETE' });
  });

  it('updates the group name through the group settings resource', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ name: 'Renamed Group' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.updateGroupName('group-a', 'Renamed Group')).resolves.toEqual({ name: 'Renamed Group' });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/groups/group-a');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PATCH' });
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({ name: 'Renamed Group' });
  });

  it('reads and updates typed group behavior settings', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ settlementsEnabled: false, notificationEmailsEnabled: false, notificationEmailDeliveryAvailable: true, defaultRoleId: 'role-member' }))
      .mockResolvedValueOnce(jsonResponse({ settlementsEnabled: false, notificationEmailsEnabled: true, notificationEmailDeliveryAvailable: true, defaultRoleId: 'role-member' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getGroupSettings('group-a')).resolves.toMatchObject({
      settlementsEnabled: false,
      notificationEmailsEnabled: false,
      notificationEmailDeliveryAvailable: true,
      defaultRoleId: 'role-member',
      paymentMethods: [
        { id: 'BANK_TRANSFER', label: 'Überweisung', attachmentMode: 'OFF' },
        { id: 'SHOPPING', label: 'Einkauf', attachmentMode: 'REQUIRED' },
        { id: 'CASH', label: 'Bar', attachmentMode: 'OFF' },
        { id: 'PAYPAL', label: 'PayPal', attachmentMode: 'OFF' },
        { id: 'OTHER', label: 'Sonstige', attachmentMode: 'OPTIONAL' },
      ],
    });
    await expect(api.updateGroupSettings('group-a', { notificationEmailsEnabled: true })).resolves.toMatchObject({
      settlementsEnabled: false,
      notificationEmailsEnabled: true,
      notificationEmailDeliveryAvailable: true,
      defaultRoleId: 'role-member',
      paymentMethods: expect.any(Array),
    });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/groups/group-a/settings');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/groups/group-a/settings');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'PATCH' });
    expect(new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers).get('If-Match')).toBeNull();
    expect(requestBody(fetchMock.mock.calls[1])).toEqual({ notificationEmailsEnabled: true });
  });

  it('always sends the assignment version for legacy member-permission updates', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.updatePermissions('group-a', 'member-a', {
      roles: ['MEMBER', 'FINANCE_MANAGER'],
      groupPermissions: ['SELF_RECORD_PAYMENT'],
      categoryPermissions: [],
    }, 6);

    const request = fetchMock.mock.calls[0];
    expect(request[0]).toBe('/api/v1/groups/group-a/members/member-a/permissions');
    expect(new Headers((request[1] as RequestInit).headers).get('If-Match')).toBe('"v6"');
    expect(requestBody(request)).toEqual({
      roles: ['FINANCE_MANAGER'],
      groupPermissions: ['SELF_RECORD_PAYMENT'],
      categoryGrants: {},
    });
  });

  it('opens the successor accounting period with the localized default label', async () => {
    const closedPeriod = { id: 'period-a', label: 'August 2026', status: 'CLOSED', startsAt: '2026-08-01T00:00:00Z', closedAt: '2026-09-01T00:00:00Z', dueAt: '2026-09-14' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(session('user-a')))
      .mockResolvedValueOnce(jsonResponse({ closedPeriod }));
    vi.stubGlobal('fetch', fetchMock);

    await api.getSession();
    await api.closePeriod('group-a', 'period-a', { label: 'August 2026', dueAt: '2026-09-14' });

    expect(requestBody(fetchMock.mock.calls[1])).toMatchObject({
      label: 'August 2026',
      dueAt: '2026-09-14',
      nextPeriodLabel: 'Aktueller Zeitraum',
    });
  });
});

describe('account security API contract', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('accepts an empty password-reset request response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.requestPasswordReset('alex@example.test')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/password-reset/request');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({ email: 'alex@example.test' });
  });

  it('uses the exact reset and email confirmation payloads', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.confirmPasswordReset('reset-token', 'new-passphrase');
    await api.confirmEmailChange('email-token');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/password-reset/confirm');
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({ token: 'reset-token', newPassword: 'new-passphrase' });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/auth/email-change/confirm');
    expect(requestBody(fetchMock.mock.calls[1])).toEqual({ token: 'email-token' });
  });

  it('updates profile, password, and email using their dedicated methods', async () => {
    const user = { id: 'user-a', displayName: 'Alex Changed', email: 'alex@example.test' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(user))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ verificationRequired: true }, 202));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.updateProfile('Alex Changed')).resolves.toEqual(user);
    await api.changePassword('current-passphrase', 'new-passphrase');
    await expect(api.requestEmailChange('new@example.test', 'current-passphrase')).resolves.toEqual({ verificationRequired: true });

    expect(fetchMock.mock.calls.map((call) => [(call[1] as RequestInit).method, call[0]])).toEqual([
      ['PATCH', '/api/v1/me/profile'],
      ['PUT', '/api/v1/me/password'],
      ['POST', '/api/v1/me/email-change'],
    ]);
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({ displayName: 'Alex Changed' });
    expect(requestBody(fetchMock.mock.calls[1])).toEqual({ currentPassword: 'current-passphrase', newPassword: 'new-passphrase' });
    expect(requestBody(fetchMock.mock.calls[2])).toEqual({ newEmail: 'new@example.test', currentPassword: 'current-passphrase' });
  });

  it('loads account capabilities without authentication state', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ passwordResetAvailable: true, emailChangeAvailable: false }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getAuthenticationCapabilities()).resolves.toEqual({ passwordResetAvailable: true, emailChangeAvailable: false });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/capabilities');
  });
});

describe('finance account summaries', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('loads the group-scoped endpoint and preserves exact balance strings', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{
      membershipId: 'member-large',
      displayName: 'Large Balance',
      status: 'ACTIVE',
      currency: 'EUR',
      balanceMinor: '9007199254740993123',
    }]));
    vi.stubGlobal('fetch', fetchMock);

    const summaries = await api.getAccountSummaries('group with spaces');

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/groups/group%20with%20spaces/accounts', expect.any(Object));
    expect(summaries[0]?.balance.minorUnits).toBe('9007199254740993123');
  });
});

describe('profile-image API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uploads multipart image data and removes the persisted avatar', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ avatarUrl: '/api/v1/users/user-a/avatar/hash.png' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const image = new File(['avatar'], 'avatar.png', { type: 'image/png' });

    await expect(api.uploadProfileAvatar(image)).resolves.toEqual({ avatarUrl: '/api/v1/users/user-a/avatar/hash.png' });
    await api.removeProfileAvatar();

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/me/avatar');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBeInstanceOf(FormData);
    expect(((fetchMock.mock.calls[0][1] as RequestInit).body as FormData).get('image')).toBe(image);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/me/avatar');
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('DELETE');
  });
});

describe('dynamic role API', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('loads the stable permission registry and group-owned roles', async () => {
    const role = {
      id: 'role-finance',
      groupId: 'group-a',
      name: 'Finance',
      nameLocked: false,
      deletable: true,
      grants: [{ permission: 'FINANCE_MANAGEMENT', scope: { type: 'GROUP' } }],
      version: 2,
      memberCount: 1,
      pendingInvitationCount: 0,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ key: 'VOID_ANY_BOOKING', implies: ['VOID_OWN_BOOKING', 'VIEW_ALL_BOOKING_ACTIVITY'] }]))
      .mockResolvedValueOnce(jsonResponse([role]))
      .mockResolvedValueOnce(jsonResponse(role));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getPermissionDefinitions()).resolves.toEqual([expect.objectContaining({
      key: 'VOID_ANY_BOOKING',
      impliedPermissions: ['VOID_OWN_BOOKING', 'VIEW_ALL_BOOKING_ACTIVITY'],
    })]);
    await expect(api.getRoles('group-a')).resolves.toEqual([expect.objectContaining({ id: role.id, groupId: 'group-a', deletable: true })]);
    await expect(api.getRole('group-a', role.id)).resolves.toEqual(expect.objectContaining({ id: role.id, version: 2 }));

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/v1/permission-definitions',
      '/api/v1/groups/group-a/roles',
      '/api/v1/groups/group-a/roles/role-finance',
    ]);
  });

  it('uses strong role versions for updates and deletions', async () => {
    const role = {
      id: 'role-custom',
      groupId: 'group-a',
      name: 'Booking desk',
      nameLocked: false,
      deletable: true,
      grants: [{ permission: 'BOOK_FOR_OTHERS', scope: { type: 'GROUP' } }],
      version: 4,
      memberCount: 0,
      pendingInvitationCount: 0,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(role))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const update: RoleInput = { name: role.name, grants: [{ permission: 'BOOK_FOR_OTHERS', scope: { type: 'GROUP' } }] };
    await api.updateRole('group-a', role.id, update, 3);
    await api.deleteRole('group-a', role.id, 4);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/groups/group-a/roles/role-custom');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT' });
    expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get('If-Match')).toBe('"v3"');
    expect(requestBody(fetchMock.mock.calls[0])).toEqual(update);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'DELETE' });
    expect(new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers).get('If-Match')).toBe('"v4"');
  });

  it('replaces complete member and invitation role sets with assignment ETags', async () => {
    const memberAssignment = { subjectType: 'MEMBERSHIP', subjectId: 'member/a', roleIds: ['role-member', 'role-finance'], version: 8 };
    const invitationAssignment = { subjectType: 'INVITATION', subjectId: 'invitation/a', roleIds: ['role-member'], version: 3 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([memberAssignment, invitationAssignment]))
      .mockResolvedValueOnce(jsonResponse(memberAssignment))
      .mockResolvedValueOnce(jsonResponse(invitationAssignment));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getRoleAssignments('group-a')).resolves.toEqual([memberAssignment, invitationAssignment]);
    await expect(api.updateMemberRoles('group-a', 'member/a', memberAssignment.roleIds, 7)).resolves.toEqual(memberAssignment);
    await expect(api.updateInvitationRoles('group-a', 'invitation/a', invitationAssignment.roleIds, 2)).resolves.toEqual(invitationAssignment);

    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/groups/group-a/members/member%2Fa/roles');
    expect(new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers).get('If-Match')).toBe('"v7"');
    expect(requestBody(fetchMock.mock.calls[1])).toEqual({ roleIds: memberAssignment.roleIds });
    expect(fetchMock.mock.calls[2][0]).toBe('/api/v1/groups/group-a/invitations/invitation%2Fa/roles');
    expect(new Headers((fetchMock.mock.calls[2][1] as RequestInit).headers).get('If-Match')).toBe('"v2"');
  });
});

describe('public join-link API', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('keeps public tokens in JSON bodies and applies administrator ETags', async () => {
    const disabledLink = { enabled: false, expired: false, expiresAt: null, version: 0, emailVerificationAvailable: true };
    const activeLink = { ...disabledLink, enabled: true, expiresAt: '2026-08-09T12:00:00Z', acceptUrl: 'https://teamtaler.example/join#token=secret', version: 1 };
    const rotatedLink = { ...activeLink, acceptUrl: 'https://teamtaler.example/join#token=rotated', version: 2 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ groupName: 'Group A', expiresAt: activeLink.expiresAt }))
      .mockResolvedValueOnce(jsonResponse(disabledLink))
      .mockResolvedValueOnce(jsonResponse(activeLink))
      .mockResolvedValueOnce(jsonResponse(rotatedLink));
    vi.stubGlobal('fetch', fetchMock);

    await api.previewPublicJoinLink('join secret');
    await api.getPublicJoinLink('group-a');
    await api.updatePublicJoinLink('group-a', { enabled: true, expiresAt: activeLink.expiresAt }, 0);
    await api.rotatePublicJoinLink('group-a', 1);

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/v1/public-join-links/preview',
      '/api/v1/groups/group-a/public-join-link',
      '/api/v1/groups/group-a/public-join-link',
      '/api/v1/groups/group-a/public-join-link/rotate',
    ]);
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({ token: 'join secret' });
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('join secret');
    expect(new Headers((fetchMock.mock.calls[2][1] as RequestInit).headers).get('If-Match')).toBeNull();
    expect(new Headers((fetchMock.mock.calls[3][1] as RequestInit).headers).get('If-Match')).toBe('"v1"');
  });

  it('uses generic registration, resend, and one-time confirmation commands', async () => {
    const joinedSession = session('joined-user');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ verificationRequired: true }, 202))
      .mockResolvedValueOnce(jsonResponse({ verificationRequired: true }, 202))
      .mockResolvedValueOnce(jsonResponse(joinedSession, 201));
    vi.stubGlobal('fetch', fetchMock);

    await api.startPublicJoinRegistration({ joinToken: 'join-token', email: 'new@example.test', displayName: 'New Member', password: 'new-password-long' });
    await api.resendPublicJoinVerification('join-token', 'new@example.test');
    await expect(api.confirmPublicJoinRegistration('verification-token')).resolves.toMatchObject({ user: { id: 'joined-user' } });

    expect(requestBody(fetchMock.mock.calls[0])).toEqual({ joinToken: 'join-token', email: 'new@example.test', displayName: 'New Member', password: 'new-password-long' });
    expect(requestBody(fetchMock.mock.calls[1])).toEqual({ joinToken: 'join-token', email: 'new@example.test' });
    expect(requestBody(fetchMock.mock.calls[2])).toEqual({ token: 'verification-token' });
  });
});

describe('system-administration API contract', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('resets a settings section with core keys and a strong settings revision', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ revision: 8 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.resetSystemSettings(['instanceName', 'mediaUploadMaxBytes'], 7);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/system/settings/reset');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get('If-Match')).toBe('"v7"');
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({ keys: ['instance.name', 'media.upload_max_bytes'] });
  });

  it('uses the TLS-only SMTP PUT and keeps a successful test revision', async () => {
    const smtp = { enabled: false, host: 'smtp.example.test', port: 587, tlsMode: 'starttls' as const, username: 'mailer', fromAddress: 'mail@example.test', fromName: 'TeamTaler' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ revision: 4, smtp: { revision: 2 } }))
      .mockResolvedValueOnce(jsonResponse({ revision: 5, smtp: { revision: 2, testedRevision: 2, requiresTest: false, configurationValid: true } }));
    vi.stubGlobal('fetch', fetchMock);

    await api.updateSystemSmtp(smtp, 3);
    await expect(api.testSystemSmtp(4)).resolves.toMatchObject({ revision: 5, smtp: { testedRevision: 2 } });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/system/settings/smtp');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT' });
    expect(requestBody(fetchMock.mock.calls[0])).toEqual(smtp);
    expect(new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers).get('If-Match')).toBe('"v4"');
  });

  it('confirms VAPID rotation and targets the current browser for a test push', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ revision: 8, webPush: { revision: 2, vapidPrivateKey: { configured: true, source: 'DATABASE' } } }))
      .mockResolvedValueOnce(jsonResponse({ revision: 8, webPush: { revision: 2, active: true } }));
    vi.stubGlobal('fetch', fetchMock);

    await api.generateSystemWebPushKey(7);
    await api.testSystemWebPush(8, 'device-a');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/system/settings/web-push/generate-key');
    expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get('If-Match')).toBe('"v7"');
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({ confirmRotation: true });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/system/settings/web-push/test');
    expect(requestBody(fetchMock.mock.calls[1])).toEqual({ subscriptionId: 'device-a' });
  });

  it('posts the exact group-name confirmation to the purge endpoint', async () => {
    const impact = { groupId: 'group/a', groupName: 'Group A', currency: 'EUR', version: 6, memberCount: 2, openBalanceMinor: '1234', invitationCount: 1, bookingCount: 4, financialRecordCount: 3, auditEventCount: 5, mediaCount: 1 };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(impact));
    vi.stubGlobal('fetch', fetchMock);

    await api.purgeSystemGroup('group/a', 6, { groupName: 'Group A' });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/system/groups/group%2Fa/purge');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get('If-Match')).toBe('"v6"');
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({ groupName: 'Group A' });
  });

  it('returns the immediate manual link when a system group provisions a new administrator', async () => {
    const group = { id: 'group/pending', name: 'Group Pending', currency: 'EUR', status: 'PROVISIONING', version: 1, administratorEmail: 'new@example.test' };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ group, acceptUrl: 'https://teamtaler.example/invite#token=manual', emailDeliveryStatus: 'NOT_REQUESTED', expiresAt: '2026-08-23T12:00:00Z' }, 201));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.createSystemGroup({ name: 'Group Pending', currency: 'EUR', administratorEmail: 'new@example.test' })).resolves.toMatchObject({
      group: { id: 'group/pending', status: 'PROVISIONING' },
      acceptUrl: 'https://teamtaler.example/invite#token=manual',
      emailDeliveryStatus: 'NOT_REQUESTED',
      expiresAt: '2026-08-23T12:00:00Z',
    });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/system/groups');
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({ name: 'Group Pending', currency: 'EUR', initialAdministratorEmail: 'new@example.test' });
  });

  it('renews a provisioning invitation through the versioned group endpoint', async () => {
    const group = { id: 'group/pending', name: 'Group Pending', currency: 'EUR', status: 'PROVISIONING', version: 3 };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ group, acceptUrl: 'https://teamtaler.example/invite#token=replaced', emailDeliveryStatus: 'PENDING', expiresAt: '2026-08-23T12:00:00Z' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.resendSystemGroupInvitation('group/pending', 2)).resolves.toMatchObject({
      group: { id: 'group/pending', status: 'PROVISIONING', version: 3 },
      acceptUrl: 'https://teamtaler.example/invite#token=replaced',
      emailDeliveryStatus: 'PENDING',
      expiresAt: '2026-08-23T12:00:00Z',
    });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/system/groups/group%2Fpending/invitation/resend');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get('If-Match')).toBe('"v2"');
  });
});

describe('notification preference and push-device API contract', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('uses strong versions and omits unavailable unchanged preference channels', async () => {
    const response = {
      version: 3,
      availableChannels: ['PUSH'],
      events: [{ type: 'BOOKING_ASSIGNED', enabled: true, email: true, push: true, emailAvailable: false, pushAvailable: true, supportedChannels: ['EMAIL', 'PUSH'] }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ version: 2, timezone: 'Europe/Berlin', dueSoonLeadDays: 3, overdueRepeatDays: 7, availableChannels: ['EMAIL'], events: [] }))
      .mockResolvedValueOnce(jsonResponse(response));
    vi.stubGlobal('fetch', fetchMock);

    await api.updateGroupNotificationSettings('group/a', { version: 1, timezone: 'Europe/Berlin', dueSoonLeadDays: 3, overdueRepeatDays: 7, events: [{ eventType: 'BOOKING_ASSIGNED', enabled: true }] });
    await api.updateNotificationPreferences('group/a', { version: 2, events: [{ eventType: 'BOOKING_ASSIGNED', push: true }] });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/groups/group%2Fa/notification-settings');
    expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get('If-Match')).toBe('"v1"');
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({ timezone: 'Europe/Berlin', dueSoonLeadDays: 3, overdueRepeatDays: 7, events: [{ type: 'BOOKING_ASSIGNED', enabled: true }] });
    expect(requestBody(fetchMock.mock.calls[1])).toEqual({ events: [{ type: 'BOOKING_ASSIGNED', push: true }] });
  });

  it('registers browser key material while exposing only redacted device metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: 'device-a', deviceLabel: 'Safari on iPhone', keyId: 'key-a', createdAt: '2026-08-20T10:00:00Z', lastUsedAt: '2026-08-20T10:00:00Z', current: true }, 201));
    vi.stubGlobal('fetch', fetchMock);

    const device = await api.registerPushSubscription({
      label: 'Safari on iPhone', keyId: 'key-a',
      subscription: { endpoint: 'https://push.example.test/subscription', expirationTime: null, keys: { auth: 'auth-key', p256dh: 'p256dh-key' } },
    });

    expect(device).toEqual({ id: 'device-a', label: 'Safari on iPhone', keyId: 'key-a', createdAt: '2026-08-20T10:00:00Z', lastUsedAt: '2026-08-20T10:00:00Z', current: true });
    expect(requestBody(fetchMock.mock.calls[0])).toMatchObject({ label: 'Safari on iPhone', keyId: 'key-a', subscription: { keys: { auth: 'auth-key', p256dh: 'p256dh-key' } } });
  });

  it('resolves an encoded opaque notification through the account-scoped endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ groupId: 'group-b' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getNotificationDestination('ntf/a')).resolves.toEqual({ groupId: 'group-b' });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/me/notifications/ntf%2Fa/destination');
  });
});

describe('server-backed collection API contract', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('encodes activity filters and exposes cursor response metadata', async () => {
    const response = new Response(JSON.stringify([booking]), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Next-Cursor': 'opaque-next-page',
        'X-Has-More': 'true',
        'X-Page-Limit': '25',
      },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(response);
    vi.stubGlobal('fetch', fetchMock);

    const page = await api.getBookingsPage('group/a', {
      q: 'water',
      categoryId: ['category-a', 'category-b'],
      productId: ['product-a', 'product-b'],
      status: 'POSTED',
      amountMin: '100',
      sort: 'amount',
      direction: 'desc',
      limit: 25,
    });

    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]), 'https://teamtaler.example');
    expect(requestUrl.pathname).toBe('/api/v1/groups/group%2Fa/bookings');
    expect(Object.fromEntries(requestUrl.searchParams)).toMatchObject({
      q: 'water',
      status: 'POSTED',
      amountMin: '100',
      sort: 'amount',
      direction: 'desc',
      limit: '25',
    });
    expect(requestUrl.searchParams.getAll('categoryId')).toEqual(['category-a', 'category-b']);
    expect(requestUrl.searchParams.getAll('productId')).toEqual(['product-a', 'product-b']);
    expect(page).toMatchObject({ items: [booking], nextCursor: 'opaque-next-page', hasMore: true, limit: 25 });
  });

  it('serializes unified activity filters with signed amounts and repeated values', async () => {
    const response = new Response(JSON.stringify([{
      id: 'payment:payment-a', sourceId: 'payment-a', kind: 'PAYMENT',
      targetMembershipId: 'member-a', targetDisplayName: 'Alex', targetMembershipStatus: 'ACTIVE',
      detailName: 'Bank transfer', amountMinor: '-1250', currency: 'EUR', occurredAt: '2026-08-20T10:00:00Z',
      status: 'POSTED', canReverse: false, reversalReasonRequired: false,
    }]), {
      headers: {
        'Content-Type': 'application/json',
        'X-Next-Cursor': 'activity-cursor',
        'X-Has-More': 'true',
        'X-Page-Limit': '50',
      },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(response);
    vi.stubGlobal('fetch', fetchMock);

    const page = await api.getActivitiesPage('group/a', {
      q: 'Alex', kind: ['PAYMENT', 'ADJUSTMENT'], targetMembershipId: 'member-a',
      categoryId: ['category-a', 'category-b'], productId: ['product-a', 'product-b'],
      status: 'POSTED', occurredFrom: '2026-08-01', occurredTo: '2026-08-31',
      amountMin: '-5000', amountMax: '2500', sort: 'amount', direction: 'asc', limit: 50,
    });

    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]), 'https://teamtaler.example');
    expect(requestUrl.pathname).toBe('/api/v1/groups/group%2Fa/activities');
    expect(requestUrl.searchParams.getAll('kind')).toEqual(['PAYMENT', 'ADJUSTMENT']);
    expect(requestUrl.searchParams.getAll('categoryId')).toEqual(['category-a', 'category-b']);
    expect(requestUrl.searchParams.getAll('productId')).toEqual(['product-a', 'product-b']);
    expect(Object.fromEntries(requestUrl.searchParams)).toMatchObject({
      q: 'Alex', targetMembershipId: 'member-a', status: 'POSTED', amountMin: '-5000', amountMax: '2500', sort: 'amount', direction: 'asc', limit: '50',
    });
    expect(page).toMatchObject({ items: [{ kind: 'PAYMENT', amount: { minorUnits: '-1250', currency: 'EUR' } }], nextCursor: 'activity-cursor', hasMore: true, limit: 50 });
  });

  it('serializes an activity anchor for a server-side focus context', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await api.getActivitiesPage('group-a', {
      anchorId: 'reversal:booking:booking-a',
      direction: 'desc',
      limit: 50,
      sort: 'occurredAt',
    });

    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]), 'https://teamtaler.example');
    expect(requestUrl.pathname).toBe('/api/v1/groups/group-a/activities');
    expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
      anchorId: 'reversal:booking:booking-a',
      direction: 'desc',
      limit: '50',
      sort: 'occurredAt',
    });
  });

  it('loads group-audit pages and member identities in parallel', async () => {
    const auditEntry = {
      id: 'audit-a',
      actorMembershipId: 'member-a',
      action: 'payment.created',
      resourceType: 'payment',
      resourceId: 'payment-a',
      metadata: { amountMinor: 100 },
      occurredAt: '2026-08-18T08:00:00Z',
    };
    const member = {
      id: 'member-a', userId: 'user-a', displayName: 'Alex', email: 'alex@example.test', initials: 'A', isTemporaryGuest: false,
      roles: ['MEMBER'], groupPermissions: [], categoryPermissions: [], status: 'ACTIVE', active: true,
    };
    const fetchMock = vi.fn((url: string) => Promise.resolve(url.includes('/audit')
      ? jsonResponse([auditEntry])
      : jsonResponse([member])));
    vi.stubGlobal('fetch', fetchMock);

    const page = await api.getAuditPage('group-a', { q: 'payment', action: ['payment.created', 'payment.reversed'], resourceType: ['payment'], limit: 50 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(expect.arrayContaining([
      '/api/v1/groups/group-a/audit?q=payment&action=payment.created&action=payment.reversed&resourceType=payment&limit=50',
      '/api/v1/groups/group-a/members',
    ]));
    expect(page.items[0]).toMatchObject({ actorName: 'Alex', action: 'payment.created', subject: 'payment · payment-a' });
    expect(page).toMatchObject({ hasMore: false, limit: 50 });
  });

  it('loads data-derived audit filter options for group and system scopes', async () => {
    const options = { actions: ['payment.created'], resourceTypes: ['payment'], actionResourceTypes: { 'payment.created': ['payment'] } };
    const fetchMock = vi.fn((url: string) => {
      void url;
      return Promise.resolve(jsonResponse(options));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getAuditFilterOptions('group/a')).resolves.toEqual(options);
    await expect(api.getSystemAuditFilterOptions()).resolves.toEqual(options);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/v1/groups/group%2Fa/audit/filter-options',
      '/api/v1/system/audit/filter-options',
    ]);
  });

  it('loads privacy-minimized booking and feed-derived activity filter options', async () => {
    const bookingOptions = { members: [{ membershipId: 'member-a', displayName: 'Alex', avatarUrl: '/avatars/alex.png' }] };
    const activityOptions = {
      ...bookingOptions,
      kinds: ['BOOKING', 'PAYMENT', 'ADJUSTMENT'],
      categories: [{ categoryId: 'category-a', name: 'Penalties', icon: 'penalty' }],
      products: [{ productId: 'product-a', categoryId: 'category-a', name: 'Late arrival' }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(bookingOptions))
      .mockResolvedValueOnce(jsonResponse(activityOptions));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getBookingFilterOptions('group/a')).resolves.toEqual(bookingOptions);
    await expect(api.getActivityFilterOptions('group/a')).resolves.toEqual(activityOptions);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/v1/groups/group%2Fa/bookings/filter-options',
      '/api/v1/groups/group%2Fa/activities/filter-options',
    ]);
  });

  it('posts a typed table export and returns the complete file body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('exported', { headers: { 'Content-Type': 'text/csv' } }));
    vi.stubGlobal('fetch', fetchMock);

    const blob = await api.exportGroupTable('group/a', {
      format: 'CSV',
      query: { q: 'Alex', sort: 'memberName', direction: 'asc' },
      table: 'ACCOUNT_BALANCES',
      timeZone: 'Europe/Berlin',
    });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/groups/group%2Fa/table-exports');
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({
      format: 'CSV',
      query: { q: 'Alex', sort: 'memberName', direction: 'asc' },
      table: 'ACCOUNT_BALANCES',
      timeZone: 'Europe/Berlin',
    });
    await expect(blobText(blob)).resolves.toBe('exported');
  });

  it('creates password-confirmed export jobs with a one-shot idempotency key', async () => {
    const job = { id: 'export-a', scope: 'PERSONAL', status: 'QUEUED', requestedAt: '2026-08-25T12:00:00Z' };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(job));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.createPersonalDataExport('group/a', 'current-password')).resolves.toEqual(job);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/groups/group%2Fa/me/exports');
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({ currentPassword: 'current-password' });
    expect(idempotencyKey(fetchMock.mock.calls[0])).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
