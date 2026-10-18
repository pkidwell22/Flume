import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { before, after, afterEach, test } from 'node:test';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import * as worker from '../dist/src/index.js';
import { initializeStore, makeStore, freshAttempt } from './fixture-store.mjs';
import { fixture, barrier } from './fixture-provider.mjs';
let pool, boss, queue, store;
const queueName = 'flume-generation-v1';
const errors = [];
before(async () => {
  const config = JSON.parse(process.env.FLUME_WORKER_TEST_CONFIG || 'null');
  assert(config && /^flume_worker_[a-f0-9]{16}$/.test(config.database), 'owned runner required');
  const directory = process.env.FLUME_WORKER_TEST_DIRECTORY;
  assert.equal(await realpath(directory), directory);
  const marker = JSON.parse(await readFile(path.join(directory, '../.owner'), 'utf8'));
  assert.equal(marker.dataDirectory, directory); assert.equal(marker.uid, process.getuid());
  assert.equal(config.host, path.join(marker.root, 's'));
  pool = new pg.Pool({ ...config, max: 12, options: '-c search_path=flume -c statement_timeout=10000 -c lock_timeout=5000' });
  const identity = (await pool.query(`SELECT current_database() AS db,current_setting('data_directory') AS dir,current_setting('listen_addresses') AS listen`)).rows[0];
  assert.equal(identity.db, config.database); assert.equal(identity.dir, directory); assert.equal(identity.listen, '');
  await initializeStore(pool);
  boss = new PgBoss({ db: { executeSql: (text, values) => pool.query(text, values) }, schema: 'flume_queue', supervise: false, schedule: false });
  boss.on('error', error => errors.push(error)); await boss.start();
  await boss.createQueue(queueName, { policy: 'standard', retryLimit: 2, retryDelay: 0, expireInSeconds: 60, retentionSeconds: 3600, deleteAfterSeconds: 3600 });
  queue = new worker.PgBossPhaseQueue(boss, { schema: 'flume_queue', queueName }); store = makeStore(pool);
});
after(async () => { try { await boss?.stop({ graceful: true, timeout: 5000 }); } finally { await pool?.end(); } assert.deepEqual(errors, []); });

afterEach(async () => { await pool?.query("UPDATE flume_queue.job SET state='cancelled' WHERE state IN ('created','retry','active')"); });

test('enqueue uses the callers transaction; rollback leaves no job', async () => {
  let id;
  await assert.rejects(() => store.transaction(async tx => {
    id = await queue.enqueue(tx, freshAttempt().id);
    assert.equal(typeof id, 'string', 'transactional enqueue must return a real pg-boss ID');
    assert.equal((await pool.query('SELECT id FROM flume_queue.job WHERE id=$1', [id])).rowCount, 0);
    throw new Error('rollback');
  }), /rollback/);
  assert.equal((await pool.query('SELECT id FROM flume_queue.job WHERE id=$1', [id])).rowCount, 0);
  const attempt = freshAttempt();
  id = await store.transaction(tx => queue.enqueue(tx, attempt.id));
  const activation = await queue.fetch();
  assert.deepEqual(activation, { jobId: id, attemptId: attempt.id, retryCount: 0 });
  await store.transaction(async tx => { assert.equal(await queue.lock(tx, activation), true); await queue.complete(tx, activation); });
  assert.equal((await boss.findJobs(queueName, { id }))[0].state, 'completed');
  assert.equal(await store.transaction(tx => queue.lock(tx, activation)), false);
});

