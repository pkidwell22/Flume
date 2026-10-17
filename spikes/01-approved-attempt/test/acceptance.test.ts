import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { openExperiment, queue, type Experiment } from '../src/database.js';
import { accept } from '../src/accept.js';
import { commandSchema, hash, requestSchema } from '../src/contracts.js';
import { barrier, relatedReview, seed, snapshot } from './fixtures.js';

let experiment: Experiment;
before(async () => { experiment = await openExperiment(); });
after(async () => { await experiment?.close(); });

test('commit: frozen review, allowance, receipt, attempt and job agree on an independent connection', async () => {
  const fixture = await seed(experiment);
  const receipt = await accept(experiment, fixture.context, fixture.command);
  assert.match(receipt.attemptId, /^[0-9a-f-]{36}$/);
  const state = await snapshot(experiment, fixture);
  assert.deepEqual(state.counts, { attempts: 1, consumed: 1, reservations: 1, receipts: 1, jobs: 1, reserved: 1 });
  assert.equal(state.attempts[0]!.id, receipt.attemptId);
  assert.equal(state.attempts[0]!.job_id, receipt.jobId);
  assert.deepEqual(state.attempts[0]!.request, fixture.request);
  assert.equal(state.attempts[0]!.request_fingerprint, fixture.command.requestFingerprint);
  assert.equal(state.jobs[0]!.id, receipt.jobId);
  assert.deepEqual(state.jobs[0]!.data, { version: 1, attemptId: receipt.attemptId });
  assert.equal(state.jobs[0]!.state, 'created');
  assert.equal(state.reviews[0]!.consumed_attempt_id, receipt.attemptId);
  assert.equal(state.reservations[0]!.attempt_id, receipt.attemptId);
  assert.equal(state.receipts[0]!.attempt_id, receipt.attemptId);
});

const empty = { attempts: 0, consumed: 0, reservations: 0, receipts: 0, jobs: 0, reserved: 0 };

test('rollback: injected throw after real INSERT rolls back business rows AND queue job', async () => {
  const fixture = await seed(experiment);
  const before = await snapshot(experiment, fixture);
  let sent: string | null = null;
  await assert.rejects(() => accept(experiment, fixture.context, fixture.command, {
    enqueue: async send => {
      sent = await send();
      assert.ok(sent);
      const invisible = await snapshot(experiment, fixture);
      assert.deepEqual(invisible.counts, empty, 'another session cannot see uncommitted business state');
      assert.deepEqual(invisible.allJobIds, before.allJobIds, 'queue insertion is also uncommitted');
      throw new Error('injected-after-real-enqueue');
    },
  }), /injected-after-real-enqueue/);
  assert.ok(sent, 'fault ran after successful real pg-boss INSERT');
  const after = await snapshot(experiment, fixture);
  assert.deepEqual(after.counts, empty);
  assert.deepEqual(after.allJobIds, before.allJobIds, 'no orphan job outside the attempt join');
  const retry = await accept(experiment, fixture.context, fixture.command);
  assert.notEqual(retry.attemptId, sent);
  assert.deepEqual((await snapshot(experiment, fixture)).counts, { attempts: 1, consumed: 1, reservations: 1, receipts: 1, jobs: 1, reserved: 1 });
});

test('rollback: real pg-boss duplicate-ID suppression returns null, not acceptance', async () => {
  const fixture = await seed(experiment);
  const sentinelId = randomUUID();
  assert.equal(await experiment.boss.send(queue, { sentinel: true }, { id: sentinelId, retryLimit: 0 }), sentinelId);
  const before = await snapshot(experiment, fixture);
  let actualResult: string | null | undefined;
  await assert.rejects(() => accept(experiment, fixture.context, fixture.command, {
    enqueue: async send => { actualResult = await send(sentinelId); return actualResult; },
  }), /ENQUEUE_SUPPRESSED/);
  assert.equal(actualResult, null, 'suppression came from pg-boss, not a mocked return value');
  const after = await snapshot(experiment, fixture);
  assert.deepEqual(after.counts, empty);
  assert.deepEqual(after.allJobIds, before.allJobIds, 'pre-existing sentinel remains and no extra work leaked');
});

const once = { attempts: 1, consumed: 1, reservations: 1, receipts: 1, jobs: 1, reserved: 1 };

test('8 simultaneous identical commands all recover one accepted identity', async () => {
  const fixture = await seed(experiment);
  const gate = barrier(8);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
    accept(experiment, fixture.context, fixture.command, { beforeLock: gate.arrive })));
  gate.verify();
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 8);
  const identities = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  assert.equal(new Set(identities.map(receipt => receipt.attemptId)).size, 1);
  assert.equal(new Set(identities.map(receipt => receipt.jobId)).size, 1);
  assert.deepEqual((await snapshot(experiment, fixture)).counts, once);
});

