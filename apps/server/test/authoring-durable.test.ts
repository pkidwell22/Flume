/**
 * Durable-integration tests: concurrency, restart/takeover and SQL CAS semantics.
 *
 * TWO KINDS OF EVIDENCE, explicitly separated:
 *  1. service-level behaviour over the LABELLED in-memory fixtures (`InMemoryProposalStore`,
 *     `createMemoryContinueShotJournal`). They reproduce fenced-lease semantics in one process and
 *     are NOT cross-process evidence.
 *  2. adapter-level assertions over a scripted SQL executor: they prove each mutation is a single
 *     guarded statement (status/revision CAS, owner+fence, lease liveness) and that a lost CAS
 *     returns null without a second write. They do NOT execute PostgreSQL. No claim of real-PG
 *     verification is made here; the coordinator runs the disposable-PG pass.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  InMemoryProposalStore, createStoryboardProposalService, stableCommandId,
} from '../src/storyboard-proposals.ts';
import { createSqlStoryboardStore } from '../src/storyboard-store.ts';
import { createSqlAuthoringOperationLock } from '../src/authoring-operation-lock.ts';
import { createSqlContinueShotJournal } from '../src/continue-shot-store.ts';
import {
  createContinueShot, createMemoryContinueShotJournal, continueShotIntentHash,
  type ContinueShotRecord,
} from '../src/continue-shot.ts';
import { defaultControls } from '../src/contracts.ts';

const PROJECT = '10000000-0000-4000-8000-000000000001';
const OTHER_PROJECT = '10000000-0000-4000-8000-000000000002';
const OPERATOR = '30000000-0000-4000-8000-000000000001';
const OTHER_OPERATOR = '30000000-0000-4000-8000-000000000002';
const SOURCE_SHOT = '40000000-0000-4000-8000-000000000001';
const TAKE = '50000000-0000-4000-8000-000000000001';
const VIDEO = '60000000-0000-4000-8000-000000000001';
const OP = '90000000-0000-4000-8000-000000000001';
const VIDEO_SHA = 'a'.repeat(64);

const operator = () => ({ id: OPERATOR, kind: 'operator' as const, projectIds: [PROJECT] });
const shotList = () => ({
  shots: [
    { title: 'Threshold', direction: 'Push in.', startDescription: 'Hall.', endDescription: 'Figure.', durationSeconds: 4, continuityNotes: '' },
    { title: 'Kitchen', direction: 'Follow.', startDescription: 'Steam.', endDescription: 'Hand.', durationSeconds: 3, continuityNotes: '' },
    { title: 'Window', direction: 'Wide.', startDescription: 'Rain.', endDescription: 'Light.', durationSeconds: 5, continuityNotes: '' },
  ],
});

/** Command port that replays by (actor, commandId), like flume.command_receipts, and can be gated. */
function receiptPort() {
  const commands: Array<{ actorId: string; command: any }> = [];
  const receipts = new Map<string, any>();
  let gate: Promise<void> | null = null;
  const port = async (actor: any, command: any) => {
    commands.push({ actorId: actor.id, command });
    if (gate) await gate;
    const key = `${actor.id}:${command.commandId}`;
    const replay = receipts.get(key);
    if (replay) return replay;
    const receipt = { commandId: command.commandId, projectId: command.projectId, resourceId: randomUUID(), revision: 1 };
    receipts.set(key, receipt);
    return receipt;
  };
  return {
    port, commands, receipts,
    setGate(promise: Promise<void> | null) { gate = promise; },
  };
}

const service = (port: any, store: InMemoryProposalStore, leaseTtlMs?: number) => createStoryboardProposalService({
  planner: { modelId: 'fixture/planner-1', propose: async () => shotList() },
  command: port,
  store,
  ...(leaseTtlMs === undefined ? {} : { leaseTtlMs }),
});

// ---------------------------------------------------------------------------------------------
// Storyboard: concurrency, takeover and stale writers
// ---------------------------------------------------------------------------------------------