async function accept(f) {
  const attempt = freshAttempt(); await store.seed(attempt);
  await store.transaction(tx => queue.enqueue(tx, attempt.id));
  return { attempt, deps: { store, queue, provider: f.provider, media: f.media } };
}
test('durable exact dispatch intent precedes the only POST, then records a receipt without advertising media', async t => {
  const f = await fixture(t); const { attempt, deps } = await accept(f);
  f.beforeSubmit = async intent => {
    const saved = await store.read(attempt.id);
    assert.deepEqual(saved.dispatch, intent); assert.equal(saved.status, 'acceptance_unknown');
    assert.equal(intent.key, attempt.id); assert.equal(intent.request.body, attempt.request.body);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM flume.fixture_take WHERE attempt_id=$1', [attempt.id])).rows[0].n, 0);
  };
  assert.equal(await worker.runDelivery(deps, { pollDelaySeconds: 0 }), 'running');
  const saved = await store.read(attempt.id);
  assert.equal(f.posts.length, 1); assert.equal(f.serverError, undefined);
  assert.equal(saved.phase, 'poll'); assert.equal(saved.receipt.providerJobId, f.jobs.get(attempt.id).providerJobId);
  assert.equal(saved.remoteState, 'running'); assert.deepEqual(saved.imports, {});
  // Retire the successor so this tracer remains isolated from later cases.
  await pool.query("UPDATE flume_queue.job SET state='cancelled' WHERE data->>'attemptId'=$1 AND state='created'", [attempt.id]);
});

test('remote success, manifest retrieval and owned import are distinct phases; duplicate delivery never selects', async t => {
  const f = await fixture(t); const { attempt, deps } = await accept(f);
  assert.equal(await worker.runDelivery(deps, { pollDelaySeconds: 0 }), 'running');
  assert.equal(await worker.runDelivery(deps, { pollDelaySeconds: 0 }), 'retrieving');
  let s = await store.read(attempt.id); assert.equal(s.remoteState, 'succeeded'); assert.equal(s.phase, 'retrieve');
  assert.equal(f.imports, 0); assert.equal((await pool.query('SELECT * FROM flume.fixture_take WHERE attempt_id=$1', [attempt.id])).rowCount, 0);
  assert.equal(await worker.runDelivery(deps), 'retrieving');
  s = await store.read(attempt.id); assert.equal(s.phase, 'import'); assert.equal(s.outputs.length, 1); assert.equal(f.imports, 0);
  assert.equal(await worker.runDelivery(deps), 'ready');
  const takes = (await pool.query('SELECT * FROM flume.fixture_take WHERE attempt_id=$1', [attempt.id])).rows;
  assert.equal(takes.length, 1); assert.equal(takes[0].remote_id, s.receipt.providerJobId);
  assert.equal((await readFile(path.join(f.root, takes[0].owned.storageKey))).length, takes[0].owned.byteLength);
  await store.transaction(tx => queue.enqueue(tx, attempt.id)); assert.equal(await worker.runDelivery(deps), 'ready');
  assert.deepEqual((await pool.query('SELECT * FROM flume.fixture_take WHERE attempt_id=$1', [attempt.id])).rows, takes);
  assert.equal(f.imports, 1); assert.equal(f.posts.length, 1);
  assert.equal((await pool.query('SELECT selected FROM flume.fixture_selection WHERE shot_id=$1', [attempt.shotId])).rows[0].selected, 'human-existing-selection');
  assert.equal(await worker.runDelivery(deps), 'idle');
});

