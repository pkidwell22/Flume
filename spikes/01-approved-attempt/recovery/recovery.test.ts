import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { readFile, lstat } from 'node:fs/promises';
import { openExperiment, type Experiment } from '../src/database.js';
import { resources } from './fixtures.js';
import { snapshot } from '../test/fixtures.js';

let experiment: Experiment;
before(async () => {
  experiment = await openExperiment();
  await experiment.pool.query(await readFile(new URL('../../recovery/schema.sql', import.meta.url), 'utf8'));
});
after(async () => { await experiment?.close(); });

test('workers connect to an initialized isolated DB without repeating schema creation', async () => {
  const worker = await openExperiment({ initialize: false });
  try {
    assert.equal((await worker.pool.query('select count(*)::int as n from spike.attempts')).rows[0].n, 0);
    await assert.rejects(() => openExperiment(), (error: any) => error.cause?.code === '42P06');
  } finally { await worker.close(); }
});

test('setup failure immediately cleans the already acquired simulator', async () => {
  let cleanup!: () => Promise<void>; let origin = '';
  await assert.rejects(() => resources({ after: fn => { cleanup = fn; } }, experiment, {
    afterProvider: async sim => { origin = sim.origin; throw new Error('injected-next-acquisition'); },
  }), /injected-next-acquisition/);
  await cleanup();
  await assert.rejects(() => fetch(origin, { signal: AbortSignal.timeout(500) }));
});

test('one cleanup rejection cannot skip another owned resource', async () => {
  let cleanup!: () => Promise<void>; let origin = ''; let directory = '';
  await assert.rejects(() => resources({ after: fn => { cleanup = fn; } }, experiment, {
    afterProvider: async sim => { origin = sim.origin; },
    afterStorage: async storage => { directory = storage; throw new Error('injected-metadata-read'); },
    cleanupFault: async () => { throw new Error('injected-cleanup-failure'); },
  }), /injected-metadata-read/);
  await assert.rejects(() => cleanup(), /injected-cleanup-failure/);
  await assert.rejects(() => lstat(directory), { code: 'ENOENT' });
  await assert.rejects(() => fetch(origin, { signal: AbortSignal.timeout(500) }));
});