test('two concurrent accepts: one applies, the other is refused, and no cut is created twice', async () => {
  const store = new InMemoryProposalStore();
  const port = receiptPort();
  const planner = service(port.port, store);
  const draft = await planner.propose(operator(), { projectId: PROJECT, brief: 'House at dusk.' });

  let release!: () => void;
  port.setGate(new Promise<void>(resolve => { release = resolve; }));

  const first = service(port.port, store).accept(operator(), { projectId: PROJECT, proposalId: draft.id, expectedRevision: 0 });
  // Let the first accept reach the command port before the second one races it.
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = service(port.port, store).accept(operator(), { projectId: PROJECT, proposalId: draft.id, expectedRevision: 0 });
  const secondResult = await second.then(value => ({ value }), (error: any) => ({ error }));

  assert.ok('error' in secondResult, 'the losing accept must not run a second application');
  assert.equal((secondResult as any).error.status, 409);
  assert.ok(['PROPOSAL_STATE', 'OPERATION_IN_PROGRESS'].includes((secondResult as any).error.code));

  release();
  const accepted = await first;
  assert.equal(accepted.status, 'applied');
  assert.equal(port.commands.length, 3, 'exactly one shot.create per reviewed cut');
  assert.equal(new Set(port.commands.map(entry => entry.command.commandId)).size, 3);
});

test('resume is refused while another process holds a live lease, with no side effect', async () => {
  const store = new InMemoryProposalStore();
  const port = receiptPort();
  const planner = service(port.port, store);
  const draft = await planner.propose(operator(), { projectId: PROJECT, brief: 'House at dusk.' });
  // Force an interrupted state: the first command's outcome is unknown, so no cut is confirmed.
  const failing = async () => { throw new Error('socket hang up'); };
  const interrupted = await service(failing as any, store).accept(operator(), { projectId: PROJECT, proposalId: draft.id, expectedRevision: 0 });
  assert.equal(interrupted.status, 'unknown');
  const before = port.commands.filter(entry => entry.command).length;

  // A different process owns the lease (this is what a live worker looks like from here).
  const held = await store.lease.acquire({ scope: 'storyboard.apply', operationId: draft.id.toLowerCase(), projectId: PROJECT, ttlMs: 60_000 });
  assert.ok(held.lease);

  await assert.rejects(
    service(failing as any, store).resume(operator(), { projectId: PROJECT, proposalId: draft.id }),
    (error: any) => { assert.equal(error.code, 'OPERATION_IN_PROGRESS'); assert.equal(error.status, 409); return true; },
  );
  assert.equal(port.commands.length, before, 'a refused resume must not issue any command');
});

test('a superseded lease cannot settle or finish an item after takeover', async () => {
  let clock = 0;
  const store = new InMemoryProposalStore({ now: () => clock });
  const port = receiptPort();
  const planner = service(port.port, store);
  const draft = await planner.propose(operator(), { projectId: PROJECT, brief: 'House at dusk.' });
  const failing = async () => { throw new Error('socket hang up'); };
  const interrupted = await service(failing as any, store).accept(operator(), { projectId: PROJECT, proposalId: draft.id, expectedRevision: 0 });
  assert.equal(interrupted.status, 'unknown');
  const applying = await store.load(PROJECT, draft.id);
  assert.ok(applying);

  const stale = await store.lease.acquire({ scope: 'storyboard.apply', operationId: draft.id.toLowerCase(), projectId: PROJECT, ttlMs: 250 });
  assert.ok(stale.lease);
  clock += 1_000;
  const fresh = await store.lease.acquire({ scope: 'storyboard.apply', operationId: draft.id.toLowerCase(), projectId: PROJECT, ttlMs: 60_000 });
  assert.ok(fresh.lease);
  assert.equal(fresh.lease!.fence, stale.lease!.fence + 1, 'takeover increments the fence');

  const item = applying.items[0];
  assert.equal(await store.claimItem({ projectId: PROJECT, proposalId: draft.id, itemId: item.itemId, allowFailed: true, lease: stale.lease! }), false);
  assert.equal(await store.settleItem({
    projectId: PROJECT, proposalId: draft.id, itemId: item.itemId, state: 'created',
    shotId: randomUUID(), code: null, lease: stale.lease!,
  }), false);
  assert.equal(await store.finish({ projectId: PROJECT, proposalId: draft.id, status: 'applied', failure: null, lease: stale.lease! }), null);
  const after = await store.load(PROJECT, draft.id);
  assert.notEqual(after?.status, 'applied', 'the stale owner must not record a status');
});

