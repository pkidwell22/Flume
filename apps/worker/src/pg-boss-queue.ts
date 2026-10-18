import type { Db, PgBoss } from 'pg-boss';
import type { Activation, PhaseQueue } from './ports.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !uuid.test(id)) throw new Error('INVALID_ATTEMPT_ID');
}
/** Manual fetch/ack: boss.work() auto-ack cannot fence a superseded activation.
 * Activation retry_count semantics pinned to pg-boss 12.11.1, promoted from spike 01.
 * The caller owns boss startup, migrations, supervision and shutdown; never drops data. */
export class PgBossPhaseQueue implements PhaseQueue {
  readonly queueName: string;
  readonly schema: string;
  constructor(private readonly boss: PgBoss, options: { schema?: string; queueName?: string } = {}) {
    this.schema = options.schema ?? 'flume_queue'; this.queueName = options.queueName ?? 'flume-generation-v1';
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(this.schema)) throw new Error('INVALID_QUEUE_SCHEMA');
    if (!/^[a-z][a-z0-9_-]{0,62}$/.test(this.queueName)) throw new Error('INVALID_QUEUE_NAME');
  }
  async enqueue(tx: Db, attemptId: string, delaySeconds = 0): Promise<string> {
    assertId(attemptId);
    if (!Number.isFinite(delaySeconds) || delaySeconds < 0 || delaySeconds > 3600) throw new Error('INVALID_QUEUE_DELAY');
    const id = await this.boss.send(this.queueName, { version: 1, attemptId }, {
      db: tx, startAfter: delaySeconds, retryLimit: 2, retryDelay: 1, retryBackoff: true,
      expireInSeconds: 120, retentionSeconds: 86400, deleteAfterSeconds: 86400,
    });
    if (!id) throw new Error('QUEUE_ENQUEUE_REJECTED');
    return id;
  }
  async fetch(): Promise<Activation | null> {
    const [job] = await this.boss.fetch<unknown>(this.queueName, { includeMetadata: true, batchSize: 1 });
    if (!job) return null;
    const data = job.data as Record<string, unknown> | null;
    if (!data || data.version !== 1 || Object.keys(data).sort().join(',') !== 'attemptId,version') throw new Error('INVALID_QUEUE_PAYLOAD');
    assertId(data.attemptId);
    if (!Number.isSafeInteger(job.retryCount) || job.retryCount < 0) throw new Error('INVALID_ACTIVATION');
    return { jobId: job.id, retryCount: job.retryCount, attemptId: data.attemptId };
  }
  async lock(tx: Db, activation: Activation): Promise<boolean> {
    // Schema is a constructor-validated SQL identifier; all external values are bound.
    const { rows: [row] } = await tx.executeSql(
      `SELECT state,retry_count,data FROM "${this.schema}".job WHERE name=$1 AND id=$2 FOR UPDATE`,
      [this.queueName, activation.jobId]);
    return row?.state === 'active' && row.retry_count === activation.retryCount &&
      row.data?.version === 1 && row.data?.attemptId === activation.attemptId;
  }
  async complete(tx: Db, activation: Activation): Promise<void> {
    if (!await this.lock(tx, activation)) throw new Error('STALE_ACTIVATION');
    await this.boss.complete(this.queueName, activation.jobId, null, { db: tx });
    const { rows: [row] } = await tx.executeSql(`SELECT state FROM "${this.schema}".job WHERE name=$1 AND id=$2`, [this.queueName, activation.jobId]);
    if (row?.state !== 'completed') throw new Error('QUEUE_ACK_REJECTED');
  }
}