test('intent survives SIGKILL before POST; restart reuses immutable key and exact reviewed bytes', async t => {
  const f = await resources(t, experiment);
  const worker = f.launch('intent'); await worker.point('intent');
  const before = await f.state();
  assert.equal(before.dispatch!.length, 1, 'durable intent must precede possible external effect');
  assert.equal(before.dispatch![0].key, f.receipt.attemptId);
  assert.equal(before.dispatch![0].body, f.fixture.request.envelope.body);
  assert.equal(before.jobs![0].state, 'active');
  assert.equal(f.sim.calls.length, 0);
  await assert.rejects(() => experiment.pool.query('UPDATE recovery.dispatch SET body=$2 WHERE attempt_id=$1',
    [f.receipt.attemptId, 'changed']), /IMMUTABLE_RECORD/);
  await worker.stop(); await f.retry(); await f.launch().done();
  const after = await f.state();
  assert.equal(after.lifecycle![0].remote_id, [...f.sim.jobs.keys()][0]);
  assert.equal(f.sim.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(f.sim.calls[0]!.key, before.dispatch![0].key);
  assert.equal(f.sim.calls[0]!.body, before.dispatch![0].body);
  assert.deepEqual(after.dispatch, before.dispatch);
  assert.deepEqual(after.selection, before.selection);
  assert.deepEqual((await snapshot(experiment, f.fixture)).counts,
    { attempts: 1, consumed: 1, reservations: 1, receipts: 1, jobs: 1, reserved: 1 });
  assert.equal(new Set(f.workers).size, 2);
});

test('lost HTTP response + SIGKILL recover one remote identity; later deliveries use handle reads', async t => {
  const f = await resources(t, experiment); f.sim.modes.dropSubmit = true;
  const worker = f.launch('unknown'); await worker.point('unknown');
  const unknown = await f.state();
  assert.equal(unknown.lifecycle![0].remote_state, 'unknown');
  assert.equal(unknown.lifecycle![0].remote_id, null);
  assert.equal(f.sim.jobs.size, 1);
  await worker.stop(); await f.retry(); await f.launch().done();
  await f.duplicate(); await f.launch().done();
  const state = await f.state();
  const submits = f.sim.calls.filter(c => c.path === '/submit');
  assert.equal(submits.length, 2, 'physical calls are not remote job count');
  assert.equal(f.sim.jobs.size, 1);
  assert.equal(new Set(submits.map(c => c.key)).size, 1);
  assert.deepEqual(submits.map(c => c.body), Array(2).fill(f.fixture.request.envelope.body));
  assert.equal(state.lifecycle![0].remote_id, [...f.sim.jobs.keys()][0]);
  assert.equal(state.lifecycle![0].remote_state, 'succeeded');
  assert(f.sim.calls.some(c => c.method === 'GET' && c.path.startsWith('/jobs/')));
  assert.equal((await snapshot(experiment, f.fixture)).counts.attempts, 1);
  console.log('TRACE lost response:', JSON.stringify({ calls: f.sim.calls, remoteJobs: [...f.sim.jobs.keys()], deliveries: state.deliveries }));
});

for (const gate of ['cancel', 'pause', 'revoked', 'expiry'] as const) {
  for (const boundary of ['before', 'unknown'] as const) {
    test(`${gate} ${boundary} authorization blocks request-creating replay`, async t => {
      const f = await resources(t, experiment);
      if (boundary === 'unknown') {
        // Crash after persisted authorization but BEFORE any HTTP effect: replay WOULD create work.
        const worker = f.launch('intent'); await worker.point('intent'); await worker.stop(); await f.retry();
      }
      if (gate === 'cancel' || gate === 'pause') {
        await experiment.pool.query(`UPDATE recovery.lifecycle SET ${gate === 'cancel' ? 'cancel_requested' : 'paused'}=true WHERE attempt_id=$1`, [f.receipt.attemptId]);
      } else {
        await experiment.pool.query(`UPDATE spike.grants SET ${gate === 'revoked' ? 'revoked=true' : "expires_at=clock_timestamp()-interval '1 second'"} WHERE id=$1`, [f.fixture.command.grantId]);
      }
      await f.launch().done();
      const state = await f.state();
      assert.equal(f.sim.calls.filter(c => c.path === '/submit').length, 0, 'must not create work to obtain a cancel/reconcile handle');
      assert.equal(f.sim.jobs.size, 0);
      assert.equal(state.lifecycle![0].hold, { cancel: boundary === 'before' ? 'CANCEL_PREVENTED' : 'CANCEL_UNKNOWN', pause: 'PAUSED', revoked: 'GRANT_UNAVAILABLE', expiry: 'GRANT_UNAVAILABLE' }[gate]);
      assert.equal((await snapshot(experiment, f.fixture)).counts.reserved, 1, 'no guessed refund');
      assert.equal(state.selection![0].selected, 'human-existing-selection');
    });
  }
}

for (const unsafe of ['window', 'unsupported', 'adapter', 'origin', 'limit'] as const) {
  test(`unsafe recovery ${unsafe} holds without a fresh key or request`, async t => {
    const f = await resources(t, experiment);
    f.sim.modes.dropSubmit = true;
    const worker = f.launch('unknown', unsafe === 'window' ? { replaySeconds: 0 } : unsafe === 'unsupported' ? { replaySafe: false } : {});
    await worker.point('unknown'); await worker.stop(); await f.retry();
    if (unsafe === 'limit') {
      f.sim.modes.dropSubmit = true; await f.launch().done(); await f.duplicate();
    }
    await f.launch('', unsafe === 'adapter' ? { adapter: 'unavailable-version' } : unsafe === 'origin' ? { origin: 'http://127.0.0.1:1' } : {}).done();
    assert.equal(f.sim.calls.filter(c => c.path === '/submit').length, unsafe === 'limit' ? 2 : 1);
    assert.equal(f.sim.jobs.size, 1);
    assert.equal((await f.state()).lifecycle![0].hold, { window: 'REPLAY_UNSAFE', unsupported: 'REPLAY_UNSAFE', adapter: 'REPLAY_SCOPE', origin: 'REPLAY_SCOPE', limit: 'SUBMIT_LIMIT' }[unsafe]);
    assert.equal((await snapshot(experiment, f.fixture)).counts.attempts, 1);
  });
}

test('a missing known remote handle never falls back to request-creating POST', async t => {
  const f = await resources(t, experiment); await f.launch().done();
  f.sim.jobs.clear(); await f.duplicate(); await f.launch().done();
  assert.equal(f.sim.calls.filter(c => c.path === '/submit').length, 1);
  assert.equal((await f.state()).lifecycle![0].hold, 'REMOTE_UNAVAILABLE');
});

test('late valid acceptance evidence survives stale delivery and cancellation; no POST to get handle', async t => {
  const f = await resources(t, experiment);
  const old = f.launch('reply'); await old.point('reply');
  await experiment.pool.query('UPDATE recovery.lifecycle SET cancel_requested=true WHERE attempt_id=$1', [f.receipt.attemptId]);
  await f.duplicate(); await f.launch().done();
  assert.equal((await f.state()).lifecycle![0].hold, 'CANCEL_UNKNOWN');
  old.resume(); assert.equal(await old.done(), 'stale');
  let state = await f.state();
  assert.equal(state.lifecycle![0].remote_id, null, 'stale delivery cannot write the checkpoint');
  assert.equal(state.observations!.length, 1, 'valid late evidence is not thrown away');
  await f.duplicate(); await f.launch().done(); state = await f.state();
  assert.equal(state.lifecycle![0].remote_id, [...f.sim.jobs.keys()][0]);
  assert.equal(state.lifecycle![0].cancellation, 'too_late');
  assert.equal(f.sim.calls.filter(c => c.path === '/submit').length, 1);
  assert.equal(state.selection![0].selected, 'human-existing-selection');
});

test('stale running reply cannot regress succeeded checkpoint', async t => {
  const f = await resources(t, experiment); f.sim.modes.pending = true;
  const old = f.launch('reply'); await old.point('reply');
  [...f.sim.jobs.values()][0]!.state = 'succeeded';
  await f.duplicate(); await f.launch('', { lookup: true }).done();
  old.resume(); assert.equal(await old.done(), 'stale');
  const state = await f.state();
  assert.equal(state.lifecycle![0].remote_state, 'succeeded');
  assert.equal(state.observations!.length, 2);
  assert.equal(f.sim.jobs.size, 1);
});

for (const pending of [true, false]) {
  test(`cancel after dispatch authorization reconciles ${pending ? 'remote cancellation' : 'too-late completion'} despite revoked authority`, async t => {
    const f = await resources(t, experiment); f.sim.modes.pending = pending;
    const worker = f.launch('intent'); await worker.point('intent');
    await experiment.pool.query('UPDATE recovery.lifecycle SET cancel_requested=true,paused=true WHERE attempt_id=$1', [f.receipt.attemptId]);
    await experiment.pool.query("UPDATE spike.grants SET revoked=true,expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.fixture.command.grantId]);
    worker.resume(); await worker.done();
    const state = await f.state();
    assert.equal(state.lifecycle![0].cancellation, pending ? 'confirmed' : 'too_late');
    assert.equal(state.lifecycle![0].remote_state, pending ? 'cancelled' : 'succeeded');
    assert.equal(state.takes!.length, pending ? 0 : 2);
    assert.equal(state.lifecycle![0].available, !pending);
    assert.equal(state.selection![0].selected, 'human-existing-selection');
    assert.equal(f.sim.calls.filter(c => c.path === '/submit').length, 1);
    assert.equal(f.sim.calls.filter(c => c.path.endsWith('/cancel')).length, 1);
    assert.equal((await snapshot(experiment, f.fixture)).counts.reserved, 1);
  });
}

test('cancellation racing before authorization prevents the original POST', async t => {
  const f = await resources(t, experiment);
  const worker = f.launch('before-authorize'); await worker.point('before-authorize');
  await experiment.pool.query('UPDATE recovery.lifecycle SET cancel_requested=true WHERE attempt_id=$1', [f.receipt.attemptId]);
  worker.resume(); await worker.done();
  assert.equal(f.sim.calls.length, 0);
  assert.equal((await f.state()).lifecycle![0].cancellation, 'prevented');
});

test('unknown accepted work is held after cancel, then read-only lookup can recover it', async t => {
  const f = await resources(t, experiment); f.sim.modes.dropSubmit = true;
  const worker = f.launch('unknown'); await worker.point('unknown'); await worker.stop(); await f.retry();
  await experiment.pool.query('UPDATE recovery.lifecycle SET cancel_requested=true WHERE attempt_id=$1', [f.receipt.attemptId]);
  await f.launch().done();
  assert.equal((await f.state()).lifecycle![0].hold, 'CANCEL_UNKNOWN');
  assert.equal(f.sim.calls.length, 1);
  await f.duplicate(); await f.launch('', { lookup: true }).done();
  assert.equal(f.sim.calls.filter(c => c.path === '/submit').length, 1);
  assert.equal((await f.state()).lifecycle![0].cancellation, 'too_late');
});

test('duplicate delivery imports stable remote outputs once as unselected simulation alternatives', async t => {
  const f = await resources(t, experiment); await f.launch().done();
  const first = await f.state();
  assert.equal(first.takes!.length, 2, 'remote success is not owned availability');
  assert.equal(first.lifecycle![0].available, true);
  assert.equal(first.imports!.length, 2);
  for (const output of f.sim.outputs) {
    const take = first.takes!.find(t => t.output_id === output.outputId)!;
    assert.equal(take.attempt_id, f.receipt.attemptId); assert.equal(take.remote_id, output.remoteId);
    assert.equal(take.sha256, output.sha256);
    const bytes = await f.bytes(`${output.sha256}.simulation`);
    assert.match(bytes.toString(), /^SIMULATION ONLY; NOT MP4 OR PROVIDER MEDIA/);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), output.sha256);
  }
  await f.duplicate(); await f.launch().done();
  const repeated = await f.state();
  assert.deepEqual(repeated.takes!.sort((a,b) => a.id.localeCompare(b.id)), first.takes!.sort((a,b) => a.id.localeCompare(b.id)));
  assert.deepEqual(repeated.selection, first.selection);
  assert.equal(f.sim.calls.filter(c => c.path.includes('/outputs/')).length, 2, 'published output identity does not download twice');
  assert.equal(f.sim.calls.filter(c => c.path === '/submit').length, 1);
  assert.equal((await snapshot(experiment, f.fixture)).counts.reserved, 1);
});