test('resume by a different actor is refused before any frozen command is replayed', async () => {
  const store = new InMemoryProposalStore();
  const port = receiptPort();
  const planner = service(port.port, store);
  const draft = await planner.propose(operator(), { projectId: PROJECT, brief: 'House at dusk.' });
  const failing = async () => { throw new Error('socket hang up'); };
  await service(failing as any, store).accept(operator(), { projectId: PROJECT, proposalId: draft.id, expectedRevision: 0 });
  const before = port.commands.length;

  await assert.rejects(
    service(failing as any, store).resume({ id: OTHER_OPERATOR, kind: 'operator', projectIds: [PROJECT] }, { projectId: PROJECT, proposalId: draft.id }),
    (error: any) => { assert.equal(error.code, 'PROPOSAL_ACTOR_MISMATCH'); return true; },
  );
  assert.equal(port.commands.length, before);
});

test('cancellation from another service instance stops the application before the next cut', async () => {
  const store = new InMemoryProposalStore();
  const port = receiptPort();
  const planner = service(port.port, store);
  const draft = await planner.propose(operator(), { projectId: PROJECT, brief: 'House at dusk.' });

  let release!: () => void;
  port.setGate(new Promise<void>(resolve => { release = resolve; }));
  const running = service(port.port, store).accept(operator(), { projectId: PROJECT, proposalId: draft.id, expectedRevision: 0 });
  await new Promise(resolve => setTimeout(resolve, 10));
  const cancelled = await service(port.port, store).cancel(operator(), { projectId: PROJECT, proposalId: draft.id });
  assert.equal(cancelled.cancelRequested, true);
  release();

  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(port.commands.length, 1, 'the in-flight cut finishes; nothing new starts after cancellation');
  assert.deepEqual(result.items.map(item => item.state), ['created', 'pending', 'pending']);
});

test('acceptance freezes the exact payload and the accepting actor, and resumes replay those bytes', async () => {
  const store = new InMemoryProposalStore();
  const port = receiptPort();
  const planner = service(port.port, store);
  const draft = await planner.propose(operator(), { projectId: PROJECT, brief: 'House at dusk.' });
  const accepted = await planner.accept(operator(), { projectId: PROJECT, proposalId: draft.id, expectedRevision: 0 });

  const frozen = await store.loadFrozen(PROJECT, draft.id);
  assert.equal(frozen.length, 3);
  for (const [index, entry] of frozen.entries()) {
    assert.equal(entry.commandId, stableCommandId(draft.id, accepted.items[index].itemId));
    assert.equal(entry.actorId, OPERATOR);
    assert.equal(entry.payload.commandId, entry.commandId);
    assert.equal(entry.payload.title, draft.items[index].title);
    assert.equal(entry.payloadHash.length, 64);
  }
  assert.deepEqual(port.commands.map(entry => entry.command.commandId), frozen.map(entry => entry.commandId));
});

test('an edit after acceptance cannot change what is applied', async () => {
  const store = new InMemoryProposalStore();
  const port = receiptPort();
  const planner = service(port.port, store);
  const draft = await planner.propose(operator(), { projectId: PROJECT, brief: 'House at dusk.' });
  const failing = async () => { throw new Error('socket hang up'); };
  const accepted = await service(failing as any, store).accept(operator(), { projectId: PROJECT, proposalId: draft.id, expectedRevision: 0 });
  const frozenBefore = await store.loadFrozen(PROJECT, draft.id);

  await assert.rejects(
    planner.revise(operator(), {
      projectId: PROJECT, proposalId: draft.id, expectedRevision: accepted.revision,
      items: accepted.items.map(item => ({
        itemId: item.itemId, title: 'Rewritten', direction: item.direction,
        startDescription: item.startDescription, endDescription: item.endDescription,
        durationSeconds: item.durationSeconds, continuityNotes: item.continuityNotes,
      })),
    }),
    (error: any) => { assert.equal(error.code, 'PROPOSAL_STATE'); return true; },
  );
  assert.deepEqual(await store.loadFrozen(PROJECT, draft.id), frozenBefore);
});