test('lost response stays unknown without safe lookup; explicit read-only recovery keeps one identity and one POST', async t => {
  const f = await fixture(t); f.drop = true; const { attempt, deps } = await accept(f);
  assert.equal(await worker.runDelivery(deps), 'acceptance_unknown');
  const unknown = await store.read(attempt.id);
  assert.equal(unknown.phase, 'hold'); assert.equal(unknown.receipt, null); assert.equal(f.jobs.size, 1);
  await store.transaction(tx => queue.enqueue(tx, attempt.id));
  assert.equal(await worker.runDelivery(deps), 'acceptance_unknown'); assert.equal(f.posts.length, 1);
  assert.equal(typeof await store.transaction(tx => worker.resumeAttempt(tx, queue, attempt.id)), 'string');
  assert.equal(await worker.runDelivery(deps), 'acceptance_unknown'); assert.equal(f.posts.length, 1);
  deps.provider = { ...f.provider, lookup: f.lookup };
  assert.equal(typeof await store.transaction(tx => worker.resumeAttempt(tx, queue, attempt.id)), 'string');
  assert.equal(await worker.runDelivery(deps, { pollDelaySeconds: 0 }), 'running');
  assert.equal((await store.read(attempt.id)).receipt.providerJobId, f.jobs.get(attempt.id).providerJobId);
  assert.deepEqual((await store.read(attempt.id)).dispatch, unknown.dispatch);
  for (let i = 0; i < 3; i++) await worker.runDelivery(deps, { pollDelaySeconds: 0 });
  assert.equal((await store.read(attempt.id)).status, 'ready'); assert.equal(f.posts.length, 1); assert.equal(f.jobs.size, 1);
});

test('account ZDR rejection is a non-resumable hold even when an adapter labels it rejected', async t => {
  const f = await fixture(t); f.blocked = true; const { attempt, deps } = await accept(f);
  deps.provider = { ...f.provider, async submit(intent, signal) { const result = await f.provider.submit(intent, signal); return { ...result, kind: 'rejected' }; } };
  assert.equal(await worker.runDelivery(deps), 'blocked');
  const saved = await store.read(attempt.id);
  assert.equal(saved.issue.code, 'zdr-violation-by-account'); assert.equal(saved.phase, 'hold'); assert.equal(saved.recoverPhase, null);
  assert.equal(await store.transaction(tx => worker.resumeAttempt(tx, queue, attempt.id)), null);
  await store.transaction(tx => queue.enqueue(tx, attempt.id)); assert.equal(await worker.runDelivery(deps), 'blocked');
  assert.equal(f.posts.length, 1); assert.equal(f.jobs.size, 0); assert.deepEqual(saved.imports, {});
});

async function retryActivation(activation) {
  await boss.fail(queueName, activation.jobId); await boss.retry(queueName, activation.jobId);
  // pg-boss 12 preserves start_after on explicit retry; respect its real backoff.
  const row = (await pool.query('SELECT state, GREATEST(0, EXTRACT(epoch FROM start_after-clock_timestamp())*1000)::float AS wait FROM flume_queue.job WHERE id=$1', [activation.jobId])).rows[0];
  assert.equal(row.state, 'retry'); assert(row.wait < 5000);
  await new Promise(resolve => setTimeout(resolve, Math.ceil(row.wait) + 10));
}
async function finish(deps, count = 4) {
  for (let i = 0; i < count; i++) await worker.runDelivery(deps, { pollDelaySeconds: 0 });
}

test('obsolete fetched activation cannot claim a new activation or perform provider work', async t => {
  const f = await fixture(t); const { attempt, deps } = await accept(f);
  const old = await queue.fetch(); await retryActivation(old); const current = await queue.fetch();
  assert.equal(current.retryCount, old.retryCount + 1);
  assert.equal(await worker.runActivation(deps, old), 'stale');
  assert.equal((await store.read(attempt.id)).epoch, 0); assert.equal(f.posts.length, 0);
  assert.equal(await worker.runActivation(deps, current, { pollDelaySeconds: 0 }), 'running');
  await finish(deps, 3); assert.equal((await store.read(attempt.id)).status, 'ready');
});

