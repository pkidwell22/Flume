// Regression tests for the public continuation projection (QA verdict continuation-recovery-01,
// defects D1a / D1b / D1c). LABELED FIXTURES ONLY: the journal is the in-memory fixture
// (createMemoryContinueShotJournal — real fence/expiry semantics, no durable store), and the media
// and command ports are in-memory stubs. No PostgreSQL, no scratch database, no provider call.
//
// Contract under test: the read surface must report committed progress plus *observed* liveness.
//  - 'partial' requires committed progress (an extracted frame or a created shot).
//  - 'in_progress' requires a verified live lease; a row nobody holds is never in progress.
//  - a dispatched extraction with no frame and no live lease is 'unknown' / nextStep 'reconcile'
//    and offers no resume, because a retry could duplicate the frame.
//  - reads never advance the journal, and a journal that cannot report liveness fails closed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ServiceError, defaultControls } from '../src/contracts.ts';
import {
  continueShotIntentHash,
  createContinueShot,
  createMemoryContinueShotJournal,
  type ContinueShotJournal,
  type ContinueShotPorts,
  type ContinueShotRecord,
} from '../src/continue-shot.ts';

const PROJECT = '10000000-0000-4000-8000-000000000001';
const OPERATOR = '30000000-0000-4000-8000-000000000001';
const SOURCE_SHOT = '40000000-0000-4000-8000-000000000001';
const TAKE = '50000000-0000-4000-8000-000000000001';
const VIDEO = '60000000-0000-4000-8000-000000000001';
const FRAME = '70000000-0000-4000-8000-000000000001';
const NEW_SHOT = '80000000-0000-4000-8000-000000000001';
const OP = '90000000-0000-4000-8000-000000000001';
const VIDEO_SHA = 'a'.repeat(64);
const PROMPT = 'PRIVATE-PROMPT: a figure crosses the threshold.';
const TITLE = 'PRIVATE-TITLE: take one continued';

const operator = () => ({ id: OPERATOR, kind: 'operator' as const, projectIds: [PROJECT] });
const base = { operationId: OP, projectId: PROJECT, sourceTakeId: TAKE, title: TITLE, prompt: PROMPT };

const sourceShot = () => ({ id: SOURCE_SHOT, projectId: PROJECT, title: 'Take one', prompt: 'A figure enters.', revision: 1, controls: { ...defaultControls }, bindings: { firstFrameAssetId: null, lastFrameAssetId: null }, selectedTakeId: null, selectionRevision: 0 });
const videoAsset = () => ({ id: VIDEO, projectId: PROJECT, filename: 'take.mp4', kind: 'video' as const, origin: 'generated' as const, sha256: VIDEO_SHA, mediaUrl: `/api/media/${VIDEO}`, width: 64, height: 48, durationSeconds: 5 });
const derivedFrame = () => ({ id: FRAME, projectId: PROJECT, filename: 'last-frame.png', kind: 'image' as const, origin: 'imported' as const, sha256: 'b'.repeat(64), mediaUrl: `/api/media/${FRAME}`, width: 64, height: 48, provenance: { kind: 'extracted-frame', frame: 'last', sourceAssetId: VIDEO, sourceSha256: VIDEO_SHA } });

const record = (patch: Partial<ContinueShotRecord> = {}): ContinueShotRecord => ({
  operationId: OP, projectId: PROJECT, actorId: OPERATOR, actorKind: 'operator',
  intentHash: continueShotIntentHash({ projectId: PROJECT, sourceTakeId: TAKE, sourceAssetId: VIDEO, sourceAssetSha256: VIDEO_SHA, title: TITLE, prompt: PROMPT, actorId: OPERATOR, actorKind: 'operator' }),
  sourceTakeId: TAKE, sourceShotId: SOURCE_SHOT, sourceAssetId: VIDEO, sourceAssetSha256: VIDEO_SHA,
  title: TITLE, prompt: PROMPT, status: 'pending', extractionDispatched: false, extractedAssetId: null,
  shotId: null, shotRevision: null, createPayload: null, createPayloadHash: null, bindPayload: null, bindPayloadHash: null,
  blockers: [], message: null, resumable: true, updatedAt: '2026-01-01T00:00:00.000Z', ...patch,
});