// ---------------------------------------------------------------------------------------------
// Continue-shot: concurrent calls and stale writers
// ---------------------------------------------------------------------------------------------

const intentHash = () => continueShotIntentHash({
  projectId: PROJECT, sourceTakeId: TAKE, sourceAssetId: VIDEO, sourceAssetSha256: VIDEO_SHA,
  title: 'Continue: take one', prompt: 'A figure crosses the threshold.', actorId: OPERATOR, actorKind: 'operator',
});

const base = { operationId: OP, projectId: PROJECT, sourceTakeId: TAKE, title: 'Continue: take one', prompt: 'A figure crosses the threshold.' };

function continueWorld() {
  const journal = createMemoryContinueShotJournal();
  const extractCalls: any[] = [];
  const commands: any[] = [];
  let gate: Promise<void> | null = null;
  const assets: any[] = [{ id: VIDEO, projectId: PROJECT, filename: 'take.mp4', kind: 'video', origin: 'generated', sha256: VIDEO_SHA, mediaUrl: `/api/media/${VIDEO}`, width: 64, height: 48, durationSeconds: 5 }];
  const shots: any[] = [{ id: SOURCE_SHOT, projectId: PROJECT, title: 'Take one', prompt: 'A figure enters.', revision: 1, controls: { ...defaultControls }, bindings: { firstFrameAssetId: null, lastFrameAssetId: null }, selectedTakeId: null, selectionRevision: 0 }];
  const ports = {
    journal,
    now: () => '2026-01-01T00:00:00.000Z',
    getWorkspace: (async () => ({
      project: { id: PROJECT, name: 'Film', brief: '', revision: 1 },
      shots: structuredClone(shots), assets: structuredClone(assets),
      takes: [{ id: TAKE, projectId: PROJECT, shotId: SOURCE_SHOT, attemptId: 'a0000000-0000-4000-8000-000000000001', assetId: VIDEO, createdAt: '2026-01-01T00:00:00.000Z' }],
      attempts: [], reviews: [], exports: [], capabilities: [],
    })) as any,
    extractReferenceFrame: (async () => {
      extractCalls.push(1);
      if (gate) await gate;
      const derived = { id: '70000000-0000-4000-8000-000000000001', projectId: PROJECT, filename: 'frame.png', kind: 'image', origin: 'imported', sha256: 'b'.repeat(64), mediaUrl: '/api/media/f', width: 8, height: 8, provenance: { kind: 'extracted-frame', frame: 'last', sourceAssetId: VIDEO, sourceSha256: VIDEO_SHA } };
      assets.push(derived);
      return derived;
    }) as any,
    command: (async (_actor: unknown, cmd: any) => {
      commands.push(cmd);
      if (cmd.type === 'shot.create') {
        const created = { id: '80000000-0000-4000-8000-000000000001', projectId: PROJECT, title: cmd.title, prompt: cmd.prompt, revision: 1, controls: { ...defaultControls }, bindings: { firstFrameAssetId: null, lastFrameAssetId: null }, selectedTakeId: null, selectionRevision: 0 };
        shots.push(created);
        return { commandId: cmd.commandId, projectId: PROJECT, resourceId: created.id, revision: 1 };
      }
      const shot = shots.find(item => item.id === cmd.shotId)!;
      shot.bindings = { ...shot.bindings, ...cmd.patch.bindings };
      shot.revision += 1;
      return { commandId: cmd.commandId, projectId: PROJECT, resourceId: shot.id, revision: shot.revision };
    }) as any,
  };
  return { ports, extractCalls, commands, journal, setGate(promise: Promise<void> | null) { gate = promise; } };
}