test('fetch-to-claim gap fences stale checkpoint and acknowledgement but retains late receipt', { timeout: 10000 }, async t => {
  const f = await fixture(t); const { attempt, deps } = await accept(f);
  const gate = barrier(); t.after(gate.release); f.beforeReply = gate.pause;
  const old = await queue.fetch(); const pending = worker.runActivation(deps, old, { pollDelaySeconds: 0 });
  await gate.hit; const before = await store.read(attempt.id);
  await retryActivation(old); const newer = await queue.fetch(); assert.equal(newer.retryCount, old.retryCount + 1);
  gate.release(); assert.equal(await pending, 'stale');
  assert.deepEqual(await store.read(attempt.id), before, 'stale owner must not checkpoint in new fetch-to-claim gap');
  assert.equal((await boss.findJobs(queueName, { id: old.jobId }))[0].state, 'active');
  assert.equal((await pool.query('SELECT * FROM flume.worker_observation WHERE attempt_id=$1', [attempt.id])).rowCount, 1);
  assert.equal(await worker.runActivation(deps, newer, { pollDelaySeconds: 0 }), 'running');
  await finish(deps, 3); assert.equal(f.posts.length, 1); assert.equal((await store.read(attempt.id)).status, 'ready');
});

test('stale media owner cannot publish before the current importer, even with bytes already owned', { timeout: 10000 }, async t => {
  const f = await fixture(t); const { attempt, deps } = await accept(f); await finish(deps, 3);
  const oldGate = barrier(), newGate = barrier(); t.after(() => { oldGate.release(); newGate.release(); });
  f.beforeImport = async () => (f.imports === 1 ? oldGate : newGate).pause();
  const pendingOld = worker.runDelivery(deps); await oldGate.hit;
  await store.transaction(tx => queue.enqueue(tx, attempt.id));
  const pendingCurrent = worker.runDelivery(deps); await newGate.hit;
  t.after(async () => { oldGate.release(); newGate.release(); await Promise.allSettled([pendingOld, pendingCurrent]); });
  const current = await store.read(attempt.id); oldGate.release(); const oldOutcome = await pendingOld;
  assert.equal((await pool.query('SELECT * FROM flume.fixture_take WHERE attempt_id=$1', [attempt.id])).rowCount, 0, 'uniqueness alone must not hide stale publication');
  assert.equal(oldOutcome, 'stale');
  assert.deepEqual(await store.read(attempt.id), current);
  newGate.release(); assert.equal(await pendingCurrent, 'ready');
  assert.equal((await pool.query('SELECT * FROM flume.fixture_take WHERE attempt_id=$1', [attempt.id])).rowCount, 1);
  assert.equal(f.reads.filter(url => url === '/bytes').length, 1); assert.equal(f.posts.length, 1);
});

test('import-only resume after media failure preserves remote success and selection', async t => {
  const f = await fixture(t); const { attempt, deps } = await accept(f); await finish(deps, 3);
  f.failImport = true; assert.equal(await worker.runDelivery(deps), 'blocked');
  const failed = await store.read(attempt.id); assert.equal(failed.remoteState, 'succeeded'); assert.equal(failed.issue.code, 'IMPORT_PENDING');
  assert.equal((await pool.query('SELECT * FROM flume.fixture_take WHERE attempt_id=$1', [attempt.id])).rowCount, 0);
  f.failImport = false; await store.transaction(tx => worker.resumeAttempt(tx, queue, attempt.id));
  assert.equal(await worker.runDelivery(deps), 'ready'); assert.equal(f.posts.length, 1);
  assert.deepEqual((await store.read(attempt.id)).receipt, failed.receipt);
});

test('SQL publication failure rolls back take/checkpoint/ack and recovers using the same owned bytes', async t => {
  const f = await fixture(t); const { attempt, deps } = await accept(f); await finish(deps, 3);
  await pool.query(`CREATE FUNCTION flume.reject_take() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected-publication-failure'; END $$;
    CREATE TRIGGER reject_take BEFORE INSERT ON flume.fixture_take FOR EACH ROW EXECUTE FUNCTION flume.reject_take()`);
  const activation = await queue.fetch();
  try { await assert.rejects(() => worker.runActivation(deps, activation), /injected-publication-failure/); }
  finally { await pool.query('DROP TRIGGER reject_take ON flume.fixture_take; DROP FUNCTION flume.reject_take()'); }
  assert.equal((await pool.query('SELECT * FROM flume.fixture_take WHERE attempt_id=$1', [attempt.id])).rowCount, 0);
  assert.equal((await store.read(attempt.id)).phase, 'import');
  assert.equal((await boss.findJobs(queueName, { id: activation.jobId }))[0].state, 'active');
  await retryActivation(activation); assert.equal(await worker.runDelivery(deps), 'ready');
  assert.equal(f.reads.filter(url => url === '/bytes').length, 1); assert.equal(f.posts.length, 1);
});