type ExtractMode = 'ok' | 'pre_dispatch';

class World {
  shots: any[] = [sourceShot()];
  assets: any[] = [videoAsset()];
  takes: any[] = [{ id: TAKE, projectId: PROJECT, shotId: SOURCE_SHOT, attemptId: 'a0000000-0000-4000-8000-000000000001', assetId: VIDEO, createdAt: '2026-01-01T00:00:00.000Z' }];
  extractMode: ExtractMode = 'ok';
  extractCalls = 0;
  commands: any[] = [];
  createError: Error | null = null;
  clock = Date.parse('2026-01-01T00:00:00.000Z');
  journal = createMemoryContinueShotJournal({ now: () => this.clock });
  ports: ContinueShotPorts;
  service: ReturnType<typeof createContinueShot>;
  constructor() {
    this.ports = {
      journal: this.journal,
      now: () => '2026-01-01T00:00:00.000Z',
      getWorkspace: (async () => ({
        project: { id: PROJECT, name: 'Film', brief: '', revision: 1 },
        shots: structuredClone(this.shots), assets: structuredClone(this.assets), takes: structuredClone(this.takes),
        attempts: [], reviews: [], exports: [], capabilities: [],
      })) as any,
      extractReferenceFrame: (async (_actor: unknown, input: any) => {
        this.extractCalls += 1;
        if (this.extractMode === 'pre_dispatch') throw new ServiceError('MEDIA_UNAVAILABLE', 'The media extractor is not running.', 503);
        const derived = derivedFrame();
        this.assets.push(derived);
        return structuredClone(derived);
      }) as any,
      command: (async (_actor: unknown, cmd: any) => {
        this.commands.push(structuredClone(cmd));
        if (cmd.type === 'shot.create' && this.createError) throw this.createError;
        if (cmd.type === 'shot.create') {
          const created = { id: NEW_SHOT, projectId: cmd.projectId, title: cmd.title, prompt: cmd.prompt, revision: 1, controls: { ...defaultControls }, bindings: { firstFrameAssetId: null, lastFrameAssetId: null }, selectedTakeId: null, selectionRevision: 0 };
          this.shots.push(created);
          return { commandId: cmd.commandId, projectId: cmd.projectId, resourceId: NEW_SHOT, revision: 1 };
        }
        const shot = this.shots.find(item => item.id === cmd.shotId);
        shot.bindings = { ...shot.bindings, ...cmd.patch.bindings };
        shot.revision += 1;
        return { commandId: cmd.commandId, projectId: cmd.projectId, resourceId: shot.id, revision: shot.revision };
      }) as any,
    };
    this.service = createContinueShot(this.ports);
  }
}

/** Lease that has expired: the row exists, nobody holds it, nothing is running. */
async function seedExpired(world: World, operationId: string, patch: Partial<ContinueShotRecord>): Promise<void> {
  await world.journal.begin(record({ operationId, ...patch }), { ownerToken: randomUUID(), ttlMs: 250 });
  world.clock += 60_000;
}

/** Lease a running worker still holds. */
async function seedLive(world: World, operationId: string, patch: Partial<ContinueShotRecord>): Promise<void> {
  await world.journal.begin(record({ operationId, ...patch }), { ownerToken: randomUUID(), ttlMs: 600_000 });
}

const read = (world: World, operationId = OP) => world.service.readContinueShot(operator(), { projectId: PROJECT, operationId });