test('two concurrent continuations: the second is refused before extraction, so only one frame exists', async () => {
  const world = continueWorld();
  let release!: () => void;
  world.setGate(new Promise<void>(resolve => { release = resolve; }));

  const first = createContinueShot(world.ports).continueShot(operator(), base);
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = await createContinueShot(world.ports).continueShot(operator(), base).then(
    value => ({ value }), (error: any) => ({ error }),
  );
  assert.ok('error' in second);
  assert.equal((second as any).error.code, 'CONTINUE_IN_PROGRESS');
  assert.equal(world.extractCalls.length, 1, 'the refused call must not extract: absence while in flight is not proof of safety');

  release();
  assert.equal((await first).status, 'completed');
  assert.equal(world.extractCalls.length, 1);
  assert.equal(world.commands.filter((cmd: any) => cmd.type === 'shot.create').length, 1);
});

test('a superseded continuation cannot write its result', async () => {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const journal = createMemoryContinueShotJournal({ now: () => clock });
  const record: ContinueShotRecord = {
    operationId: OP, projectId: PROJECT, actorId: OPERATOR, actorKind: 'operator', intentHash: intentHash(),
    sourceTakeId: TAKE, sourceShotId: SOURCE_SHOT, sourceAssetId: VIDEO, sourceAssetSha256: VIDEO_SHA,
    title: base.title, prompt: base.prompt, status: 'extracting', extractionDispatched: true,
    extractedAssetId: null, shotId: null, shotRevision: null, createPayload: null, createPayloadHash: null,
    bindPayload: null, bindPayloadHash: null, blockers: [], message: null, resumable: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const stale = await journal.begin(record, { ttlMs: 250 });
  assert.ok(stale.lease);
  clock += 1_000;
  const fresh = await journal.begin(record, { ttlMs: 60_000 });
  assert.ok(fresh.lease);
  assert.equal(fresh.lease!.fence, stale.lease!.fence + 1);

  const staleGuard = { ownerToken: stale.lease!.ownerToken, fence: stale.lease!.fence };
  const freshGuard = { ownerToken: fresh.lease!.ownerToken, fence: fresh.lease!.fence };
  assert.equal(await journal.save({ ...record, status: 'extracted', extractedAssetId: '70000000-0000-4000-8000-000000000001' }, ['extracting'], staleGuard), null);
  const saved = await journal.save({ ...record, status: 'extracted', extractedAssetId: '70000000-0000-4000-8000-000000000001' }, ['extracting'], freshGuard);
  assert.equal(saved?.status, 'extracted');
  assert.equal((await journal.load(OP))?.extractedAssetId, '70000000-0000-4000-8000-000000000001');
});

// ---------------------------------------------------------------------------------------------
// SQL adapter semantics (scripted executor: single guarded statements; no PostgreSQL executed)
// ---------------------------------------------------------------------------------------------

type Call = { text: string; params: unknown[] };
function scripted(handler: (text: string, params: unknown[]) => any) {
  const calls: Call[] = [];
  const sql = {
    async query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      const result = await handler(text, params);
      return { rows: [], rowCount: 0, ...(result ?? {}) };
    },
  };
  return { sql, calls };
}

test('lease acquisition is one atomic statement with expiry predicate and fence increment', async () => {
  const { sql, calls } = scripted(text => {
    if (text.includes('INSERT INTO flume.authoring_operation_leases')) return { rows: [] };
    return { rows: [] };
  });
  const lock = createSqlAuthoringOperationLock(sql);
  const result = await lock.acquire({ scope: 'continue-shot', operationId: OP, projectId: PROJECT, ttlMs: 30_000 });

  assert.equal(result.acquired, false);
  assert.equal(calls.length, 2, 'acquire then a read of the competing owner; never a read-then-write');
  assert.match(calls[0].text, /ON CONFLICT \(scope, operation_id\) DO UPDATE/);
  assert.match(calls[0].text, /fence = current\.fence \+ 1/);
  assert.match(calls[0].text, /current\.lease_expires_at <= clock_timestamp\(\)/);
  assert.match(calls[0].text, /current\.project_id = EXCLUDED\.project_id/);
  assert.match(calls[1].text, /FROM flume\.authoring_operation_leases WHERE scope = \$1 AND operation_id = \$2/);
});