test('approval revocation prevents first POST without silently reauthorizing', async t => {
  const f = await fixture(t); const { attempt, deps } = await accept(f);
  await pool.query('UPDATE flume.worker_attempt SET approved=false WHERE id=$1', [attempt.id]);
  assert.equal(await worker.runDelivery(deps), 'blocked'); assert.equal(f.posts.length, 0);
  assert.equal((await store.read(attempt.id)).dispatch, null);
});

test('polling budget creates a resumable hold without resubmitting', async t => {
  const f = await fixture(t); f.running = true; const { attempt, deps } = await accept(f);
  const options = { pollDelaySeconds: 0, maxPolls: 2 };
  assert.equal(await worker.runDelivery(deps, options), 'running');
  assert.equal(await worker.runDelivery(deps, options), 'running');
  assert.equal(await worker.runDelivery(deps, options), 'blocked');
  assert.equal(await worker.runDelivery(deps, options), 'idle');
  assert.equal((await store.read(attempt.id)).issue.code, 'POLL_LIMIT'); assert.equal(f.posts.length, 1);
  f.running = false; await store.transaction(tx => worker.resumeAttempt(tx, queue, attempt.id)); await finish(deps, 3);
  assert.equal((await store.read(attempt.id)).status, 'ready'); assert.equal(f.posts.length, 1);
});

test('provider deadline is bounded and receipt-free dispatch remains unknown', async t => {
  const f = await fixture(t); const { attempt, deps } = await accept(f);
  let aborted = false;
  deps.provider = { ...f.provider, async submit(_intent, signal) { await new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true })); } };
  assert.equal(await worker.runDelivery(deps, { operationTimeoutMs: 25 }), 'acceptance_unknown');
  assert.equal(aborted, true); assert.equal((await store.read(attempt.id)).receipt, null);
});


test('suppressed successor insertion rolls back checkpoint and ack, retaining acceptance evidence for recovery', async t => {
  const f = await fixture(t); const { attempt, deps } = await accept(f);
  await pool.query(`CREATE FUNCTION flume.suppress_queue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER suppress_queue BEFORE INSERT ON flume_queue.job FOR EACH ROW EXECUTE FUNCTION flume.suppress_queue()`);
  const activation = await queue.fetch();
  try { await assert.rejects(() => worker.runActivation(deps, activation, { pollDelaySeconds: 0 }), /QUEUE_ENQUEUE_REJECTED/); }
  finally { await pool.query('DROP TRIGGER suppress_queue ON flume_queue.job; DROP FUNCTION flume.suppress_queue()'); }
  const state = await store.read(attempt.id);
  assert.equal(state.phase, 'submit'); assert.equal(state.status, 'acceptance_unknown'); assert.equal(state.receipt, null);
  assert.equal((await pool.query('SELECT * FROM flume.worker_observation WHERE attempt_id=$1', [attempt.id])).rowCount, 1);
  assert.equal((await boss.findJobs(queueName, { id: activation.jobId }))[0].state, 'active');
  await retryActivation(activation); await finish(deps);
  assert.equal((await store.read(attempt.id)).status, 'ready'); assert.equal(f.posts.length, 1);
});

