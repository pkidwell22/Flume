import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import pg, { type PoolClient } from 'pg';
import type { Experiment } from '../src/database.js';
import { hash, requestSchema, type Command, type Context } from '../src/contracts.js';

export async function seed(experiment: Experiment) {
  const context: Context = { projectId: randomUUID(), actorId: randomUUID() };
  const request = requestSchema.parse({ version: 1, projectId: context.projectId, shotId: randomUUID(), draftRevision: 1,
    route: 'fixture/video-v1', accountId: randomUUID(), spec: { prompt: 'synthetic shot; no provider call', seed: 0, audio: false,
      firstFrame: { assetRevisionId: randomUUID(), sha256: 'a'.repeat(64) },
      lastFrame: { assetRevisionId: randomUUID(), sha256: 'b'.repeat(64) } },
    envelope: { version: 1, adapterVersion: 'fixture-1', body: '{"fixture":true,"seed":0,"audio":false}' } });
  const command: Command = { commandId: randomUUID(), reviewId: randomUUID(), grantId: randomUUID(), requestFingerprint: hash(request) };
  await experiment.pool.query('INSERT INTO spike.drafts VALUES ($1, $2, 1, $3)', [request.shotId, context.projectId, request.spec.prompt]);
  await experiment.pool.query(`INSERT INTO spike.reviews (id, project_id, shot_id, draft_revision, request, request_fingerprint)
    VALUES ($1, $2, $3, 1, $4, $5)`, [command.reviewId, context.projectId, request.shotId, request, command.requestFingerprint]);
  await experiment.pool.query(`INSERT INTO spike.grants
    (id, project_id, actor_id, approving_principal, route, account_id, effect, allowed_fingerprints,
     expires_at, budget_policy, attempt_limit, reserved_count)
    VALUES ($1, $2, $3, $4, $5, $6, 'generate', $7, now() + interval '1 hour', 'count_only_unknown_cost', 1, 0)`,
    [command.grantId, context.projectId, context.actorId, randomUUID(), request.route, request.accountId, JSON.stringify([command.requestFingerprint])]);
  return { context, request, command };
}
export type Fixture = Awaited<ReturnType<typeof seed>>;

export async function relatedReview(experiment: Experiment, original: Fixture): Promise<Fixture> {
  const request = requestSchema.parse({ ...original.request, shotId: randomUUID() });
  const command = { ...original.command, commandId: randomUUID(), reviewId: randomUUID(), requestFingerprint: hash(request) };
  await experiment.pool.query('INSERT INTO spike.drafts VALUES ($1, $2, 1, $3)', [request.shotId, original.context.projectId, request.spec.prompt]);
  await experiment.pool.query(`INSERT INTO spike.reviews (id, project_id, shot_id, draft_revision, request, request_fingerprint)
    VALUES ($1, $2, $3, 1, $4, $5)`, [command.reviewId, original.context.projectId, request.shotId, request, command.requestFingerprint]);
  await experiment.pool.query('UPDATE spike.grants SET allowed_fingerprints=allowed_fingerprints || $2::jsonb WHERE id=$1',
    [command.grantId, JSON.stringify([command.requestFingerprint])]);
  return { context: original.context, request, command };
}

// All participants have a distinct real backend and an open transaction before
// anyone can acquire a command/review lock. No sleeps or timing guesses.
export function barrier(participants: number) {
  const pids = new Set<number>();
  const transactions = new Set<string>();
  let release!: () => void;
  let fail!: (error: Error) => void;
  const gate = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
  const timer = setTimeout(() => fail(new Error('transaction barrier timed out')), 4000);
  return {
    async arrive(client: PoolClient) {
      const { rows: [identity] } = await client.query('SELECT pg_backend_pid() as pid, txid_current()::text as xid');
      pids.add(identity.pid);
      transactions.add(identity.xid);
      if (pids.size === participants) { clearTimeout(timer); release(); }
      await gate;
    },
    verify() {
      assert.equal(pids.size, participants, 'distinct simultaneous connections');
      assert.equal(transactions.size, participants, 'distinct simultaneous transactions');
    },
  };
}

// New client, not the mutating connection or a reused pool transaction.
export async function snapshot(experiment: Experiment, fixture: Fixture) {
  const client = new pg.Client(experiment.config);
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: attempts } = await client.query('SELECT * FROM spike.attempts WHERE project_id=$1', [fixture.context.projectId]);
    const { rows: reviews } = await client.query('SELECT * FROM spike.reviews WHERE project_id=$1', [fixture.context.projectId]);
    const { rows: reservations } = await client.query('SELECT * FROM spike.reservations WHERE grant_id=$1', [fixture.command.grantId]);
    const { rows: receipts } = await client.query('SELECT * FROM spike.receipts WHERE project_id=$1', [fixture.context.projectId]);
    const { rows: jobs } = await client.query(`SELECT id, data, state FROM pgboss.job WHERE data->>'attemptId' IN
      (SELECT id::text FROM spike.attempts WHERE project_id=$1)`, [fixture.context.projectId]);
    const { rows: [grant] } = await client.query('SELECT reserved_count FROM spike.grants WHERE id=$1', [fixture.command.grantId]);
    const { rows: allJobs } = await client.query('SELECT id FROM pgboss.job ORDER BY id');
    await client.query('COMMIT');
    return { allJobIds: allJobs.map(row => row.id as string), attempts, reviews, reservations, receipts, jobs, counts: { attempts: attempts.length,
      consumed: reviews.filter(row => row.consumed_attempt_id !== null).length,
      reservations: reservations.length, receipts: receipts.length, jobs: jobs.length, reserved: grant.reserved_count } };
  } finally { await client.end(); }
}