test('a blocked, resumable continuation with no committed progress reads back as blocked, not partial', async () => {
  const world = new World();
  world.extractMode = 'pre_dispatch';
  const outcome = await world.service.continueShot(operator(), base);
  const before = await world.journal.load(OP);
  const view = await read(world);

  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.code, 'EXTRACTION_FAILED');
  assert.equal(before?.status, 'blocked');
  assert.equal(before?.extractionDispatched, false, 'a provable pre-dispatch refusal clears the marker');
  assert.equal(before?.extractedAssetId, null);
  assert.equal(before?.shotId, null);

  // Nothing was applied, so the read must not claim progress, and it must agree with the write outcome.
  assert.equal(view.status, 'blocked', 'no committed progress means no "partial"');
  assert.equal(view.status, outcome.status, 'read and write describe the same record the same way');
  assert.equal(view.resumable, true, 'resumable stays the truthful signal');
  assert.equal(view.active, false);
  assert.equal(view.nextStep, 'extract');
  assert.deepEqual(view.blockers, ['EXTRACTION_FAILED']);

  // The read is not allowed to advance the journal.
  const after = await world.journal.load(OP);
  assert.equal(after?.status, before?.status);
  assert.equal(after?.updatedAt, before?.updatedAt);
});

test('committed progress is not lost: an extracted frame with a failed create still reads back as partial', async () => {
  const world = new World();
  world.createError = new ServiceError('COMMAND_CONFLICT', 'The create was refused.', 409);
  const outcome = await world.service.continueShot(operator(), base);
  const before = await world.journal.load(OP);
  const view = await read(world);

  assert.equal(outcome.status, 'partial');
  assert.equal(outcome.code, 'CREATE_FAILED');
  assert.equal(before?.status, 'blocked');
  assert.equal(before?.extractedAssetId, FRAME);

  assert.equal(view.status, 'partial', 'an extracted frame is committed progress');
  assert.equal(view.resumable, true);
  assert.equal(view.active, false);
  assert.equal(view.nextStep, 'create');
  assert.equal(view.extractedAssetId, FRAME);
  assert.equal(view.shotId, null);
});

test('a dispatched extraction with no frame and no live lease reads as unknown and refuses resume', async () => {
  const world = new World();
  // Exactly what a crashed worker leaves behind: the durable "dispatched" marker, no holder.
  await seedExpired(world, OP, { status: 'extracting', extractionDispatched: true, resumable: true });
  const before = await world.journal.load(OP);

  const view = await read(world);
  assert.equal(view.active, false);
  assert.equal(view.status, 'unknown', 'a dispatched extraction with no result is not a safe retry');
  assert.equal(view.nextStep, 'reconcile', 'the honest next step is reconciliation, not extraction');
  assert.equal(view.resumable, false, 'no ordinary resume may be advertised');

  // Reading changed nothing.
  const afterRead = await world.journal.load(OP);
  assert.equal(afterRead?.status, 'extracting');
  assert.equal(afterRead?.updatedAt, before?.updatedAt);

  // A resume must be refused before any port is touched: no second extraction, no shot command.
  const extractsBefore = world.extractCalls, commandsBefore = world.commands.length;
  await assert.rejects(
    world.service.resumeContinueShot(operator(), { projectId: PROJECT, operationId: OP }),
    (error: unknown) => error instanceof ServiceError && error.code === 'CONTINUE_NOT_RESUMABLE' && error.status === 409,
  );
  assert.equal(world.extractCalls - extractsBefore, 0, 'resume must not extract again');
  assert.equal(world.commands.length - commandsBefore, 0, 'resume must not create or bind');

  const stable = await read(world);
  assert.equal(stable.status, 'unknown');
  assert.equal(stable.resumable, false);
});