test('provider receipt scope and conflicting late handles never silently change durable identity', async t => {
  const f = await fixture(t); f.drop = true; const { attempt, deps } = await accept(f);
  await worker.runDelivery(deps); const unknown = await store.read(attempt.id);
  const receipt = f.jobs.get(attempt.id);
  await store.observeReceipt(attempt.id, unknown.dispatch, receipt);
  await store.observeReceipt(attempt.id, unknown.dispatch, { ...receipt, providerJobId: 'conflicting-fixture-job' });
  await store.transaction(tx => worker.resumeAttempt(tx, queue, attempt.id));
  assert.equal(await worker.runDelivery(deps), 'blocked');
  assert.equal((await store.read(attempt.id)).issue.code, 'IDENTITY_CONFLICT');
  assert.equal(f.posts.length, 1); assert.equal((await store.read(attempt.id)).receipt, null);
});

test('known missing remote job is held and never creates a replacement job', async t => {
  const f = await fixture(t); const { attempt, deps } = await accept(f); await worker.runDelivery(deps, { pollDelaySeconds: 0 });
  const original = await store.read(attempt.id);
  deps.provider = { ...f.provider, async status() { return { kind: 'unavailable', issue: { code: 'REMOTE_NOT_FOUND', message: 'Provider job could not be found.' } }; } };
  assert.equal(await worker.runDelivery(deps), 'blocked');
  await store.transaction(tx => worker.resumeAttempt(tx, queue, attempt.id)); assert.equal(await worker.runDelivery(deps), 'blocked');
  assert.equal(f.posts.length, 1); assert.deepEqual((await store.read(attempt.id)).receipt, original.receipt);
});


test('invalid output manifest becomes a truthful hold instead of an unbounded infrastructure retry', async t => {
  const f = await fixture(t); const { attempt, deps } = await accept(f); await finish(deps, 2);
  deps.provider = { ...f.provider, async outputs(receipt) { return { kind: 'outputs', receipt, outputs: [null] }; } };
  assert.equal(await worker.runDelivery(deps), 'blocked');
  assert.equal((await store.read(attempt.id)).issue.code, 'OUTPUT_MANIFEST_INVALID'); assert.equal(f.imports, 0);
});

test('resuming an undispatched queue item does not claim unknown provider acceptance', async t => {
  const f = await fixture(t); const { attempt } = await accept(f);
  await store.transaction(tx => worker.resumeAttempt(tx, queue, attempt.id));
  const state = await store.read(attempt.id);
  assert.equal(state.status, 'queued'); assert.equal(state.dispatch, null); assert.equal(state.remoteState, 'not_dispatched');
});

function launch(t, f, pause) {
  const child = fork(new URL('./child-worker.mjs', import.meta.url), [JSON.stringify({ origin: f.origin, root: f.root, pause })], { silent: true });
  const exited = once(child, 'exit'); const messages = []; let logs = '';
  child.on('message', message => messages.push(message));
  child.stdout.on('data', value => { logs += value; }); child.stderr.on('data', value => { logs += value; });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const result = await exited; assert.deepEqual(result, [null, 'SIGKILL'], logs);
    assert.throws(() => process.kill(child.pid, 0), e => e.code === 'ESRCH');
  };
  t.after(stop);
  return { stop, async point() {
    const deadline = Date.now() + 5000;
    while (!messages.some(message => message.point === pause)) {
      assert.equal(child.exitCode, null, logs); assert.equal(child.signalCode, null, logs); assert(Date.now() < deadline, 'checkpoint deadline: ' + logs);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } };
}
for (const point of ['intent', 'reply', 'bytes']) {
  test(`SIGKILL at ${point} recovers durable identity without a duplicate POST`, { timeout: 12000 }, async t => {
    const f = await fixture(t); const { attempt, deps } = await accept(f);
    if (point === 'bytes') await finish(deps, 3);
    const child = launch(t, f, point); await child.point();
    const before = await store.read(attempt.id);
    assert(before.dispatch); assert.equal((await pool.query('SELECT * FROM flume.fixture_take WHERE attempt_id=$1', [attempt.id])).rowCount, 0);
    assert.equal(f.posts.length, point === 'intent' ? 0 : 1);
    await child.stop();
    const job = (await pool.query("SELECT id,retry_count FROM flume_queue.job WHERE state='active' AND data->>'attemptId'=$1", [attempt.id])).rows[0];
    await retryActivation({ jobId: job.id });
    if (point === 'reply') deps.provider = { ...f.provider, lookup: f.lookup };
    await finish(deps);
    const after = await store.read(attempt.id);
    assert.deepEqual(after.dispatch, before.dispatch);
    assert.equal(after.status, point === 'intent' ? 'acceptance_unknown' : 'ready');
    assert.equal(f.posts.length, point === 'intent' ? 0 : 1);
    assert.equal((await pool.query('SELECT * FROM flume.fixture_take WHERE attempt_id=$1', [attempt.id])).rowCount, point === 'intent' ? 0 : 1);
    if (point === 'bytes') assert.equal(f.reads.filter(url => url === '/bytes').length, 1);
    assert.equal((await pool.query('SELECT selected FROM flume.fixture_selection WHERE shot_id=$1', [attempt.shotId])).rows[0].selected, 'human-existing-selection');
  });
}

