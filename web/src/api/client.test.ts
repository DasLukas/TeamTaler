import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Booking, BookingCommand, InvitationImportResult, InvitationMetadata, Session } from './types';
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
    groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: `member-${userId}`, roles: ['MEMBER'] } }],
    activeGroupId: 'group-a',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function idempotencyKey(call: unknown[]): string | null {
  return new Headers((call[1] as RequestInit | undefined)?.headers).get('Idempotency-Key');
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
    const product = { id: 'product-a', categoryId: 'category-a', version: 1, name: 'Water', priceMinor: 100, currency: 'EUR', active: true, sortOrder: 0 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(session('user-a')))
      .mockResolvedValueOnce(jsonResponse(product, 201))
      .mockResolvedValueOnce(jsonResponse({ ...product, id: 'product-b' }, 201));
    vi.stubGlobal('fetch', fetchMock);

    await api.getSession();
    const input = { categoryId: 'category-a', name: 'Water', price: { minorUnits: '100', currency: 'EUR' } };
    await api.createProduct('group-a', input);
    await api.createProduct('group-a', input);

    expect(idempotencyKey(fetchMock.mock.calls[1])).toBeTruthy();
    expect(idempotencyKey(fetchMock.mock.calls[1])).not.toBe(idempotencyKey(fetchMock.mock.calls[2]));
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
});
