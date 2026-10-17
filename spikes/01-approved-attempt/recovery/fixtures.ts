import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

import { accept } from '../src/accept.js';
import { queue, type Experiment } from '../src/database.js';
import { seed } from '../test/fixtures.js';
import { startSimulator, type Simulator } from './simulator.js';
import type { Policy } from './engine.js';

// Register EVERY cleanup immediately; settle them independently, even on failure.
export async function resources(t: { after: (fn: () => Promise<void>) => void }, experiment: Experiment,
  faults: { afterProvider?: (sim: Simulator) => Promise<void>; afterStorage?: (storage: string) => Promise<void>; cleanupFault?: () => Promise<void> } = {}) {
  const cleanup: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    const errors = [];
    for (const close of cleanup.reverse()) { try { await close(); } catch (error) { errors.push(error); } }
    assert.deepEqual(errors, []);
  });
  const sim = await startSimulator(); cleanup.push(() => sim.close());
  await faults.afterProvider?.(sim);
  // The outer owned-cluster cleanup also covers whole-test-process interruption.
  const storage = await mkdtemp(path.join(path.dirname(process.env.SPIKE_DATA_DIRECTORY!), 'recovery-'));
  cleanup.push(async () => { await rm(storage, { recursive: true }); await assert.rejects(() => lstat(storage), { code: 'ENOENT' });
    console.log('CLEANUP verified: owned simulation bytes removed'); });
  if (faults.cleanupFault) cleanup.push(faults.cleanupFault);
  await faults.afterStorage?.(storage);
  const fixture = await seed(experiment);
  const receipt = await accept(experiment, fixture.context, fixture.command);
  await experiment.pool.query('INSERT INTO recovery.lifecycle(attempt_id) VALUES ($1)', [receipt.attemptId]);
  await experiment.pool.query('INSERT INTO recovery.selections VALUES ($1,$2)', [fixture.request.shotId, 'human-existing-selection']);
  const policy: Policy = { origin: sim.origin, storage, lookup: false, replaySafe: true, replaySeconds: 60, adapter: 'fixture-1' };
  const workers: number[] = [];
  function launch(pause = '', overrides: Partial<Policy> = {}) {
    const child = fork(new URL('./worker.js', import.meta.url), [JSON.stringify({ ...policy, ...overrides }), pause], { silent: true });
    const exited = once(child, 'exit');
    const messages: any[] = []; let logs = '';
    child.on('message', value => messages.push(value));
    child.stdout!.on('data', value => { logs += value; }); child.stderr!.on('data', value => { logs += value; });
    const stop = async () => {
      const running = child.exitCode === null && child.signalCode === null;
      if (running) child.kill('SIGKILL');
      const result = await exited;
      if (running) { assert.deepEqual(result, [null, 'SIGKILL']); console.log(`FAULT verified: worker pid=${child.pid} SIGKILL at ${pause || 'cleanup'}`); }
      assert.throws(() => process.kill(child.pid!, 0), (e: any) => e.code === 'ESRCH');
    };
    cleanup.push(stop);
    assert(child.pid); workers.push(child.pid);
    return { child, messages, stop, resume() { child.send('continue'); },
      async point(name: string) {
        const deadline = Date.now() + 8000;
        while (!messages.some(m => m.point === name)) {
          assert(child.exitCode === null && child.signalCode === null, `worker exited before ${name}: ${logs}`);
          assert(Date.now() < deadline, `checkpoint timeout ${name}: ${logs}`);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      },
      async done() {
        let timer: NodeJS.Timeout | undefined;
        try {
          const result = await Promise.race([exited, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`worker timeout: ${logs}`)), 10000);
          })]); assert.deepEqual(result, [0, null], logs); return messages.find(m => 'result' in m)?.result;
        } finally { clearTimeout(timer); }
      } };
  }
  async function retry() {
    // Deterministic recovery command, using real pg-boss state transitions.
    await experiment.boss.fail(queue, receipt.jobId);
    await experiment.boss.retry(queue, receipt.jobId);
    assert.equal((await experiment.pool.query('SELECT state FROM pgboss.job WHERE id=$1', [receipt.jobId])).rows[0].state, 'retry');
  }
  async function duplicate() {
    const id = await experiment.boss.send(queue, { version: 1, attemptId: receipt.attemptId }, { retryLimit: 0 }); assert(id); return id;
  }
  async function state() {
    const client = new pg.Client(experiment.config);
    try {
      await client.connect(); await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result: Record<string, any[]> = {};
      for (const table of ['lifecycle', 'dispatch', 'observations', 'deliveries', 'imports', 'takes']) {
        result[table] = (await client.query(`SELECT * FROM recovery.${table} WHERE attempt_id=$1`, [receipt.attemptId])).rows;
      }
      result.jobs = (await client.query("SELECT id,state,data FROM pgboss.job WHERE data->>'attemptId'=$1", [receipt.attemptId])).rows;
      result.selection = (await client.query('SELECT * FROM recovery.selections WHERE shot_id=$1', [fixture.request.shotId])).rows;
      await client.query('COMMIT'); return result;
    } finally { await client.end(); }
  }
  return { sim, policy, storage, fixture, receipt, launch, retry, duplicate, state, workers,
    files: () => readdir(storage), bytes: (file: string) => readFile(path.join(storage, file)) };
}