test('no journal row without a live lease is projected as in_progress', async () => {
  const rows: Array<{ label: string; patch: Partial<ContinueShotRecord>; status: string; resumable: boolean; nextStep: string }> = [
    { label: 'pending before dispatch', patch: { status: 'pending', extractionDispatched: false }, status: 'blocked', resumable: true, nextStep: 'extract' },
    { label: 'extracting before the dispatch marker', patch: { status: 'extracting', extractionDispatched: false }, status: 'blocked', resumable: true, nextStep: 'extract' },
    { label: 'extracting after the dispatch marker', patch: { status: 'extracting', extractionDispatched: true }, status: 'unknown', resumable: false, nextStep: 'reconcile' },
    { label: 'creating with no recorded frame', patch: { status: 'creating', extractionDispatched: false }, status: 'blocked', resumable: true, nextStep: 'extract' },
    { label: 'binding with no recorded shot', patch: { status: 'binding', extractionDispatched: false }, status: 'blocked', resumable: true, nextStep: 'extract' },
    { label: 'blocked after a refusal', patch: { status: 'blocked', extractionDispatched: false }, status: 'blocked', resumable: true, nextStep: 'extract' },
    { label: 'extracted, no shot yet', patch: { status: 'extracted', extractionDispatched: true, extractedAssetId: FRAME }, status: 'partial', resumable: true, nextStep: 'create' },
    { label: 'created, not bound yet', patch: { status: 'created', extractionDispatched: true, extractedAssetId: FRAME, shotId: NEW_SHOT }, status: 'partial', resumable: true, nextStep: 'bind' },
    { label: 'binding in flight', patch: { status: 'binding', extractionDispatched: true, extractedAssetId: FRAME, shotId: NEW_SHOT }, status: 'partial', resumable: true, nextStep: 'bind' },
    { label: 'extraction outcome unknown', patch: { status: 'extraction_unknown', extractionDispatched: true, resumable: false }, status: 'unknown', resumable: false, nextStep: 'reconcile' },
    { label: 'completed', patch: { status: 'completed', extractionDispatched: true, extractedAssetId: FRAME, shotId: NEW_SHOT, resumable: false }, status: 'completed', resumable: false, nextStep: 'done' },
  ];

  for (const [index, row] of rows.entries()) {
    const world = new World();
    const operationId = `90000000-0000-4000-8000-0000000000${String(index + 10).padStart(2, '0')}`;
    await seedExpired(world, operationId, row.patch);
    const view = await read(world, operationId);

    assert.equal(view.active, false, `${row.label}: an expired lease is not a live worker`);
    assert.notEqual(view.status, 'in_progress', `${row.label}: nothing is running, so nothing is in progress`);
    assert.equal(view.status, row.status, `${row.label}: status`);
    assert.equal(view.resumable, row.resumable, `${row.label}: resumable`);
    assert.equal(view.nextStep, row.nextStep, `${row.label}: nextStep`);
    // A resume is only ever offered for a state the read calls resumable.
    if (view.resumable) assert.ok(view.status === 'blocked' || view.status === 'partial', `${row.label}: only real work can be resumed`);
  }
});

test('a verified live lease is the only way to read in_progress', async () => {
  const world = new World();
  await seedLive(world, OP, { status: 'extracting', extractionDispatched: true });

  const view = await read(world);
  assert.equal(view.active, true, 'a live lease is observed, not assumed');
  assert.equal(view.status, 'in_progress', 'a live worker really is in progress');
  assert.equal(view.resumable, false, 'another request may not resume a live operation');

  await assert.rejects(
    world.service.resumeContinueShot(operator(), { projectId: PROJECT, operationId: OP }),
    (error: unknown) => error instanceof ServiceError && error.code === 'CONTINUE_IN_PROGRESS' && error.status === 409,
  );
});