test('storyboard acceptance is a single CAS statement that freezes payload and actor, and returns null on a lost CAS', async () => {
  const { sql, calls } = scripted(text =>
    text.includes('WITH target AS') ? { rows: [{ frozen_count: 3, accepted_count: 0 }] } : { rows: [] });
  const store = createSqlStoryboardStore(sql);
  const commands = [0, 1, 2].map(index => ({
    itemId: `0000000${index}-0000-4000-8000-00000000000${index}`,
    commandId: `1111111${index}-0000-4000-8000-00000000000${index}`,
    payload: { type: 'shot.create' as const, commandId: `1111111${index}-0000-4000-8000-00000000000${index}`, projectId: PROJECT, title: 'Cut', prompt: 'Prompt' },
    payloadHash: 'a'.repeat(64),
  }));

  const accepted = await store.accept({
    projectId: PROJECT, proposalId: OP, expectedRevision: 2, acceptedBy: OPERATOR, acceptedByKind: 'operator', commands,
  });
  assert.equal(accepted, null, 'a lost CAS must not be reported as acceptance');
  assert.equal(calls.length, 1, 'no second write after losing the CAS');

  const statement = calls[0].text;
  assert.match(statement, /status = 'draft' AND revision = \$3 AND cancel_requested = false/);
  assert.match(statement, /FOR UPDATE/);
  assert.match(statement, /frozen_payload = f\.payload/);
  assert.match(statement, /command_actor_id = \$4, command_actor_kind = \$5/);
  assert.match(statement, /\(SELECT count\(\*\) FROM frozen\)/);
  assert.equal(calls[0].params[2], 2, 'the caller revision is the CAS parameter, never re-read');
  assert.equal(calls[0].params[3], OPERATOR);
});

test('storyboard item claim and settle carry the lease owner AND fence; finish is fenced too', async () => {
  const { sql, calls } = scripted(() => ({ rows: [] }));
  const store = createSqlStoryboardStore(sql);
  const lease = {
    scope: 'storyboard.apply' as const, operationId: OP, projectId: PROJECT,
    ownerToken: OTHER_OPERATOR, fence: 4, expiresAt: '2026-01-01T00:01:00.000Z',
  };

  assert.equal(await store.claimItem({ projectId: PROJECT, proposalId: OP, itemId: SEED_ITEM, allowFailed: false, lease }), false);
  assert.equal(await store.settleItem({ projectId: PROJECT, proposalId: OP, itemId: SEED_ITEM, state: 'created', shotId: null, code: null, lease }), false);
  assert.equal(await store.finish({ projectId: PROJECT, proposalId: OP, status: 'applied', failure: null, lease }), null);

  assert.match(calls[0].text, /SET state = 'issued', issued_fence = \$5/);
  assert.match(calls[0].text, /i\.state = ANY\(\$4::text\[\]\)/);
  assert.match(calls[0].text, /p\.cancel_requested OR p\.status IN \('cancelled', 'applied'\)/);
  assert.match(calls[0].text, /l\.owner_token = \$7 AND l\.fence = \$5/);
  assert.match(calls[1].text, /i\.state = 'issued' AND i\.issued_fence = \$7/);
  assert.match(calls[2].text, /l\.owner_token = \$6 AND l\.fence = \$7/);
});