test('explicit resume can recover a nonterminal phase after a delivery is abandoned, without a new submit', async t => {
  const f = await fixture(t); const { attempt, deps } = await accept(f); await finish(deps, 3);
  const abandoned = await queue.fetch(); assert(abandoned);
  const before = await store.read(attempt.id);
  assert.equal(typeof await store.transaction(tx => worker.resumeAttempt(tx, queue, attempt.id)), 'string');
  assert.equal(await worker.runDelivery(deps), 'ready'); assert.equal(f.posts.length, 1);
  assert.deepEqual((await store.read(attempt.id)).receipt, before.receipt);
  assert.equal(await store.transaction(tx => worker.resumeAttempt(tx, queue, attempt.id)), null);
});

test('worker loop drains real pg-boss phases and shutdown leaves durable data intact', { timeout: 10000 }, async t => {
  const f = await fixture(t); const { attempt, deps } = await accept(f);
  const controller = new AbortController(); t.after(() => controller.abort()); const faults = [];
  const running = worker.runWorker(deps, { signal: controller.signal, idleDelayMs: 10, pollDelaySeconds: 0, onError: error => faults.push(error) });
  const deadline = Date.now() + 2000;
  while ((await store.read(attempt.id)).status !== 'ready' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort(); await running;
  assert.equal((await store.read(attempt.id)).status, 'ready'); assert.deepEqual(faults, []); assert.equal(f.posts.length, 1);
  assert.equal((await pool.query('SELECT * FROM flume.fixture_take WHERE attempt_id=$1', [attempt.id])).rowCount, 1);
});

for (const when of ['after adoption','before publication']) test(`late conflicting receipt ${when} holds without publishing or submitting again`,async t=>{
 const f=await fixture(t);const {attempt,deps}=await accept(f);
 await worker.runDelivery(deps,{pollDelaySeconds:0});
 if(when==='before publication'){
  await worker.runDelivery(deps,{pollDelaySeconds:0});await worker.runDelivery(deps);
  f.beforeImport=async()=>{const s=await store.read(attempt.id);await store.observeReceipt(s.id,s.dispatch,{...s.receipt,providerJobId:'conflicting-late-handle'});};
 }else{const s=await store.read(attempt.id);await store.observeReceipt(s.id,s.dispatch,{...s.receipt,providerJobId:'conflicting-late-handle'});}
 assert.equal(await worker.runDelivery(deps),'blocked');
 assert.equal((await store.read(attempt.id)).issue.code,'IDENTITY_CONFLICT');
 assert.equal((await pool.query('SELECT * FROM flume.fixture_take WHERE attempt_id=$1',[attempt.id])).rowCount,0);
 assert.equal(f.posts.length,1);
});
