// Contract fixture only. The server owns real migrations, authority and asset/take records.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
export function freshAttempt() {
  const body = JSON.stringify({ model: 'fixture-only', prompt: 'SYNTHETIC TEST', generateAudio: false, seed: 0 });
  return { id: randomUUID(), projectId: randomUUID(), shotId: randomUUID(), shotRevision: 1,
    request: { provider: 'fixture', scope: 'isolated-fixture-account/adapter-v1', modelId: 'fixture-only',
      body, bodySha256: createHash('sha256').update(body).digest('hex') },
    version: 0, epoch: 0, owner: null, phase: 'submit', status: 'queued', recoverPhase: null,
    dispatch: null, receipt: null, remoteState: 'not_dispatched', outputs: [], imports: {}, polls: 0, issue: null };
}
export async function initializeStore(pool) {
  await pool.query(`CREATE SCHEMA flume;
    CREATE TABLE flume.worker_attempt (id uuid PRIMARY KEY, version integer NOT NULL, state jsonb NOT NULL, approved boolean NOT NULL DEFAULT true);
    CREATE TABLE flume.worker_observation (attempt_id uuid NOT NULL, receipt jsonb NOT NULL, UNIQUE(attempt_id,receipt));
    CREATE TABLE flume.fixture_take (id uuid PRIMARY KEY, attempt_id uuid NOT NULL, output_id text NOT NULL, remote_id text NOT NULL,
      owned jsonb NOT NULL, UNIQUE(attempt_id,output_id));
    CREATE TABLE flume.fixture_selection (shot_id uuid PRIMARY KEY, selected text NOT NULL DEFAULT 'human-existing-selection');`);
}
export function makeStore(pool) {
  const store = {
    async transaction(action) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx = {
          executeSql: (text, values) => client.query(text, values),
          async loadAttempt(id) { return (await client.query('SELECT state FROM flume.worker_attempt WHERE id=$1 FOR UPDATE', [id])).rows[0]?.state ?? null; },
          async saveAttempt(state, expectedVersion) {
            assert.equal(state.version, expectedVersion + 1);
            const saved = await client.query('UPDATE flume.worker_attempt SET state=$2,version=$3 WHERE id=$1 AND version=$4', [state.id, state, state.version, expectedVersion]);
            assert.equal(saved.rowCount, 1, 'checkpoint compare-and-set');
          },
          async authorizeDispatch(state) {
            const row = (await client.query('SELECT approved FROM flume.worker_attempt WHERE id=$1 FOR UPDATE', [state.id])).rows[0];
            return row.approved ? { allowed: true } : { allowed: false, issue: { code: 'APPROVAL_UNAVAILABLE', message: 'Approval is no longer valid.' } };
          },
          async receipts(id) { return (await client.query('SELECT receipt FROM flume.worker_observation WHERE attempt_id=$1', [id])).rows.map(r => r.receipt); },
          async publishTake(state, output, owned) {
            const remote = state.receipt.providerJobId;
            await client.query(`INSERT INTO flume.fixture_take VALUES ($1,$2,$3,$4,$5) ON CONFLICT(attempt_id,output_id) DO NOTHING`, [randomUUID(), state.id, output.outputId, remote, owned]);
            const row = (await client.query('SELECT * FROM flume.fixture_take WHERE attempt_id=$1 AND output_id=$2', [state.id, output.outputId])).rows[0];
            assert.equal(row.remote_id, remote); assert.deepEqual(row.owned, owned);
            return { takeId: row.id, assetId: owned.assetId };
          },
        };
        const value = await action(tx); await client.query('COMMIT'); return value;
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    },
    async observeReceipt(id, intent, receipt) {
      await store.transaction(async tx => {
        const state = await tx.loadAttempt(id); assert.deepEqual(state.dispatch, intent);
        assert.equal(receipt.provider, intent.request.provider); assert.equal(receipt.scope, intent.request.scope);
        assert.equal(receipt.modelId, intent.request.modelId);
        await tx.executeSql('INSERT INTO flume.worker_observation VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, receipt]);
      });
    },
    async read(id) { return (await pool.query('SELECT state FROM flume.worker_attempt WHERE id=$1', [id])).rows[0].state; },
    async seed(state) {
      await pool.query('INSERT INTO flume.worker_attempt VALUES ($1,$2,$3,true)', [state.id, state.version, state]);
      await pool.query('INSERT INTO flume.fixture_selection(shot_id) VALUES($1)', [state.shotId]);
    },
  };
  return store;
}