for (const point of ['bytes', 'import'] as const) {
  test(`SIGKILL at ${point} publication resumes without duplicate output/take`, async t => {
    const f = await resources(t, experiment);
    const worker = f.launch(point); await worker.point(point);
    const before = await f.state();
    assert.equal(before.takes!.length, point === 'bytes' ? 0 : 1);
    assert.equal(before.imports!.length, 1);
    assert.equal(before.lifecycle![0].available, false);
    const files = await f.files(); assert.equal(files.length, 1);
    assert.equal(createHash('sha256').update(await f.bytes(files[0]!)).digest('hex'), before.imports![0].sha256);
    await worker.stop(); await f.retry(); await f.launch().done();
    const recovered = await f.state();
    assert.equal(recovered.takes!.length, 2); assert.equal(recovered.lifecycle![0].available, true);
    assert.equal(f.sim.calls.filter(c => c.path.includes('/outputs/')).length, 2, 'finalized bytes reused after process death');
    assert.equal(f.sim.calls.filter(c => c.path === '/submit').length, 1);
    assert.deepEqual(recovered.selection, before.selection);
    console.log(`TRACE ${point} crash:`, JSON.stringify({ before: { imports: before.imports, takes: before.takes, files }, after: recovered.takes }));
  });
}

test('partial HTTP bytes are not published; import-only recovery keeps attempt and remote identity', async t => {
  const f = await resources(t, experiment); f.sim.modes.partialDownload = true;
  await f.launch().done();
  const partial = await f.state();
  assert.equal(partial.lifecycle![0].hold, 'IMPORT_PENDING');
  assert.equal(partial.lifecycle![0].remote_state, 'succeeded');
  assert.equal(partial.lifecycle![0].available, false);
  assert.equal(partial.takes!.length, 0); assert.deepEqual(await f.files(), []);
  await f.duplicate(); await f.launch().done();
  const recovered = await f.state();
  assert.equal(recovered.takes!.length, 2); assert.equal(recovered.lifecycle![0].available, true);
  assert.equal(recovered.lifecycle![0].remote_id, partial.lifecycle![0].remote_id);
  assert.equal(f.sim.calls.filter(c => c.path === '/submit').length, 1);
});

