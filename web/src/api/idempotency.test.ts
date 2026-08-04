import { beforeEach, describe, expect, it } from 'vitest';
import { IdempotencyReservationManager } from './idempotency';

describe('IdempotencyReservationManager', () => {
  beforeEach(() => sessionStorage.clear());

  it('isolates keys by actor, group, operation, path, and payload', async () => {
    const manager = new IdempotencyReservationManager(sessionStorage);
    manager.setActor('user-a');
    const base = await manager.reserve({ groupId: 'group-a', operation: 'booking.create', path: '/groups/group-a/bookings', payload: { quantity: 1, productId: 'product-a' } });
    const same = await manager.reserve({ groupId: 'group-a', operation: 'booking.create', path: '/groups/group-a/bookings', payload: { productId: 'product-a', quantity: 1 } });
    const otherGroup = await manager.reserve({ groupId: 'group-b', operation: 'booking.create', path: '/groups/group-b/bookings', payload: { quantity: 1, productId: 'product-a' } });
    const otherPayload = await manager.reserve({ groupId: 'group-a', operation: 'booking.create', path: '/groups/group-a/bookings', payload: { quantity: 2, productId: 'product-a' } });
    const otherOperation = await manager.reserve({ groupId: 'group-a', operation: 'booking.void', path: '/groups/group-a/bookings', payload: { quantity: 1, productId: 'product-a' } });
    const otherPath = await manager.reserve({ groupId: 'group-a', operation: 'booking.create', path: '/groups/group-a/bookings/other', payload: { quantity: 1, productId: 'product-a' } });
    manager.setActor('user-b');
    const otherActor = await manager.reserve({ groupId: 'group-a', operation: 'booking.create', path: '/groups/group-a/bookings', payload: { quantity: 1, productId: 'product-a' } });

    expect(same.key).toBe(base.key);
    expect(new Set([base.key, otherGroup.key, otherPayload.key, otherOperation.key, otherPath.key, otherActor.key])).toHaveLength(6);
  });

  it('expires reservations after the configured TTL', async () => {
    let now = 1_000;
    const manager = new IdempotencyReservationManager(sessionStorage, 500, () => now, 'ttl-test');
    manager.setActor('user-a');
    const scope = { groupId: 'group-a', operation: 'payment.create', path: '/groups/group-a/payments', payload: { amountMinor: 100 } };
    const first = await manager.reserve(scope);
    now = 1_499;
    expect((await manager.reserve(scope)).key).toBe(first.key);
    now = 1_500;
    expect((await manager.reserve(scope)).key).not.toBe(first.key);
  });

  it('allocates a new key after completion and clears all stored reservations', async () => {
    const manager = new IdempotencyReservationManager(sessionStorage, 1_000, Date.now, 'cleanup-test');
    manager.setActor('user-a');
    const scope = { groupId: 'group-a', operation: 'period.close', path: '/groups/group-a/periods/period-a/close', payload: { label: 'August' } };
    const first = await manager.reserve(scope);
    manager.complete(first);
    const second = await manager.reserve(scope);
    expect(second.key).not.toBe(first.key);
    manager.clearAll();
    expect(sessionStorage.getItem('cleanup-test')).toBeNull();
    await expect(manager.reserve(scope)).rejects.toThrow(/actor/i);
  });
});
