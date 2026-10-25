/**
 * Durable PostgreSQL adapter for `ContinueShotJournal` (requires migration
 * `011_authoring_journals.sql`, which is NOT applied by this worker).
 *
 * OWNERSHIP AUTHORITY. `flume.authoring_operation_leases` is the single canonical owner of a
 * continuation run (`scope = 'continue-shot'`, `operation_id`, `project_id`, `owner_token`,
 * `fence`, `lease_expires_at`, `released_at`). The journal row also carries `owner_token`,
 * `fence` and `lease_expires_at`, but those columns are a MIRROR of the lease, never the
 * authority: they are written only by `begin`/`save` and cleared by `release`, and no guard in
 * this file reads them. That distinction is the repair: `begin` used to leave the mirror NULL
 * while the save guard required it, so the first legitimate save could never match; and the save
 * used to renew only the mirror while `isActive()` consulted the lease, so a healthy owner could
 * lose liveness and a stale one could keep it.
 *
 * Executor contract (read before wiring):
 *  - `executor.query(text, params)` is a single-statement API (`pg.Pool` or `pg.PoolClient`).
 *  - `begin` is three statements: `INSERT ... ON CONFLICT DO NOTHING` (create-once, never mutates
 *    an existing row), the atomic lease acquisition from ./authoring-operation-lock.ts, and a
 *    mirror stamp that is itself guarded by the live lease. If the acquisition loses, nothing is
 *    stamped and the caller is told it did not acquire; if the stamp loses (the lease was taken
 *    over between the two statements) the caller is also told it did not acquire, because by then
 *    somebody else owns the run.
 *  - `save` is ONE compare-and-set statement that (a) requires the currently live, unreleased
 *    lease for the exact scope/operation/project/owner/fence, (b) requires the journal row to be
 *    in one of `from`'s statuses, and (c) renews that SAME lease — the authority `isActive()`
 *    reads. All three happen inside one statement, so there is no read-then-write window and a
 *    failed CAS neither advances the row nor extends the lease.
 *  - The journal row's intent columns, and the command payloads once written, are protected by a
 *    database trigger; this adapter never rewrites them with different bytes (it replays them).
 *  - If the executor is a `PoolClient` inside a caller transaction, `begin`/`save` join that
 *    transaction; the caller must commit for the state to be visible to other processes.
 */
import {
  createSqlAuthoringOperationLock,
  DEFAULT_LEASE_TTL_MS,
  type AuthoringLease,
  type AuthoringSqlExecutor,
} from './authoring-operation-lock.ts';
import type {
  ContinueShotBegin, ContinueShotCommand, ContinueShotGuard, ContinueShotJournal,
  ContinueShotJournalStatus, ContinueShotRecord,
} from './continue-shot.ts';

export type ContinueShotSqlExecutor = AuthoringSqlExecutor;
export type ContinueShotSqlOptions = { leaseTtlMs?: number };

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
const optionalIso = (value: unknown): string | null => (value === null || value === undefined ? null : iso(value));

