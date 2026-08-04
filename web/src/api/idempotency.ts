const DEFAULT_STORAGE_KEY = 'teamtaler.idempotency-reservations.v1';
const DEFAULT_TTL_MS = 15 * 60 * 1000;

interface StoredReservation {
  actorUserId: string;
  groupId: string;
  operation: string;
  path: string;
  fingerprint: string;
  key: string;
  expiresAt: number;
}

/** A reserved idempotency key and its immutable lookup identity. */
export interface IdempotencyReservation {
  key: string;
  actorUserId: string;
  groupId: string;
  operation: string;
  path: string;
  fingerprint: string;
}

/** Input used to scope a high-risk mutation reservation. */
export interface IdempotencyScope {
  groupId: string;
  operation: string;
  path: string;
  payload: unknown;
}

type Clock = () => number;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${fields.join(',')}}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Persists scoped idempotency reservations for recoverable high-risk requests.
 *
 * Reservations survive reloads in the current browser tab, expire automatically,
 * and are never reused across actors, groups, operations, paths, or payloads.
 *
 * @example
 * ```ts
 * const manager = new IdempotencyReservationManager(sessionStorage);
 * manager.setActor('user-1');
 * const reservation = await manager.reserve({
 *   groupId: 'group-1',
 *   operation: 'booking.create',
 *   path: '/groups/group-1/bookings',
 *   payload: { productId: 'product-1' },
 * });
 * manager.complete(reservation);
 * ```
 */
export class IdempotencyReservationManager {
  private actorUserId = '';

  /**
   * Creates a reservation manager.
   *
   * @param storage - Tab-scoped storage used to persist reservations.
   * @param ttlMs - Maximum reservation lifetime in milliseconds.
   * @param now - Clock dependency used for expiry checks.
   * @param storageKey - Namespaced session-storage key.
   */
  constructor(
    private readonly storage: Storage,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now: Clock = Date.now,
    private readonly storageKey = DEFAULT_STORAGE_KEY,
  ) {}

  /**
   * Sets the authenticated actor used by subsequent reservations.
   *
   * @param actorUserId - Stable authenticated user identifier.
   * @returns Nothing.
   */
  setActor(actorUserId: string): void {
    this.actorUserId = actorUserId;
  }

  /**
   * Finds or creates a scoped key for one exact mutation payload.
   *
   * @param scope - Group, operation, path, and request payload identity.
   * @returns The existing unexpired reservation or a newly generated one.
   * @throws Error when no authenticated actor has been set or SHA-256 is unavailable.
   */
  async reserve(scope: IdempotencyScope): Promise<IdempotencyReservation> {
    if (!this.actorUserId) throw new Error('Authenticated actor is required for an idempotent mutation.');
    const fingerprint = await sha256(stableJson(scope.payload));
    const reservations = this.load();
    const existing = reservations.find((entry) => (
      entry.actorUserId === this.actorUserId
      && entry.groupId === scope.groupId
      && entry.operation === scope.operation
      && entry.path === scope.path
      && entry.fingerprint === fingerprint
    ));
    const reservation = existing ?? {
      actorUserId: this.actorUserId,
      groupId: scope.groupId,
      operation: scope.operation,
      path: scope.path,
      fingerprint,
      key: crypto.randomUUID(),
      expiresAt: this.now() + this.ttlMs,
    };
    if (!existing) this.save([...reservations, reservation]);
    return reservation;
  }

  /**
   * Removes a reservation after a successful or definitively rejected request.
   *
   * @param reservation - Exact reservation returned by {@link reserve}.
   * @returns Nothing.
   */
  complete(reservation: IdempotencyReservation): void {
    this.save(this.load().filter((entry) => entry.key !== reservation.key));
  }

  /**
   * Removes every stored reservation and forgets the authenticated actor.
   *
   * @returns Nothing.
   */
  clearAll(): void {
    this.storage.removeItem(this.storageKey);
    this.actorUserId = '';
  }

  private load(): StoredReservation[] {
    const currentTime = this.now();
    try {
      const parsed = JSON.parse(this.storage.getItem(this.storageKey) ?? '[]') as StoredReservation[];
      const valid = Array.isArray(parsed)
        ? parsed.filter((entry) => typeof entry.key === 'string' && entry.expiresAt > currentTime)
        : [];
      if (valid.length !== parsed.length) this.save(valid);
      return valid;
    } catch {
      this.storage.removeItem(this.storageKey);
      return [];
    }
  }

  private save(reservations: StoredReservation[]): void {
    if (reservations.length === 0) {
      this.storage.removeItem(this.storageKey);
      return;
    }
    this.storage.setItem(this.storageKey, JSON.stringify(reservations));
  }
}
