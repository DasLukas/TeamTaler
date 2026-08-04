import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Booking, BookingCommand, Session } from './types';
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
});