test('a journal that cannot report liveness fails closed without inventing progress or resume', async () => {
  const world = new World();
  // A journal that predates the optional read-only probe. Not being able to ask is not a "no".
  const journalWithoutProbe: ContinueShotJournal = {
    load: operationId => world.journal.load(operationId),
    begin: (recordValue, options) => world.journal.begin(recordValue, options),
    save: (recordValue, from, guard) => world.journal.save(recordValue, from, guard),
    release: (operationId, guard) => world.journal.release(operationId, guard),
  };
  const service = createContinueShot({ ...world.ports, journal: journalWithoutProbe });

  await world.journal.begin(record({ status: 'pending', extractionDispatched: false }), { ownerToken: randomUUID(), ttlMs: 600_000 });

  const view = await service.readContinueShot(operator(), { projectId: PROJECT, operationId: OP });
  assert.equal(view.active, false);
  assert.equal(view.status, 'unknown', 'liveness is unknown, so the state is unknown');
  assert.notEqual(view.status, 'in_progress', 'an unverifiable lease is never claimed as running');
  assert.equal(view.resumable, false, 'no resume is advertised without verified idleness');
  assert.equal(view.nextStep, 'reconcile');

  const extractsBefore = world.extractCalls, commandsBefore = world.commands.length;
  await assert.rejects(
    service.resumeContinueShot(operator(), { projectId: PROJECT, operationId: OP }),
    (error: unknown) => error instanceof ServiceError && error.code === 'CONTINUE_NOT_RESUMABLE' && error.status === 409,
  );
  assert.equal(world.extractCalls, extractsBefore);
  assert.equal(world.commands.length, commandsBefore);

  // Fail closed must not throw away results that are already committed.
  const PARTIAL_OP = '90000000-0000-4000-8000-0000000000c1';
  const DONE_OP = '90000000-0000-4000-8000-0000000000c2';
  await world.journal.begin(record({ operationId: PARTIAL_OP, status: 'blocked', extractionDispatched: true, extractedAssetId: FRAME }), { ownerToken: randomUUID(), ttlMs: 600_000 });
  await world.journal.begin(record({ operationId: DONE_OP, status: 'completed', extractionDispatched: true, extractedAssetId: FRAME, shotId: NEW_SHOT, resumable: false }), { ownerToken: randomUUID(), ttlMs: 600_000 });
  const partial = await service.readContinueShot(operator(), { projectId: PROJECT, operationId: PARTIAL_OP });
  const done = await service.readContinueShot(operator(), { projectId: PROJECT, operationId: DONE_OP });
  assert.equal(partial.status, 'partial', 'an extracted frame stays visible even without a liveness probe');
  assert.equal(partial.extractedAssetId, FRAME);
  assert.equal(partial.resumable, false, 'but it is not resumable while liveness is unknown');
  assert.equal(done.status, 'completed', 'a completed operation stays completed');
});

test('a liveness probe that throws is treated as unknown, not as idle', async () => {
  const world = new World();
  const failingProbe: ContinueShotJournal = {
    load: operationId => world.journal.load(operationId),
    begin: (recordValue, options) => world.journal.begin(recordValue, options),
    save: (recordValue, from, guard) => world.journal.save(recordValue, from, guard),
    release: (operationId, guard) => world.journal.release(operationId, guard),
    isActive: async () => { throw new Error('lease store unavailable'); },
  };
  const service = createContinueShot({ ...world.ports, journal: failingProbe });
  await seedExpired(world, OP, { status: 'pending', extractionDispatched: false });

  const view = await service.readContinueShot(operator(), { projectId: PROJECT, operationId: OP });
  assert.equal(view.status, 'unknown', 'a failed probe is not proof that nothing runs');
  assert.equal(view.resumable, false);
  assert.equal(view.active, false);
});

test('a recovery read performs no journal write and acquires no lease', async () => {
  const world = new World();
  await seedExpired(world, OP, { status: 'extracting', extractionDispatched: true });
  const calls = { begin: 0, save: 0, release: 0, load: 0, isActive: 0 };
  const counted: ContinueShotJournal = {
    load: operationId => { calls.load += 1; return world.journal.load(operationId); },
    begin: (recordValue, options) => { calls.begin += 1; return world.journal.begin(recordValue, options); },
    save: (recordValue, from, guard) => { calls.save += 1; return world.journal.save(recordValue, from, guard); },
    release: (operationId, guard) => { calls.release += 1; return world.journal.release(operationId, guard); },
    isActive: async operationId => { calls.isActive += 1; return world.journal.isActive!(operationId); },
  };
  const service = createContinueShot({ ...world.ports, journal: counted });

  await service.readContinueShot(operator(), { projectId: PROJECT, operationId: OP });
  assert.deepEqual(calls, { begin: 0, save: 0, release: 0, load: 1, isActive: 1 }, 'reading loads and probes, and writes nothing');
  assert.equal(world.extractCalls, 0);
  assert.equal(world.commands.length, 0);
});