test('accepted command replay after later draft edits returns frozen original without another reservation', async () => {
  const fixture = await seed(experiment);
  const original = await accept(experiment, fixture.context, fixture.command);
  await experiment.pool.query('UPDATE spike.drafts SET revision=revision+1, prompt=$2 WHERE id=$1', [fixture.request.shotId, 'later human edit']);
  await experiment.pool.query("UPDATE spike.grants SET revoked=true, expires_at=now()-interval '1 second' WHERE id=$1", [fixture.command.grantId]);
  const replay = await accept(experiment, fixture.context, fixture.command);
  assert.deepEqual(replay, original);
  const state = await snapshot(experiment, fixture);
  assert.deepEqual(state.counts, once);
  assert.deepEqual(state.attempts[0]!.request, fixture.request);
});

test('same accepted command identity with a changed request fingerprint conflicts', async () => {
  const fixture = await seed(experiment);
  await accept(experiment, fixture.context, fixture.command);
  await assert.rejects(() => accept(experiment, fixture.context,
    { ...fixture.command, requestFingerprint: 'c'.repeat(64) }), /COMMAND_CONFLICT/);
  assert.deepEqual((await snapshot(experiment, fixture)).counts, once);
});

test('8 different command IDs racing one review produce one receipt, attempt and reservation', async () => {
  const fixture = await seed(experiment);
  const gate = barrier(8);
  const commands = Array.from({ length: 8 }, () => ({ ...fixture.command, commandId: randomUUID() }));
  const results = await Promise.allSettled(commands.map(command =>
    accept(experiment, fixture.context, command, { beforeLock: gate.arrive })));
  gate.verify();
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results) {
    if (result.status === 'rejected') assert.match(String(result.reason), /REVIEW_ALREADY_CONSUMED/);
  }
  assert.deepEqual((await snapshot(experiment, fixture)).counts, once);
});

test('an unused review is stale after a draft revision changes', async () => {
  const fixture = await seed(experiment);
  await experiment.pool.query('UPDATE spike.drafts SET revision=revision+1, prompt=$2 WHERE id=$1', [fixture.request.shotId, 'edited before submit']);
  await assert.rejects(() => accept(experiment, fixture.context, fixture.command), /STALE_REVIEW/);
  assert.deepEqual((await snapshot(experiment, fixture)).counts, empty);
});

test('a new command cannot substitute an unreviewed request fingerprint', async () => {
  const fixture = await seed(experiment);
  await assert.rejects(() => accept(experiment, fixture.context,
    { ...fixture.command, requestFingerprint: 'd'.repeat(64) }), /REQUEST_CONFLICT/);
  assert.deepEqual((await snapshot(experiment, fixture)).counts, empty);
});

test('8 distinct reviews and drafts compete for one grant allowance without oversubscription', async () => {
  const first = await seed(experiment);
  const fixtures = [first, ...await Promise.all(Array.from({ length: 7 }, () => relatedReview(experiment, first)))];
  assert.equal(new Set(fixtures.map(fixture => fixture.request.shotId)).size, 8);
  const gate = barrier(8);
  const results = await Promise.allSettled(fixtures.map(fixture =>
    accept(experiment, fixture.context, fixture.command, { beforeLock: gate.arrive })));
  gate.verify();
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results) {
    if (result.status === 'rejected') assert.match(String(result.reason), /GRANT_UNAVAILABLE/);
  }
  const state = await snapshot(experiment, first);
  assert.deepEqual(state.counts, once);
  assert.equal(state.reviews.filter(review => review.consumed_attempt_id === null).length, 7);
});

for (const [name, assignment, value] of [
  ['actor', 'actor_id=$2', randomUUID()],
  ['project', 'project_id=$2', randomUUID()],
  ['account', 'account_id=$2', randomUUID()],
  ['route', 'route=$2', 'other/route'],
  ['exact input', 'allowed_fingerprints=$2::jsonb', '[]'],
  ['revoked', 'revoked=$2', true],
  ['expired', 'expires_at=$2::timestamptz', '2000-01-01T00:00:00Z'],
] as const) {
  test(`unaccepted command cannot use a grant with wrong ${name}`, async () => {
    const fixture = await seed(experiment);
    await experiment.pool.query(`UPDATE spike.grants SET ${assignment} WHERE id=$1`, [fixture.command.grantId, value]);
    await assert.rejects(() => accept(experiment, fixture.context, fixture.command), /GRANT_UNAVAILABLE/);
    assert.deepEqual((await snapshot(experiment, fixture)).counts, empty);
  });
}

test('frozen request scope must agree with its review and caller project', async () => {
  const fixture = await seed(experiment);
  const corrupt = { ...fixture.request, projectId: randomUUID() };
  const command = { ...fixture.command, reviewId: randomUUID(), requestFingerprint: hash(corrupt) };
  await experiment.pool.query(`INSERT INTO spike.reviews (id, project_id, shot_id, draft_revision, request, request_fingerprint)
    VALUES ($1,$2,$3,1,$4,$5)`, [command.reviewId, fixture.context.projectId, fixture.request.shotId, corrupt, command.requestFingerprint]);
  await experiment.pool.query('UPDATE spike.grants SET allowed_fingerprints=$2::jsonb WHERE id=$1', [command.grantId, JSON.stringify([command.requestFingerprint])]);
  await assert.rejects(() => accept(experiment, fixture.context, command), /REQUEST_CONFLICT/);
  assert.deepEqual((await snapshot(experiment, fixture)).counts, empty);
});