test('real SQL publication failure after bytes leaves claim recoverable and no phantom take', async t => {
  const f = await resources(t, experiment);
  await experiment.pool.query(`CREATE FUNCTION recovery.reject_take() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected-real-publication-failure'; END $$;
    CREATE TRIGGER reject_take BEFORE INSERT ON recovery.takes FOR EACH ROW EXECUTE FUNCTION recovery.reject_take()`);
  try {
    await f.launch().done();
    const failed = await f.state();
    assert.equal(failed.takes!.length, 0); assert.equal(failed.imports![0].published, false);
    assert.equal(failed.lifecycle![0].hold, 'IMPORT_PENDING'); assert.equal((await f.files()).length, 1);
  } finally { await experiment.pool.query('DROP TRIGGER reject_take ON recovery.takes; DROP FUNCTION recovery.reject_take()'); }
  await f.duplicate(); await f.launch().done();
  assert.equal((await f.state()).takes!.length, 2);
  assert.equal(f.sim.calls.filter(c => c.path.includes('/outputs/')).length, 2);
});

test('concurrent import delivery fences old SQL publication after immutable bytes', async t => {
  const f = await resources(t, experiment);
  const old = f.launch('bytes'); await old.point('bytes');
  await f.duplicate(); await f.launch().done();
  const newer = await f.state(); assert.equal(newer.takes!.length, 2);
  old.resume(); assert.equal(await old.done(), 'stale');
  assert.deepEqual((await f.state()).takes!.sort((a,b) => a.id.localeCompare(b.id)), newer.takes!.sort((a,b) => a.id.localeCompare(b.id)));
  assert.equal(f.sim.calls.filter(c => c.path === '/submit').length, 1);
});

