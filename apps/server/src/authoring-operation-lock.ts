/**
 * Durable operation ownership for the authoring journals.
 *
 * The problem this solves: storyboard application and continue-shot both perform multi-step side
 * effects (create shot, extract frame, bind frame). Two concurrent `accept`/`resume` calls, or a
 * process that survived past its lease, must not run the same step twice. An in-memory mutex is
 * NOT evidence of cross-process safety, so ownership lives in `flume.authoring_operation_leases`
 * (migration 011) with three properties:
 *
 *  1. atomic acquire — one INSERT ... ON CONFLICT DO UPDATE statement decides the winner inside
 *     PostgreSQL; there is no read-then-write window;
 *  2. monotonic fencing — every acquisition increments `fence`. All journal writes carry the
 *     fence that authorised them (`WHERE owner_token = $x AND fence = $y`), so a process whose
 *     lease expired and was taken over cannot write stale results afterwards, even though its
 *     JavaScript callback is still running;
 *  3. expiry only affects liveness. Safety against duplicate work does NOT depend on the clock:
 *     a re-issued command uses the same deterministic command id, and
 *     `flume.command_receipts(actor_id, command_id)` replays the original receipt. The fence
 *     guarantees a superseded worker cannot record a competing interpretation of that result.
 *
 * Crash semantics: a worker that dies without releasing leaves its row behind. Once
 * `lease_expires_at` passes, the next `accept`/`resume` takes the lease with `fence + 1` and
 * reconciles the journal from durable state (created shots are kept, in-flight items are re-issued
 * with the same command id, and an extraction that was dispatched but left no visible frame is
 * reported as unknown instead of being re-run).
 */
import { createHash, randomUUID } from 'node:crypto';

export type AuthoringScope = 'storyboard.apply' | 'continue-shot';

export type AuthoringLease = {
  scope: AuthoringScope;
  /** Proposal id for storyboard application, operation id for continue-shot. */
  operationId: string;
  projectId: string;
  ownerToken: string;
  /** Monotonic per-operation fencing token. Every guarded write must carry it. */
  fence: number;
  expiresAt: string;
};

export type AuthoringLeaseView = {
  projectId: string;
  ownerToken: string;
  fence: number;
  expiresAt: string;
  released: boolean;
  live: boolean;
};

export type AuthoringLeaseResult = {
  acquired: boolean;
  lease: AuthoringLease | null;
  /** The competing owner's view when acquisition lost; never a credential. */
  current: AuthoringLeaseView | null;
};

export interface AuthoringOperationLock {
  acquire(input: {
    scope: AuthoringScope;
    operationId: string;
    projectId: string;
    ownerToken?: string;
    ttlMs?: number;
  }): Promise<AuthoringLeaseResult>;
  release(lease: AuthoringLease): Promise<boolean>;
  inspect(scope: AuthoringScope, operationId: string): Promise<AuthoringLeaseView | null>;
}

/**
 * Fixture-only synchronous view. Service tests need the ownership check and the guarded write to
 * happen in ONE JavaScript turn (that is what makes the memory store's CAS honest for a single
 * process); awaiting a promise between them would open a real interleaving window.
 */
export type MemoryAuthoringOperationLock = AuthoringOperationLock & {
  peekSync(scope: AuthoringScope, operationId: string): AuthoringLeaseView | null;
};

export type AuthoringSqlExecutor = {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
};

export const DEFAULT_LEASE_TTL_MS = 60_000;
export const MIN_LEASE_TTL_MS = 250;
export const MAX_LEASE_TTL_MS = 900_000;

export function newOwnerToken(): string {
  return randomUUID();
}

function checkTtl(ttlMs: number | undefined): number {
  const value = ttlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isInteger(value) || value < MIN_LEASE_TTL_MS || value > MAX_LEASE_TTL_MS) {
    throw new TypeError(`Lease ttl must be an integer between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS} ms.`);
  }
  return value;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

/**
 * Single-statement acquisition. `RETURNING` empty means somebody else holds a live lease; the
 * caller then re-reads the row to report who. Both the expiry comparison and the new expiry use
 * `clock_timestamp()` so a long transaction cannot extend its own lease with a stale `now()`.
 */
const ACQUIRE_SQL = `INSERT INTO flume.authoring_operation_leases AS current
  (scope, operation_id, project_id, owner_token, fence, lease_expires_at)
VALUES ($1, $2, $3, $4, 1, clock_timestamp() + ($5::int * interval '1 millisecond'))
ON CONFLICT (scope, operation_id) DO UPDATE
SET owner_token = EXCLUDED.owner_token,
    fence = current.fence + 1,
    lease_expires_at = EXCLUDED.lease_expires_at,
    acquired_at = clock_timestamp(),
    released_at = NULL
WHERE current.project_id = EXCLUDED.project_id
  AND (current.released_at IS NOT NULL
       OR current.lease_expires_at <= clock_timestamp()
       OR current.owner_token = EXCLUDED.owner_token)
RETURNING project_id, owner_token, fence, lease_expires_at`;

