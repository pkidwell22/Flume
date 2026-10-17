import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { queue, type Experiment } from '../src/database.js';
import { requestSchema } from '../src/contracts.js';
import { publishBytes } from './store.js';

export type Policy = { origin: string; storage: string; lookup: boolean; replaySafe: boolean; replaySeconds: number; adapter: string };
export type Checkpoint = (point: string) => Promise<void>;
const outputSchema = z.strictObject({ id: z.string().regex(/^output-[01]$/), path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().min(1).max(4096) });
const remoteSchema = z.strictObject({ version: z.literal(1), id: z.uuid(), key: z.uuid(), account: z.uuid(), route: z.literal('fixture/video-v1'),
  state: z.enum(['running', 'succeeded', 'cancelled']), outputs: z.array(outputSchema).max(2) });
type Remote = z.infer<typeof remoteSchema>;
type Dispatch = { attempt_id: string; key: string; origin: string; account: string; route: string; adapter: string; body: string;
  replay_until: Date; replay_safe: boolean };
async function transaction<T>(e: Experiment, action: (client: PoolClient) => Promise<T>) {
  const client = await e.pool.connect();
  try { await client.query('BEGIN'); const value = await action(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function request(d: Dispatch, endpoint: string, method = 'GET'): Promise<Remote | null> {
  assert.match(d.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert(endpoint.startsWith('/') && !endpoint.startsWith('//'));
  const response = await fetch(d.origin + endpoint, { method, redirect: 'error', signal: AbortSignal.timeout(4000),
    headers: { 'idempotency-key': d.key, 'x-fixture-account': d.account, 'x-fixture-route': d.route },
    ...(endpoint === '/submit' ? { body: d.body } : {}) });
  if (response.status === 404) return null;
  assert(response.ok, `provider HTTP ${response.status}`);
  const remote = remoteSchema.parse(await response.json());
  assert.equal(remote.key, d.key); assert.equal(remote.account, d.account); assert.equal(remote.route, d.route);
  return remote;
}

export async function runDelivery(e: Experiment, policy: Policy, checkpoint: Checkpoint) {
  const [job] = await e.boss.fetch(queue); assert(job, 'no queued delivery');
  const { attemptId } = z.strictObject({ version: z.literal(1), attemptId: z.uuid() }).parse(job.data);
  const owner = randomUUID();
  const epoch: number = await transaction(e, async client => {
    const { rows: [row] } = await client.query(`UPDATE recovery.lifecycle SET epoch=epoch+1, owner=$2
      WHERE attempt_id=$1 RETURNING epoch`, [attemptId, owner]); assert(row);
    await client.query('INSERT INTO recovery.deliveries VALUES ($1,$2,$3,$4,NULL)', [owner, job.id, attemptId, row.epoch]);
    return row.epoch;
  });
  const owns = async () => (await e.pool.query('SELECT 1 FROM recovery.lifecycle WHERE attempt_id=$1 AND owner=$2 AND epoch=$3',
    [attemptId, owner, epoch])).rowCount === 1;
  const finish = async (outcome: string) => {
    await checkpoint('finish');
    return transaction(e, async client => {
      const { rows: [current] } = await client.query('SELECT * FROM recovery.lifecycle WHERE attempt_id=$1 FOR UPDATE', [attemptId]);
      const currentOwner = current.owner === owner && current.epoch === epoch;
      const result = currentOwner ? outcome : 'stale';
      await client.query('UPDATE recovery.deliveries SET outcome=$2 WHERE owner=$1', [owner, result]);
      // The owner check and queue acknowledgement share one transaction/lock.
      if (currentOwner) await e.boss.complete(queue, job.id, null, { db: { executeSql: (text, values) => client.query(text, values) } });
      return result;
    });
  };
  const hold = async (reason: string) => {
    await e.pool.query('UPDATE recovery.lifecycle SET hold=$4 WHERE attempt_id=$1 AND owner=$2 AND epoch=$3', [attemptId, owner, epoch, reason]);
    return finish(reason);
  };
  const d: Dispatch = await transaction(e, async client => {
    const { rows: [attempt] } = await client.query('SELECT * FROM spike.attempts WHERE id=$1', [attemptId]);
    const frozen = requestSchema.parse(attempt.request);
    await client.query(`INSERT INTO recovery.dispatch (attempt_id,key,origin,account,route,adapter,body,replay_until,replay_safe)
      VALUES ($1,$1,$2,$3,$4,$5,$6,clock_timestamp()+$7*interval '1 second',$8) ON CONFLICT (attempt_id) DO NOTHING`,
      [attemptId, policy.origin, frozen.accountId, frozen.route, frozen.envelope.adapterVersion, frozen.envelope.body, policy.replaySeconds, policy.replaySafe]);
    return (await client.query('SELECT * FROM recovery.dispatch WHERE attempt_id=$1', [attemptId])).rows[0];
  });
  const state = (await e.pool.query('SELECT * FROM recovery.lifecycle WHERE attempt_id=$1', [attemptId])).rows[0];
  if (d.origin !== policy.origin || d.adapter !== policy.adapter) return hold('REPLAY_SCOPE');
  // Evidence is append-only even when its delivery lost ownership. A CURRENT
  // delivery reconciles that handle; the stale worker never mutates checkpoints.
  const { rows: observations } = await e.pool.query('SELECT receipt FROM recovery.observations WHERE attempt_id=$1 ORDER BY id', [attemptId]);
  const handles = new Set(observations.map(row => remoteSchema.parse(row.receipt).id));
  if (state.remote_id) handles.add(state.remote_id);
  if (handles.size > 1) return hold('IDENTITY_CONFLICT');
  const known = [...handles][0];
  let remote: Remote | null;
  try {
    remote = known ? await request(d, `/jobs/${known}`) :
      policy.lookup && state.remote_state === 'unknown' ? await request(d, '/lookup') : null;
  } catch { return hold('REMOTE_UNAVAILABLE'); }
  if (known && !remote) return hold('REMOTE_UNAVAILABLE');
  if (known && remote && remote.id !== known) return hold('IDENTITY_CONFLICT');
  if (!remote) {
    await checkpoint('before-authorize');
    const blocked = await transaction(e, async client => {
      const { rows: [current] } = await client.query('SELECT * FROM recovery.lifecycle WHERE attempt_id=$1 FOR UPDATE', [attemptId]);
      if (current.owner !== owner || current.epoch !== epoch) return 'stale';
      const { rows: [attempt] } = await client.query('SELECT * FROM spike.attempts WHERE id=$1', [attemptId]);
      await client.query('SELECT id FROM spike.grants WHERE id=$1 FOR UPDATE', [attempt.grant_id]);
      const grant = await client.query(`SELECT 1 FROM spike.grants WHERE id=$1 AND project_id=$2 AND actor_id=$3
        AND account_id=$4 AND route=$5 AND effect='generate' AND NOT revoked AND expires_at>clock_timestamp()
        AND allowed_fingerprints @> $6::jsonb AND budget_policy='count_only_unknown_cost'`,
        [attempt.grant_id, attempt.project_id, attempt.actor_id, d.account, d.route, JSON.stringify([attempt.request_fingerprint])]);
      const { rows: [window] } = await client.query('SELECT replay_safe AND replay_until>clock_timestamp() AS safe FROM recovery.dispatch WHERE attempt_id=$1', [attemptId]);
      const reason = current.cancel_requested ? (current.remote_state === 'not_dispatched' ? 'CANCEL_PREVENTED' : 'CANCEL_UNKNOWN') :
        current.paused ? 'PAUSED' : grant.rowCount !== 1 ? 'GRANT_UNAVAILABLE' :
        current.submit_count >= 2 ? 'SUBMIT_LIMIT' : current.submit_count > 0 && !window.safe ? 'REPLAY_UNSAFE' : null;
      if (reason) {
        await client.query(`UPDATE recovery.lifecycle SET hold=$2, cancellation=CASE WHEN cancel_requested THEN $3 ELSE cancellation END WHERE attempt_id=$1`,
          [attemptId, reason, reason === 'CANCEL_PREVENTED' ? 'prevented' : 'unresolved']);
        return reason;
      }
      // Authorization linearizes here. No DB lock spans the HTTP operation.
      await client.query("UPDATE recovery.lifecycle SET remote_state='unknown', hold=NULL, submit_count=submit_count+1 WHERE attempt_id=$1", [attemptId]);
      return null;
    });
    if (blocked) return finish(blocked);
    await checkpoint('intent');
    if (!await owns()) return finish('stale');
    try { remote = await request(d, '/submit', 'POST'); assert(remote); }
    catch {
      await e.pool.query(`UPDATE recovery.lifecycle SET hold='ACCEPTANCE_UNKNOWN' WHERE attempt_id=$1 AND owner=$2 AND epoch=$3`, [attemptId, owner, epoch]);
      await checkpoint('unknown'); return finish('unknown');
    }
  }
  await checkpoint('reply');
  await e.pool.query('INSERT INTO recovery.observations(attempt_id,epoch,receipt) VALUES ($1,$2,$3)', [attemptId, epoch, remote]);
  if (!await owns()) return finish('stale');
  const cancellation = (await e.pool.query('SELECT cancel_requested FROM recovery.lifecycle WHERE attempt_id=$1', [attemptId])).rows[0].cancel_requested;
  if (cancellation) {
    const id = remote.id;
    try { remote = await request(d, `/jobs/${id}/cancel`, 'POST'); }
    catch { return hold('CANCEL_UNRESOLVED'); }
    if (!remote || remote.id !== id) return hold('CANCEL_UNRESOLVED');
    await e.pool.query('INSERT INTO recovery.observations(attempt_id,epoch,receipt) VALUES ($1,$2,$3)', [attemptId, epoch, remote]);
  }
  const update = await e.pool.query(`UPDATE recovery.lifecycle SET remote_id=$4,
    remote_state=CASE WHEN remote_state IN ('succeeded','cancelled') THEN remote_state ELSE $5 END,
    hold=NULL, cancellation=CASE WHEN cancel_requested THEN $6 ELSE cancellation END
    WHERE attempt_id=$1 AND owner=$2 AND epoch=$3`, [attemptId, owner, epoch, remote.id, remote.state,
      cancellation ? remote.state === 'cancelled' ? 'confirmed' : remote.state === 'succeeded' ? 'too_late' : 'unresolved' : 'unresolved']);
  if (!update.rowCount) return finish('stale');
  if (remote.state !== 'succeeded') return finish('accepted');
  try {
    for (const output of remote.outputs) {
      if (!await owns()) return finish('stale');
      const claim = await transaction(e, async client => {
        const { rows: [current] } = await client.query('SELECT * FROM recovery.lifecycle WHERE attempt_id=$1 FOR UPDATE', [attemptId]);
        if (current.owner !== owner || current.epoch !== epoch) return 'stale';
        await client.query(`INSERT INTO recovery.imports(attempt_id,remote_id,output_id,sha256,size)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (attempt_id,output_id) DO NOTHING`, [attemptId, remote!.id, output.id, output.sha256, output.size]);
        const { rows: [saved] } = await client.query('SELECT * FROM recovery.imports WHERE attempt_id=$1 AND output_id=$2', [attemptId, output.id]);
        return saved.remote_id === remote!.id && saved.sha256 === output.sha256 && saved.size === output.size ? 'claimed' : 'OUTPUT_CONFLICT';
      });
      if (claim === 'stale') return finish('stale');
      if (claim !== 'claimed') return hold(claim);
      await publishBytes(policy.storage, d, remote.id, output);
      await checkpoint('bytes');
      const published = await transaction(e, async client => {
        const { rows: [current] } = await client.query('SELECT * FROM recovery.lifecycle WHERE attempt_id=$1 FOR UPDATE', [attemptId]);
        if (current.owner !== owner || current.epoch !== epoch) return false;
        await client.query(`INSERT INTO recovery.takes VALUES ($1,$2,$3,$4,$5) ON CONFLICT (attempt_id,output_id) DO NOTHING`,
          [randomUUID(), attemptId, remote!.id, output.id, output.sha256]);
        await client.query('UPDATE recovery.imports SET published=true WHERE attempt_id=$1 AND output_id=$2', [attemptId, output.id]);
        return true;
      });
      if (!published) return finish('stale');
      await checkpoint('import');
    }
  } catch { return hold('IMPORT_PENDING'); }
  const ready = await e.pool.query('UPDATE recovery.lifecycle SET available=true WHERE attempt_id=$1 AND owner=$2 AND epoch=$3', [attemptId, owner, epoch]);
  return finish(ready.rowCount ? 'ready' : 'stale');
}