test('equal fixture bytes from separately approved attempts retain distinct output attribution', async t => {
  const a = await resources(t, experiment); await a.launch().done();
  const b = await resources(t, experiment); await b.launch('', { origin: a.sim.origin, storage: a.storage }).done();
  const [sa, sb] = await Promise.all([a.state(), b.state()]);
  assert.equal(sa.takes!.length, 2); assert.equal(sb.takes!.length, 2);
  assert.equal(new Set([...sa.takes!, ...sb.takes!].map(take => take.id)).size, 4);
  assert.equal(new Set([...sa.takes!, ...sb.takes!].map(take => take.sha256)).size, 2);
  assert.equal(a.sim.jobs.size, 2); assert.equal(a.sim.outputs.length, 4);
  assert.equal(a.sim.calls.filter(c => c.path.includes('/outputs/')).length, 2);
  assert.equal((await a.files()).length, 2);
});

test('stale owner cannot acknowledge a redelivery of the same pg-boss job', async t => {
  const f = await resources(t, experiment);
  const old = f.launch('finish'); await old.point('finish');
  await f.retry();
  const current = f.launch('finish'); await current.point('finish');
  old.resume(); await old.done();
  assert.equal((await f.state()).jobs![0].state, 'active', 'stale owner must not complete current queue delivery');
  current.resume(); await current.done();
  assert.equal((await f.state()).jobs![0].state, 'completed');
});

test('stable output identity cannot silently acquire different bytes after a claim', async t => {
  const f = await resources(t, experiment);
  const worker = f.launch('bytes'); await worker.point('bytes');
  const claimed = await f.state(); await worker.stop(); await f.retry();
  f.sim.modes.driftOutput = true; await f.launch().done();
  const state = await f.state();
  assert.equal(state.lifecycle![0].hold, 'OUTPUT_CONFLICT');
  assert.equal(state.takes!.length, 0); assert.equal(state.lifecycle![0].available, false);
  assert.deepEqual(state.imports, claimed.imports);
  assert.equal(f.sim.calls.filter(c => c.path.includes('/outputs/')).length, 1, 'reject drift before download');
  f.sim.modes.driftOutput = false; await f.duplicate(); await f.launch().done();
  assert.equal((await f.state()).takes!.length, 2);
});

test('transport loss before remote acceptance may replay only the original authorized identity', async t => {
  const f = await resources(t, experiment); f.sim.modes.rejectSubmit = true;
  const worker = f.launch('unknown'); await worker.point('unknown');
  assert.equal(f.sim.jobs.size, 0); assert.equal(f.sim.calls.length, 1);
  await worker.stop(); await f.retry(); f.sim.modes.rejectSubmit = false;
  await f.launch().done();
  const submits = f.sim.calls.filter(call => call.path === '/submit');
  assert.equal(submits.length, 2); assert.equal(submits[0]!.remoteId, null);
  assert.equal(submits[1]!.key, submits[0]!.key); assert.equal(submits[1]!.body, submits[0]!.body);
  assert.equal(f.sim.jobs.size, 1); assert.equal((await f.state()).takes!.length, 2);
  const accepted = await snapshot(experiment, f.fixture);
  assert.equal(accepted.counts.attempts, 1); assert.equal(accepted.counts.reserved, 1);
  assert.deepEqual(accepted.attempts[0]!.request, f.fixture.request);
});

test('SIGKILL after reply before receipt commit recovers same job by read-only key lookup', async t => {
  const f = await resources(t, experiment);
  const worker = f.launch('reply'); await worker.point('reply');
  assert.equal((await f.state()).observations!.length, 0);
  await worker.stop(); await f.retry(); await f.launch('', { lookup: true }).done();
  assert.equal(f.sim.calls.filter(c => c.path === '/submit').length, 1);
  assert.equal(f.sim.jobs.size, 1);
  assert.equal((await f.state()).lifecycle![0].remote_id, [...f.sim.jobs.keys()][0]);
});