const INSPECT_SQL = `SELECT project_id, owner_token, fence, lease_expires_at, released_at,
  (released_at IS NULL AND lease_expires_at > clock_timestamp()) AS live
  FROM flume.authoring_operation_leases WHERE scope = $1 AND operation_id = $2`;

const RELEASE_SQL = `UPDATE flume.authoring_operation_leases
  SET released_at = clock_timestamp()
  WHERE scope = $1 AND operation_id = $2 AND owner_token = $3 AND fence = $4 AND released_at IS NULL`;

export function createSqlAuthoringOperationLock(sql: AuthoringSqlExecutor): AuthoringOperationLock {
  if (!sql || typeof sql.query !== 'function') throw new TypeError('A SQL executor with query(text, params) is required.');
  const lock: AuthoringOperationLock = {
    async acquire({ scope, operationId, projectId, ownerToken, ttlMs }) {
      const ttl = checkTtl(ttlMs);
      const owner = ownerToken ?? newOwnerToken();
      const { rows } = await sql.query(ACQUIRE_SQL, [scope, operationId, projectId, owner, ttl]);
      const row = rows[0];
      if (row) {
        return {
          acquired: true,
          lease: {
            scope, operationId, projectId: row.project_id, ownerToken: row.owner_token,
            fence: Number(row.fence), expiresAt: iso(row.lease_expires_at),
          },
          current: null,
        };
      }
      return { acquired: false, lease: null, current: await lock.inspect(scope, operationId) };
    },
    async release(lease) {
      const { rowCount } = await sql.query(RELEASE_SQL, [lease.scope, lease.operationId, lease.ownerToken, lease.fence]);
      return rowCount === 1;
    },
    async inspect(scope, operationId) {
      const { rows } = await sql.query(INSPECT_SQL, [scope, operationId]);
      const row = rows[0];
      return row ? {
        projectId: row.project_id, ownerToken: row.owner_token, fence: Number(row.fence),
        expiresAt: iso(row.lease_expires_at), released: row.released_at !== null, live: row.live === true,
      } : null;
    },
  };
  return lock;
}

/**
 * Labelled fixture lock: single-process memory only. It reproduces the same fence/expiry
 * semantics so service tests can exercise takeover and stale-writer behaviour, but it is NOT
 * cross-process ownership and must never be described as durable.
 */
export function createMemoryAuthoringOperationLock(options: { now?: () => number } = {}): MemoryAuthoringOperationLock {
  const now = options.now ?? (() => Date.now());
  type Row = { projectId: string; ownerToken: string; fence: number; expiresAtMs: number; released: boolean };
  const rows = new Map<string, Row>();
  const key = (scope: string, operationId: string) => `${scope}/${operationId.toLowerCase()}`;
  const view = (row: Row): AuthoringLeaseView => ({
    projectId: row.projectId, ownerToken: row.ownerToken, fence: row.fence,
    expiresAt: new Date(row.expiresAtMs).toISOString(), released: row.released,
    live: !row.released && row.expiresAtMs > now(),
  });
  const lock: MemoryAuthoringOperationLock = {
    async acquire({ scope, operationId, projectId, ownerToken, ttlMs }) {
      const ttl = checkTtl(ttlMs);
      const owner = ownerToken ?? newOwnerToken();
      const k = key(scope, operationId);
      const existing = rows.get(k);
      if (existing && existing.projectId !== projectId) {
        return { acquired: false, lease: null, current: view(existing) };
      }
      if (existing && !existing.released && existing.expiresAtMs > now() && existing.ownerToken !== owner) {
        return { acquired: false, lease: null, current: view(existing) };
      }
      const row: Row = {
        projectId,
        ownerToken: owner,
        fence: (existing?.fence ?? 0) + 1,
        expiresAtMs: now() + ttl,
        released: false,
      };
      rows.set(k, row);
      return {
        acquired: true,
        lease: { scope, operationId, projectId, ownerToken: owner, fence: row.fence, expiresAt: new Date(row.expiresAtMs).toISOString() },
        current: null,
      };
    },
    async release(lease) {
      const row = rows.get(key(lease.scope, lease.operationId));
      if (!row || row.ownerToken !== lease.ownerToken || row.fence !== lease.fence || row.released) return false;
      row.released = true;
      return true;
    },
    async inspect(scope, operationId) {
      const row = rows.get(key(scope, operationId));
      return row ? view(row) : null;
    },
    peekSync(scope, operationId) {
      const row = rows.get(key(scope, operationId));
      return row ? view(row) : null;
    },
  };
  return lock;
}

/**
 * Fingerprint of a frozen command payload. Used by both journal adapters and by the services to
 * prove that the bytes about to be sent are exactly the bytes an operator accepted.
 */
export function fingerprintPayload(payload: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
        .map(k => [k, canonical((value as Record<string, unknown>)[k])]));
    }
    return value;
  };
  return createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
}