test('frozen review/attempt/receipt/reservation cannot be rewritten and consumed review cannot be reopened', async () => {
  const fixture = await seed(experiment);
  await assert.rejects(() => experiment.pool.query(`UPDATE spike.reviews SET request=jsonb_set(request, '{spec,prompt}', '"tampered"') WHERE id=$1`,
    [fixture.command.reviewId]), /IMMUTABLE_REVIEW/);
  const receipt = await accept(experiment, fixture.context, fixture.command);
  await assert.rejects(() => experiment.pool.query('UPDATE spike.reviews SET consumed_attempt_id=NULL WHERE id=$1',
    [fixture.command.reviewId]), /IMMUTABLE_REVIEW/);
  await assert.rejects(() => experiment.pool.query(`UPDATE spike.attempts SET request=jsonb_set(request, '{spec,prompt}', '"tampered"') WHERE id=$1`,
    [receipt.attemptId]), /IMMUTABLE_RECORD/);
  await assert.rejects(() => experiment.pool.query('DELETE FROM spike.receipts WHERE command_id=$1', [fixture.command.commandId]), /IMMUTABLE_RECORD/);
  await assert.rejects(() => experiment.pool.query('DELETE FROM spike.reservations WHERE attempt_id=$1', [receipt.attemptId]), /IMMUTABLE_RECORD/);
  const state = await snapshot(experiment, fixture);
  assert.deepEqual(state.counts, once);
  assert.deepEqual(state.attempts[0]!.request, fixture.request);
  assert.deepEqual(state.reviews[0]!.request, fixture.request);
});

test('rollback: PostgreSQL rejects the real pg-boss INSERT and no accepted state leaks', async () => {
  const fixture = await seed(experiment);
  const before = await snapshot(experiment, fixture);
  await experiment.pool.query(`CREATE FUNCTION spike.reject_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF current_setting('spike.reject_enqueue', true) = 'yes' THEN
      RAISE EXCEPTION 'FORCED_QUEUE_INSERT_FAILURE'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_enqueue BEFORE INSERT ON pgboss.job FOR EACH ROW EXECUTE FUNCTION spike.reject_enqueue()`);
  try {
    await assert.rejects(() => accept(experiment, fixture.context, fixture.command, {
      beforeLock: async client => { await client.query("SET LOCAL spike.reject_enqueue = 'yes'"); },
    }), /FORCED_QUEUE_INSERT_FAILURE/);
    const after = await snapshot(experiment, fixture);
    assert.deepEqual(after.counts, empty);
    assert.deepEqual(after.allJobIds, before.allJobIds);
  } finally {
    await experiment.pool.query('DROP TRIGGER reject_enqueue ON pgboss.job; DROP FUNCTION spike.reject_enqueue()');
  }
});

test('rollback: a real queued job with the wrong ID is rejected and rolled back', async () => {
  const fixture = await seed(experiment);
  const before = await snapshot(experiment, fixture);
  await assert.rejects(() => accept(experiment, fixture.context, fixture.command, {
    enqueue: send => send(randomUUID()),
  }), /ENQUEUE_ID_MISMATCH/);
  const after = await snapshot(experiment, fixture);
  assert.deepEqual(after.counts, empty);
  assert.deepEqual(after.allJobIds, before.allJobIds);
});

test('strict schemas reject unknown fields/coercion and fingerprints preserve exact envelope bytes', async () => {
  const fixture = await seed(experiment);
  for (const malformed of [
    { ...fixture.command, approved: true },
    { ...fixture.command, requestFingerprint: 'NOT_A_FINGERPRINT' },
    { ...fixture.command, version: 2 },
  ]) {
    assert.equal(commandSchema.safeParse(malformed).success, false);
    await assert.rejects(() => accept(experiment, fixture.context, malformed));
  }
  assert.equal(requestSchema.safeParse({ ...fixture.request, spec: { ...fixture.request.spec, seed: '0' } }).success, false);
  assert.equal(requestSchema.safeParse({ ...fixture.request, spec: { ...fixture.request.spec, unknown: 1 } }).success, false);
  const request = requestSchema.parse(fixture.request);
  assert.equal(request.spec.seed, 0);
  assert.equal(request.spec.audio, false);
  assert.equal(hash(Object.fromEntries(Object.entries(request).reverse())), hash(request));
  assert.notEqual(hash({ ...request, envelope: { ...request.envelope, body: `${request.envelope.body} ` } }), hash(request));
  assert.notEqual(hash({ ...request, spec: { ...request.spec, firstFrame: request.spec.lastFrame, lastFrame: request.spec.firstFrame } }), hash(request));
  assert.deepEqual((await snapshot(experiment, fixture)).counts, empty);
});