test('the SQL journal save is one fenced compare-and-set against the live lease and reports a lost race as null', async () => {
  const { sql, calls } = scripted(() => ({ rows: [] }));
  const journal = createSqlContinueShotJournal(sql);
  const saved = await journal.save({
    operationId: OP, projectId: PROJECT, actorId: OPERATOR, actorKind: 'operator', intentHash: intentHash(),
    sourceTakeId: TAKE, sourceShotId: SOURCE_SHOT, sourceAssetId: VIDEO, sourceAssetSha256: VIDEO_SHA,
    title: base.title, prompt: base.prompt, status: 'creating', extractionDispatched: true,
    extractedAssetId: null, shotId: null, shotRevision: null, createPayload: null, createPayloadHash: null,
    bindPayload: null, bindPayloadHash: null, blockers: [], message: null, resumable: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }, ['extracted'], { ownerToken: OTHER_OPERATOR, fence: 3 });

  assert.equal(saved, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /j\.status = ANY\(\$2::text\[\]\)/);
  // The fence lives on flume.authoring_operation_leases — the authority isActive() consults — and
  // the journal's own owner_token/fence columns are a mirror this statement writes, never reads.
  // Behavioural coverage for both halves (live save, released/expired/stale rejection, renewal) is
  // in continue-shot-journal-lease.test.ts; a string match alone was what let the bug ship.
  assert.match(calls[0].text, /UPDATE flume\.authoring_operation_leases l/);
  assert.match(calls[0].text, /l\.owner_token = \$15/);
  assert.match(calls[0].text, /l\.fence = \$16/);
  assert.match(calls[0].text, /l\.released_at IS NULL/);
  assert.match(calls[0].text, /l\.lease_expires_at > clock_timestamp\(\)/);
  assert.match(calls[0].text, /l\.project_id = \$19/);
  assert.match(calls[0].text, /j\.project_id = \$19/);
  assert.match(calls[0].text, /SET lease_expires_at = clock_timestamp\(\) \+ \(\$17::int \* interval '1 millisecond'\)/);
  assert.match(calls[0].text, /owner_token = renewed\.owner_token/);
  assert.match(calls[0].text, /FROM renewed/);
  assert.doesNotMatch(calls[0].text, /j\.owner_token = \$15/, 'the mirror column is written, never used as the guard');
  assert.deepEqual(calls[0].params[1], ['extracted']);
  assert.equal(calls[0].params[14], OTHER_OPERATOR);
  assert.equal(calls[0].params[15], 3);
});

test('a journal row whose command was dispatched but unsettled reads back as UNKNOWN, not pending', async () => {
  const { sql } = scripted(text => {
    if (!text.includes('FROM flume.continue_shot_journal')) return { rows: [] };
    return {
      rows: [{
        operation_id: OP, project_id: PROJECT, actor_id: OPERATOR, actor_kind: 'operator',
        intent_hash: intentHash(), source_take_id: TAKE, source_shot_id: SOURCE_SHOT,
        source_asset_id: VIDEO, source_asset_sha256: VIDEO_SHA, title: base.title, prompt: base.prompt,
        status: 'creating', extraction_dispatched: true, extracted_asset_id: null, shot_id: null,
        shot_revision: null, create_payload: null, create_payload_hash: null, bind_payload: null,
        bind_payload_hash: null, blockers: [], message: null, resumable: true,
        updated_at: '2026-01-01T00:00:00.000Z',
      }],
    };
  });
  const journal = createSqlContinueShotJournal(sql);
  const loaded = await journal.load(OP);
  assert.equal(loaded?.status, 'creating');
  assert.equal(loaded?.extractionDispatched, true, 'the dispatched marker survives a restart');
});

test('the SQL storyboard store maps an in-flight item to an UNKNOWN outcome', async () => {
  const { sql } = scripted(text => {
    if (!text.includes('FROM flume.storyboard_proposals p')) return { rows: [] };
    return {
      rows: [{
        project_id: PROJECT, id: OP, status: 'applying', revision: 0,
        bounds: { minSeconds: 1, maxSeconds: 60, maxShots: 12, maxTotalSeconds: 600 },
        failure: null, cancel_requested: false, planner_model_id: 'fixture/planner-1',
        request_hash: 'a'.repeat(64), proposed_by: OPERATOR, proposed_by_kind: 'operator',
        accepted_by: OPERATOR, created_at: '2026-01-01T00:00:00.000Z',
        items: [{
          item_id: SEED_ITEM, title: 'Cut', direction: 'Push.', start_description: 'A', end_description: 'B',
          duration_seconds: 4, continuity_notes: '', state: 'issued', shot_id: null,
          command_id: stableCommandId(OP, SEED_ITEM), code: null,
        }],
      }],
    };
  });
  const store = createSqlStoryboardStore(sql);
  const proposal = await store.load(PROJECT, OP);
  assert.equal(proposal?.items[0].state, 'unknown');
  assert.equal(proposal?.items[0].code, 'COMMAND_OUTCOME_UNKNOWN');
  assert.equal(proposal?.items[0].shotId, null);
});

const SEED_ITEM = '20000000-0000-4000-8000-000000000001';