function recordFromRow(row: any): ContinueShotRecord {
  return {
    operationId: row.operation_id,
    projectId: row.project_id,
    actorId: row.actor_id,
    actorKind: row.actor_kind,
    intentHash: row.intent_hash,
    sourceTakeId: row.source_take_id,
    sourceShotId: row.source_shot_id,
    sourceAssetId: row.source_asset_id,
    sourceAssetSha256: row.source_asset_sha256,
    title: row.title,
    prompt: row.prompt,
    status: row.status as ContinueShotJournalStatus,
    extractionDispatched: row.extraction_dispatched === true,
    extractedAssetId: row.extracted_asset_id ?? null,
    shotId: row.shot_id ?? null,
    shotRevision: row.shot_revision === null || row.shot_revision === undefined ? null : Number(row.shot_revision),
    createPayload: (row.create_payload ?? null) as ContinueShotCommand | null,
    createPayloadHash: row.create_payload_hash ?? null,
    bindPayload: (row.bind_payload ?? null) as ContinueShotCommand | null,
    bindPayloadHash: row.bind_payload_hash ?? null,
    blockers: Array.isArray(row.blockers) ? row.blockers : [],
    message: row.message ?? null,
    resumable: row.resumable === true,
    updatedAt: optionalIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

/**
 * Mirrors the lease just acquired onto the journal row. Guarded by the CANONICAL lease (not by the
 * mirror it is writing), so a takeover cannot have its row overwritten by the previous owner.
 * Parameters: $1 journal operation id, $2 project id, $3 lease operation key (lower-case text),
 * $4 owner token, $5 fence.
 */
const STAMP_SQL = `UPDATE flume.continue_shot_journal j
SET owner_token = l.owner_token,
    fence = l.fence,
    lease_expires_at = l.lease_expires_at,
    updated_at = clock_timestamp()
FROM flume.authoring_operation_leases l
WHERE j.operation_id = $1
  AND j.project_id = $2
  AND l.scope = 'continue-shot'
  AND l.operation_id = $3
  AND l.project_id = $2
  AND l.owner_token = $4
  AND l.fence = $5
  AND l.released_at IS NULL
  AND l.lease_expires_at > clock_timestamp()
RETURNING j.*`;

/**
 * ONE statement: renew the canonical lease (only while it is live, unreleased and ours AND the
 * journal row is in one of `from`'s statuses), then apply the compare-and-set to the journal with
 * the renewed authority mirrored onto it. `FROM renewed` is what makes a lost CAS write nothing:
 * no renewal row, no journal update.
 *
 * Parameters: $1 operation id, $2 from-statuses, $3 status, $4 extraction_dispatched,
 * $5 extracted_asset_id, $6 shot_id, $7 shot_revision, $8 create_payload, $9 create_payload_hash,
 * $10 bind_payload, $11 bind_payload_hash, $12 blockers, $13 message, $14 resumable,
 * $15 owner token, $16 fence, $17 ttl ms, $18 lease operation key, $19 project id.
 */
const SAVE_SQL = `WITH renewed AS (
  UPDATE flume.authoring_operation_leases l
  SET lease_expires_at = clock_timestamp() + ($17::int * interval '1 millisecond')
  WHERE l.scope = 'continue-shot'
    AND l.operation_id = $18
    AND l.project_id = $19
    AND l.owner_token = $15
    AND l.fence = $16
    AND l.released_at IS NULL
    AND l.lease_expires_at > clock_timestamp()
    AND EXISTS (SELECT 1 FROM flume.continue_shot_journal t
                WHERE t.operation_id = $1 AND t.project_id = $19 AND t.status = ANY($2::text[]))
  RETURNING l.owner_token, l.fence, l.lease_expires_at
)
UPDATE flume.continue_shot_journal j
SET status = $3,
    extraction_dispatched = $4,
    extracted_asset_id = $5::uuid,
    shot_id = $6::uuid,
    shot_revision = $7,
    create_payload = $8::jsonb,
    create_payload_hash = $9,
    bind_payload = $10::jsonb,
    bind_payload_hash = $11,
    blockers = $12::jsonb,
    message = $13,
    resumable = $14,
    owner_token = renewed.owner_token,
    fence = renewed.fence,
    lease_expires_at = renewed.lease_expires_at,
    updated_at = clock_timestamp()
FROM renewed
WHERE j.operation_id = $1
  AND j.project_id = $19
  AND j.status = ANY($2::text[])
RETURNING j.*`;

/**
 * Clears the mirror after the canonical lease has been released. Guarded by the same owner+fence,
 * so it can never blank a newer owner's mirror. Parameters: $1 operation id, $2 owner token, $3 fence.
 */
const CLEAR_MIRROR_SQL = `UPDATE flume.continue_shot_journal
SET owner_token = NULL,
    lease_expires_at = NULL,
    updated_at = clock_timestamp()
WHERE operation_id = $1
  AND owner_token = $2
  AND fence = $3`;

export function createSqlContinueShotJournal(
  sql: ContinueShotSqlExecutor,
  options: ContinueShotSqlOptions = {},
): ContinueShotJournal {
  if (!sql || typeof sql.query !== 'function') throw new TypeError('A SQL executor with query(text, params) is required.');
  const leasePort = createSqlAuthoringOperationLock(sql);
  const ttlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < 250) throw new TypeError('leaseTtlMs must be an integer of at least 250 ms.');

  const load = async (operationId: string): Promise<ContinueShotRecord | null> => {
    const { rows } = await sql.query('SELECT * FROM flume.continue_shot_journal WHERE operation_id = $1', [operationId]);
    return rows[0] ? recordFromRow(rows[0]) : null;
  };

  return {
    load,

    async begin(record: ContinueShotRecord, beginOptions = {}) {
      const inserted = await sql.query(
        `INSERT INTO flume.continue_shot_journal
           (operation_id, project_id, actor_id, actor_kind, intent_hash, source_take_id, source_shot_id,
            source_asset_id, source_asset_sha256, title, prompt, status, extraction_dispatched,
            extracted_asset_id, shot_id, shot_revision, create_payload, create_payload_hash,
            bind_payload, bind_payload_hash, command_actor_id, command_actor_kind, blockers,
            message, resumable, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::uuid,$15::uuid,$16,
                 $17::jsonb,$18,$19::jsonb,$20,$3,$4,$21::jsonb,$22,$23,clock_timestamp())
         ON CONFLICT (operation_id) DO NOTHING
         RETURNING *`, [
        record.operationId, record.projectId, record.actorId, record.actorKind, record.intentHash,
        record.sourceTakeId, record.sourceShotId, record.sourceAssetId, record.sourceAssetSha256,
        record.title, record.prompt, record.status, record.extractionDispatched,
        record.extractedAssetId, record.shotId, record.shotRevision,
        record.createPayload === null ? null : JSON.stringify(record.createPayload),
        record.createPayloadHash,
        record.bindPayload === null ? null : JSON.stringify(record.bindPayload),
        record.bindPayloadHash,
        JSON.stringify(record.blockers), record.message, record.resumable,
      ]);
      const created = inserted.rows.length === 1;
      const stored = created ? recordFromRow(inserted.rows[0]) : await load(record.operationId);
      if (!stored) throw new Error('CONTINUE_SHOT_JOURNAL_UNAVAILABLE');
      const acquired = await leasePort.acquire({
        scope: 'continue-shot', operationId: record.operationId.toLowerCase(), projectId: stored.projectId,
        ownerToken: beginOptions.ownerToken, ttlMs: beginOptions.ttlMs ?? ttlMs,
      });
      if (!acquired.lease) {
        const result: ContinueShotBegin = { record: stored, created, lease: null };
        return result;
      }
      // Mirror the authority onto the journal row. The stamp re-checks the lease, so a takeover
      // between acquire and stamp leaves no mirror behind and this run proceeds as a non-owner.
      const stamped = await sql.query(STAMP_SQL, [
        record.operationId, stored.projectId, record.operationId.toLowerCase(),
        acquired.lease.ownerToken, acquired.lease.fence,
      ]);
      const result: ContinueShotBegin = {
        record: stamped.rows[0] ? recordFromRow(stamped.rows[0]) : stored,
        created,
        lease: stamped.rows[0] ? acquired.lease : null,
      };
      return result;
    },

    async save(record: ContinueShotRecord, from: ContinueShotJournalStatus[], guard: ContinueShotGuard) {
      const { rows } = await sql.query(SAVE_SQL, [
        record.operationId, from, record.status, record.extractionDispatched,
        record.extractedAssetId, record.shotId, record.shotRevision,
        record.createPayload === null ? null : JSON.stringify(record.createPayload),
        record.createPayloadHash,
        record.bindPayload === null ? null : JSON.stringify(record.bindPayload),
        record.bindPayloadHash,
        JSON.stringify(record.blockers), record.message, record.resumable,
        guard.ownerToken, guard.fence, ttlMs,
        record.operationId.toLowerCase(), record.projectId,
      ]);
      return rows[0] ? recordFromRow(rows[0]) : null;
    },

    async release(operationId: string, guard: ContinueShotGuard) {
      const stored = await load(operationId);
      if (!stored) return;
      const lease: AuthoringLease = {
        scope: 'continue-shot', operationId: operationId.toLowerCase(), projectId: stored.projectId,
        ownerToken: guard.ownerToken, fence: guard.fence, expiresAt: new Date().toISOString(),
      };
      const released = await leasePort.release(lease);
      if (!released) return;
      await sql.query(CLEAR_MIRROR_SQL, [operationId, guard.ownerToken, guard.fence]);
    },

    /** Read-only: consults the lease row; it never acquires, renews or releases. */
    async isActive(operationId: string) {
      const view = await leasePort.inspect('continue-shot', operationId.toLowerCase());
      return view?.live === true;
    },
  };
}
