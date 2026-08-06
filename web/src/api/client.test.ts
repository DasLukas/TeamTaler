import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Booking, BookingCommand, InvitationImportResult, InvitationMetadata, ProductCreateCommand, Session } from './types';
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
  productId: 'product-a',
  productName: 'Water',
  categoryId: 'category-a',
  categoryName: 'Drinks',
  quantity: 1,
  unitPrice: { minorUnits: '100', currency: 'EUR' },
  total: { minorUnits: '100', currency: 'EUR' },
  bookedAt: '2026-08-04T12:00:00Z',
  bookedByName: 'Alex',
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
    groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: `member-${userId}`, roles: ['MEMBER'], groupPermissions: [] } }],
    activeGroupId: 'group-a',
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

describe('high-risk API idempotency', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => vi.unstubAllGlobals());

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
    await expect(api.importInvitations('group-a', file)).rejects.toThrow('network lost');
    await expect(api.importInvitations('group-a', file)).resolves.toEqual(importResult);

    const firstInit = fetchMock.mock.calls[1][1] as RequestInit;
    const secondInit = fetchMock.mock.calls[2][1] as RequestInit;
    expect(firstInit.body).toBe(csv);
    expect(new Headers(firstInit.headers).get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(idempotencyKey(fetchMock.mock.calls[1])).toBe(idempotencyKey(fetchMock.mock.calls[2]));
    expect(secondInit.body).toBe(csv);
  });

  it('rejects malformed UTF-8 CSV bytes before creating an invitation request', async () => {
    const invalidBytes = Uint8Array.from([0x65, 0x6d, 0x61, 0x69, 0x6c, 0x0a, 0xff]);
    const file = new File([invalidBytes], 'members.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'arrayBuffer', { value: vi.fn().mockResolvedValue(invalidBytes.buffer) });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.importInvitations('group-a', file)).rejects.toThrow('UTF-8');

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
      expiresAt: '2026-08-11T12:00:00Z',
      emailDeliveryStatus: 'SENT',
      emailSentAt: '2026-08-04T12:01:00Z',
    }];
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(invitations));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getInvitations('group-a')).resolves.toEqual(invitations);

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/groups/group-a/invitations', expect.objectContaining({ credentials: 'include' }));
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
      .mockResolvedValueOnce(jsonResponse({ membersCanViewAllBookings: false }))
      .mockResolvedValueOnce(jsonResponse({ membersCanViewAllBookings: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getGroupSettings('group-a')).resolves.toEqual({ membersCanViewAllBookings: false });
    await expect(api.updateGroupSettings('group-a', { membersCanViewAllBookings: true })).resolves.toEqual({ membersCanViewAllBookings: true });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/groups/group-a/settings');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/groups/group-a/settings');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'PATCH' });
    expect(requestBody(fetchMock.mock.calls[1])).toEqual({ membersCanViewAllBookings: true });
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
