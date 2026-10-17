import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { queue, type Experiment } from './database.js';
import { commandSchema, contextSchema, hash, requestSchema, type Receipt } from './contracts.js';

import type { PoolClient } from 'pg';

// Test-only scheduling/fault seams; the default path always uses real pg-boss.
export type Hooks = {
  beforeLock?: (client: PoolClient) => Promise<void>;
  enqueue?: (send: (jobId?: string) => Promise<string | null>, attemptId: string) => Promise<string | null>;
};

export async function accept(experiment: Experiment, rawContext: unknown, rawCommand: unknown, hooks: Hooks = {}): Promise<Receipt> {
  const context = contextSchema.parse(rawContext);
  const command = commandSchema.parse(rawCommand);
  // An explicitly checked-out client is shared by Drizzle's real transaction
  // and pg-boss's documented executeSql adapter. Never enqueue via the pool.
  const client = await experiment.pool.connect();
  try {
    return await drizzle(client).transaction(async tx => {
      await hooks.beforeLock?.(client);
      const commandFingerprint = hash(command);
      const commandScope = `${context.projectId}/${context.actorId}/${command.commandId}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${commandScope}, 0))`);
      // Accepted receipt lookup precedes mutable draft/grant checks: replay is a
      // read of prior acceptance, never a new authorization to dispatch.
      const { rows: [receipt] } = await tx.execute<{ command_fingerprint: string; attempt_id: string; job_id: string }>(sql`
        SELECT r.command_fingerprint, r.attempt_id, a.job_id FROM spike.receipts r
        JOIN spike.attempts a ON a.id=r.attempt_id
        WHERE r.project_id=${context.projectId} AND r.actor_id=${context.actorId} AND r.command_id=${command.commandId}`);
      if (receipt) {
        if (receipt.command_fingerprint !== commandFingerprint) throw new Error('COMMAND_CONFLICT');
        return { attemptId: receipt.attempt_id, jobId: receipt.job_id };
      }
      const { rows: [review] } = await tx.execute(sql`
        SELECT * FROM spike.reviews WHERE id=${command.reviewId} AND project_id=${context.projectId} FOR UPDATE`);
      if (!review) throw new Error('REVIEW_NOT_FOUND');
      if (review.consumed_attempt_id !== null) throw new Error('REVIEW_ALREADY_CONSUMED');
      const request = requestSchema.parse(review.request);
      if (request.projectId !== context.projectId || request.shotId !== review.shot_id ||
          review.request_fingerprint !== command.requestFingerprint || hash(request) !== command.requestFingerprint) {
        throw new Error('REQUEST_CONFLICT');
      }
      const { rows: [draft] } = await tx.execute(sql`
        SELECT * FROM spike.drafts WHERE id=${request.shotId} AND project_id=${context.projectId} FOR UPDATE`);
      if (!draft || draft.revision !== request.draftRevision || review.draft_revision !== request.draftRevision) {
        throw new Error('STALE_REVIEW');
      }
      // Lock the grant first, then evaluate wall-clock expiry in a new statement.
      // Transaction-start now() is not a dispatch/acceptance-time expiry check.
      await tx.execute(sql`SELECT id FROM spike.grants WHERE id=${command.grantId} FOR UPDATE`);
      const reservation = await tx.execute(sql`UPDATE spike.grants SET reserved_count=reserved_count+1
        WHERE id=${command.grantId} AND project_id=${context.projectId} AND actor_id=${context.actorId}
        AND route=${request.route} AND account_id=${request.accountId} AND effect='generate'
        AND allowed_fingerprints @> ${JSON.stringify([command.requestFingerprint])}::jsonb
        AND budget_policy='count_only_unknown_cost' AND NOT revoked
        AND expires_at > clock_timestamp() AND reserved_count < attempt_limit RETURNING id`);
      if (reservation.rowCount !== 1) throw new Error('GRANT_UNAVAILABLE');
      const attemptId = randomUUID();
      await tx.execute(sql`INSERT INTO spike.attempts
        (id, review_id, grant_id, project_id, actor_id, request, request_fingerprint, job_id)
        VALUES (${attemptId}, ${command.reviewId}, ${command.grantId}, ${context.projectId}, ${context.actorId},
          ${JSON.stringify(request)}::jsonb, ${command.requestFingerprint}, ${attemptId})`);
      await tx.execute(sql`UPDATE spike.reviews SET consumed_attempt_id=${attemptId} WHERE id=${command.reviewId}`);
      await tx.execute(sql`INSERT INTO spike.reservations VALUES (${attemptId}, ${command.grantId}, 1)`);
      await tx.execute(sql`INSERT INTO spike.receipts VALUES
        (${context.projectId}, ${context.actorId}, ${command.commandId}, ${hash(command)}, ${attemptId})`);
      const send = (jobId: string = attemptId) => experiment.boss.send(queue, { version: 1, attemptId }, { id: jobId, retryLimit: 0,
        db: { executeSql: (text, values) => client.query(text, values) } });
      const jobId = hooks.enqueue ? await hooks.enqueue(send, attemptId) : await send();
      if (jobId === null) throw new Error('ENQUEUE_SUPPRESSED');
      if (jobId !== attemptId) throw new Error('ENQUEUE_ID_MISMATCH');
      return { attemptId, jobId: attemptId };
    });
  } finally { client.release(); }
}
