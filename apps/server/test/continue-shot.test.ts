import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { commandSchema, defaultControls, ServiceError, uuid } from '../src/contracts.ts';
import {
  continueShotIntentHash,
  createContinueShot,
  createMemoryContinueShotJournal,
  deriveContinueShotCommandId,
  type ContinueShotJournalStatus,
  type ContinueShotPorts,
  type ContinueShotRecord,
} from '../src/continue-shot.ts';

// Fixture ids and actors. Every command emitted by the service is validated with the real
// commandSchema inside the fake command port, so these tests exercise the actual command shapes.
// The journal is the labelled in-memory fixture: these are NOT live-database evidence.
const PROJECT = '10000000-0000-4000-8000-000000000001';
const OTHER_PROJECT = '10000000-0000-4000-8000-000000000002';
const OPERATOR = '30000000-0000-4000-8000-000000000001';
const OTHER_OPERATOR = '30000000-0000-4000-8000-000000000002';
const SOURCE_SHOT = '40000000-0000-4000-8000-000000000001';
const TAKE = '50000000-0000-4000-8000-000000000001';
const OTHER_TAKE = '50000000-0000-4000-8000-000000000002';
const VIDEO = '60000000-0000-4000-8000-000000000001';
const FRAME = '70000000-0000-4000-8000-000000000001';
const SECOND_FRAME = '70000000-0000-4000-8000-000000000002';
const NEW_SHOT = '80000000-0000-4000-8000-000000000001';
const OP = '90000000-0000-4000-8000-000000000001';
const VIDEO_SHA = 'a'.repeat(64);

const operator = () => ({ id: OPERATOR, kind: 'operator' as const, projectIds: [PROJECT] });
const base = { operationId: OP, projectId: PROJECT, sourceTakeId: TAKE, title: 'Continue: take one', prompt: 'A figure crosses the threshold.' };
const sourceShot = () => ({ id: SOURCE_SHOT, projectId: PROJECT, title: 'Take one', prompt: 'A figure enters.', revision: 1, controls: { ...defaultControls }, bindings: { firstFrameAssetId: null, lastFrameAssetId: null }, selectedTakeId: null, selectionRevision: 0 });
const videoAsset = () => ({ id: VIDEO, projectId: PROJECT, filename: 'take.mp4', kind: 'video' as const, origin: 'generated' as const, sha256: VIDEO_SHA, mediaUrl: `/api/media/${VIDEO}`, width: 64, height: 48, durationSeconds: 5 });
const derivedFrame = (id = FRAME) => ({ id, projectId: PROJECT, filename: 'last-frame.png', kind: 'image' as const, origin: 'imported' as const, sha256: 'b'.repeat(64), mediaUrl: `/api/media/${id}`, width: 64, height: 48, provenance: { kind: 'extracted-frame', frame: 'last', sourceAssetId: VIDEO, sourceSha256: VIDEO_SHA } });

class World {
  shots: any[] = [sourceShot()];
  assets: any[] = [videoAsset()];
  takes: any[] = [{ id: TAKE, projectId: PROJECT, shotId: SOURCE_SHOT, attemptId: 'a0000000-0000-4000-8000-000000000001', assetId: VIDEO, createdAt: '2026-01-01T00:00:00.000Z' }];
  extractCalls: Array<{ projectId: string; assetId: string; frame: string }> = [];
  commands: any[] = [];
  extractError: Error | null = null;
  extractGate: Promise<void> | null = null;
  commandError: ((cmd: any) => Error | null) | null = null;
  clock = Date.parse('2026-01-01T00:00:00.000Z');
  journal = createMemoryContinueShotJournal({ now: () => this.clock });
  ports: ContinueShotPorts;
  constructor() {
    this.ports = {
      journal: this.journal,
      now: () => '2026-01-01T00:00:00.000Z',
      getWorkspace: (async (_actor: unknown, _projectId: string) => ({
        project: { id: PROJECT, name: 'Film', brief: '', revision: 1 },
        shots: structuredClone(this.shots), assets: structuredClone(this.assets), takes: structuredClone(this.takes),
        attempts: [], reviews: [], exports: [], capabilities: [],
      })) as any,
      extractReferenceFrame: (async (_actor: unknown, input: any) => {
        this.extractCalls.push({ ...input });
        if (this.extractGate) await this.extractGate;
        if (this.extractError) throw this.extractError;
        const derived = derivedFrame();
        this.assets.push(derived);
        return structuredClone(derived);
      }) as any,
      command: (async (_actor: unknown, cmd: any) => {
        const parsed = commandSchema.parse(cmd);
        this.commands.push(structuredClone(parsed));
        const failure = this.commandError?.(parsed);
        if (failure) throw failure;
        if (parsed.type === 'shot.create') {
          const created = { id: NEW_SHOT, projectId: parsed.projectId, title: parsed.title, prompt: parsed.prompt, revision: 1, controls: { ...defaultControls }, bindings: { firstFrameAssetId: null, lastFrameAssetId: null }, selectedTakeId: null, selectionRevision: 0 };
          this.shots.push(created);
          return { commandId: parsed.commandId, projectId: parsed.projectId, resourceId: created.id, revision: 1 };
        }
        if (parsed.type === 'shot.update') {
          const shot = this.shots.find(item => item.id === parsed.shotId);
          if (!shot) throw new ServiceError('SHOT_NOT_FOUND', 'Shot not found.', 404);
          const replay = this.commands.filter(entry => entry.commandId === parsed.commandId).length > 1;
          if (replay && shot.bindings.firstFrameAssetId === (parsed.patch?.bindings ?? {}).firstFrameAssetId) {
            return { commandId: parsed.commandId, projectId: parsed.projectId, resourceId: shot.id, revision: shot.revision };
          }
          if (shot.revision !== parsed.expectedRevision) throw new ServiceError('REVISION_CONFLICT', 'This shot changed.', 409, shot.revision);
          shot.bindings = { ...shot.bindings, ...(parsed.patch.bindings ?? {}) };
          shot.revision += 1;
          return { commandId: parsed.commandId, projectId: parsed.projectId, resourceId: shot.id, revision: shot.revision };
        }
        throw new Error(`continue-shot must not emit ${parsed.type}`);
      }) as any,
    };
  }
  /** Model a process that died without releasing its lease. */
  crash(ms = 5_000) { this.clock += ms; }
}

const intent = (patch: Partial<ContinueShotRecord> = {}) => continueShotIntentHash({
  projectId: PROJECT, sourceTakeId: TAKE, sourceAssetId: VIDEO, sourceAssetSha256: VIDEO_SHA,
  title: base.title, prompt: base.prompt, actorId: OPERATOR, actorKind: 'operator', ...patch,
});

const record = (patch: Partial<ContinueShotRecord> = {}): ContinueShotRecord => ({
  operationId: OP, projectId: PROJECT, actorId: OPERATOR, actorKind: 'operator', intentHash: intent(),
  sourceTakeId: TAKE, sourceShotId: SOURCE_SHOT,
  sourceAssetId: VIDEO, sourceAssetSha256: VIDEO_SHA, title: base.title, prompt: base.prompt,
  status: 'pending' as ContinueShotJournalStatus, extractionDispatched: false, extractedAssetId: null,
  shotId: null, shotRevision: null, createPayload: null, createPayloadHash: null,
  bindPayload: null, bindPayloadHash: null,
  blockers: [], message: null, resumable: true, updatedAt: '2026-01-01T00:00:00.000Z', ...patch,
});

/** Seed a journal row as if a previous process had written it and then died. */
async function seed(world: World, patch: Partial<ContinueShotRecord>) {
  const begun = await world.journal.begin(record(patch), { ownerToken: randomUUID(), ttlMs: 250 });
  assert.ok(begun.lease, 'seed must own the lease before it "crashes"');
  world.crash();
}

test('continue-shot extracts the last frame of the explicit take, creates one shot and binds only the first frame', async () => {
  const world = new World();
  const outcome = await createContinueShot(world.ports).continueShot(operator(), base);

  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.resumed, false);
  assert.deepEqual(world.extractCalls, [{ projectId: PROJECT, assetId: VIDEO, frame: 'last' }]);
  assert.deepEqual(world.commands.map(cmd => cmd.type), ['shot.create', 'shot.update']);

  const create = world.commands[0], bind = world.commands[1];
  assert.equal(create.commandId, deriveContinueShotCommandId(OP, 'create'));
  assert.equal(bind.commandId, deriveContinueShotCommandId(OP, 'bind'));
  assert.notEqual(create.commandId, bind.commandId);
  assert.equal(uuid.safeParse(create.commandId).success, true);
  assert.equal(create.title, base.title);
  assert.equal(create.prompt, base.prompt);
  assert.deepEqual(bind.patch.bindings, { firstFrameAssetId: FRAME });
  assert.equal('lastFrameAssetId' in bind.patch.bindings, false);
  assert.equal(bind.expectedRevision, 1);
  assert.equal(bind.shotId, NEW_SHOT);
  assert.equal(world.commands.some(cmd => cmd.type.startsWith('generation.') || cmd.type === 'take.select'), false);

  const created = world.shots.find(item => item.id === NEW_SHOT);
  assert.deepEqual(created.bindings, { firstFrameAssetId: FRAME, lastFrameAssetId: null });
  assert.equal(outcome.firstFrameAssetId, FRAME);
  assert.equal(outcome.lastFrameAssetId, null);
  assert.equal(outcome.nextStep, 'done');
  assert.deepEqual(outcome.lineage, {
    sourceTakeId: TAKE, sourceShotId: SOURCE_SHOT, sourceAssetId: VIDEO,
    sourceAssetSha256: VIDEO_SHA, extractedAssetId: FRAME,
  });
  assert.equal(outcome.commandIds.shotCreate, create.commandId);
  assert.equal(outcome.commandIds.shotBind, bind.commandId);

  const stored = await world.journal.load(OP);
  assert.equal(stored?.status, 'completed');
  assert.equal(stored?.createPayloadHash?.length, 64, 'the exact create payload is frozen in the journal');
  assert.deepEqual(stored?.createPayload, world.commands[0]);
  assert.deepEqual(stored?.bindPayload, world.commands[1]);
});

test('continue-shot requires an explicit project-owned take from the operator and never selects or generates on its own', async () => {
  const world = new World();
  const service = createContinueShot(world.ports);
  world.takes.push({ id: OTHER_TAKE, projectId: PROJECT, shotId: SOURCE_SHOT, attemptId: 'a0000000-0000-4000-8000-000000000002', assetId: VIDEO, createdAt: '2026-01-01T00:00:00.000Z' });

  await assert.rejects(service.continueShot(operator(), { ...base, sourceTakeId: '' }), { code: 'TAKE_REQUIRED' });
  await assert.rejects(service.continueShot(operator(), { ...base, sourceTakeId: '50000000-0000-4000-8000-0000000000ff' }), { code: 'TAKE_NOT_FOUND' });
  await assert.rejects(service.continueShot(operator(), { ...base, projectId: OTHER_PROJECT }), { code: 'FORBIDDEN' });
  await assert.rejects(service.continueShot({ ...operator(), kind: 'agent' } as any, base), { code: 'OPERATOR_REQUIRED' });
  await assert.rejects(service.continueShot(operator(), { ...base, prompt: '   ' }), { code: 'PROMPT_REQUIRED' });

  world.takes.push({ id: '50000000-0000-4000-8000-000000000003', projectId: PROJECT, shotId: SOURCE_SHOT, attemptId: 'a0000000-0000-4000-8000-000000000003', assetId: '60000000-0000-4000-8000-000000000009', createdAt: '2026-01-01T00:00:00.000Z' });
  world.assets.push({ id: '60000000-0000-4000-8000-000000000009', projectId: PROJECT, filename: 'still.png', kind: 'image', origin: 'imported', sha256: 'c'.repeat(64), mediaUrl: '/api/media/x', width: 8, height: 8 });
  await assert.rejects(service.continueShot(operator(), { ...base, sourceTakeId: '50000000-0000-4000-8000-000000000003' }), { code: 'TAKE_NOT_VIDEO' });

  assert.equal(world.extractCalls.length, 0);
  assert.equal(world.commands.length, 0);
});

test('a failed first attempt resumes the same journal entry without a second extraction or a duplicate shot', async () => {
  const world = new World();
  const service = createContinueShot(world.ports);
  world.commandError = cmd => (cmd.type === 'shot.create' ? new Error('socket hang up') : null);

  const first = await service.continueShot(operator(), base);
  assert.equal(first.status, 'partial');
  assert.equal(first.resumable, true);
  assert.equal(first.code, 'CREATE_FAILED');
  assert.equal(first.extractedAssetId, FRAME);
  assert.equal(first.shotId, null);
  assert.equal(first.nextStep, 'create');
  assert.doesNotMatch(first.message ?? '', /rolled back|rollback/i);
  assert.equal(world.extractCalls.length, 1);
  assert.equal((await world.journal.load(OP))?.extractedAssetId, FRAME);

  world.commandError = null;
  const second = await service.continueShot(operator(), base);
  assert.equal(second.status, 'completed');
  assert.equal(second.resumed, true);
  assert.equal(world.extractCalls.length, 1, 'the recorded last frame is reused, not re-extracted');
  const creates = world.commands.filter(cmd => cmd.type === 'shot.create');
  assert.equal(creates.length, 2);
  assert.equal(creates[0].commandId, creates[1].commandId, 'retry reuses the deterministic command id so the server can replay the receipt');
  assert.deepEqual(creates[0], creates[1], 'the frozen payload is replayed byte-for-byte');
  assert.equal(world.shots.filter(item => item.id === NEW_SHOT).length, 1);
});

test('an extraction that was dispatched but left no visible frame is UNKNOWN, never re-extracted', async () => {
  const world = new World();
  await seed(world, { status: 'extracting', extractionDispatched: true });

  const outcome = await createContinueShot(world.ports).continueShot(operator(), base);
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.code, 'EXTRACTION_UNKNOWN');
  assert.equal(outcome.resumable, false, 'a possibly-committed extraction is not a safe retry');
  assert.equal(outcome.nextStep, 'reconcile');
  assert.equal(world.extractCalls.length, 0, 'nothing is extracted again while the outcome is unknown');
  assert.equal(world.commands.length, 0);
  assert.equal((await world.journal.load(OP))?.status, 'extraction_unknown');
});

test('an interrupted extraction is adopted from derived provenance when exactly one candidate exists', async () => {
  const world = new World();
  world.assets.push(derivedFrame());
  await seed(world, { status: 'extracting', extractionDispatched: true });

  const adopted = await createContinueShot(world.ports).continueShot(operator(), base);
  assert.equal(adopted.status, 'completed');
  assert.equal(adopted.extractedAssetId, FRAME);
  assert.equal(world.extractCalls.length, 0, 'the persisted derived frame is adopted, not regenerated');
  assert.equal(world.commands.filter(cmd => cmd.type === 'shot.create').length, 1);

  const ambiguous = new World();
  ambiguous.assets.push(derivedFrame(), derivedFrame(SECOND_FRAME));
  await seed(ambiguous, { status: 'extracting', extractionDispatched: true });
  const blocked = await createContinueShot(ambiguous.ports).continueShot(operator(), base);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.code, 'EXTRACTION_AMBIGUOUS');
  assert.equal(blocked.resumable, false);
  assert.equal(ambiguous.extractCalls.length, 0);
});

test('only a refusal the media port proves happened before dispatch permits a retry', async () => {
  const world = new World();
  const service = createContinueShot(world.ports);
  world.extractError = new ServiceError('MEDIA_UNAVAILABLE', 'Reference frame extraction is not configured.', 503);

  const refused = await service.continueShot(operator(), base);
  assert.equal(refused.status, 'blocked');
  assert.equal(refused.code, 'EXTRACTION_FAILED');
  assert.equal(refused.resumable, true);
  assert.equal(refused.extractedAssetId, null);
  const stored = await world.journal.load(OP);
  assert.equal(stored?.extractionDispatched, false, 'a provable pre-dispatch refusal clears the dispatched marker');
  assert.equal(world.extractCalls.length, 1);

  // A retry is then safe and completes normally.
  world.extractError = null;
  const retried = await service.continueShot(operator(), base);
  assert.equal(retried.status, 'completed');
  assert.equal(world.extractCalls.length, 2);
});

test('an unclassified extraction failure is recorded as unknown and is not retried automatically', async () => {
  const world = new World();
  const service = createContinueShot(world.ports);
  world.extractError = new Error('socket hang up');

  const outcome = await service.continueShot(operator(), base);
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.code, 'EXTRACTION_UNKNOWN');
  assert.equal(outcome.resumable, false);
  assert.equal(world.extractCalls.length, 1);

  const replay = await service.continueShot(operator(), base);
  assert.equal(replay.code, 'EXTRACTION_UNKNOWN');
  assert.equal(world.extractCalls.length, 1, 'the unknown extraction is never re-run');
  assert.equal(world.commands.length, 0);
});

test('a bind conflict reports actual progress and completes only when readback already shows the first frame bound', async () => {
  const world = new World();
  world.commandError = cmd => (cmd.type === 'shot.update' ? new ServiceError('REVISION_CONFLICT', 'This shot changed.', 409, 2) : null);
  const blocked = await createContinueShot(world.ports).continueShot(operator(), base);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.code, 'BIND_CONFLICT');
  assert.equal(blocked.resumable, false);
  assert.equal(blocked.shotId, NEW_SHOT);
  assert.equal(blocked.extractedAssetId, FRAME);
  assert.equal(blocked.firstFrameAssetId, null, 'reports the real readback state, not an assumed rollback');
  assert.equal(world.commands.filter(cmd => cmd.type === 'shot.update').length, 1);

  const reconciled = new World();
  reconciled.shots.push({ ...sourceShot(), id: NEW_SHOT, title: base.title, prompt: base.prompt, revision: 4, bindings: { firstFrameAssetId: FRAME, lastFrameAssetId: null } });
  await seed(reconciled, { status: 'binding', extractionDispatched: true, extractedAssetId: FRAME, shotId: NEW_SHOT, shotRevision: 1 });
  reconciled.commandError = cmd => (cmd.type === 'shot.update' ? new ServiceError('REVISION_CONFLICT', 'This shot changed.', 409, 4) : null);
  const outcome = await createContinueShot(reconciled.ports).continueShot(operator(), base);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.resumed, true);
  assert.equal(outcome.firstFrameAssetId, FRAME);
  assert.equal(outcome.lastFrameAssetId, null);
  assert.equal(reconciled.commands.filter(cmd => cmd.type === 'shot.create').length, 0, 'no second shot is created');
  assert.equal(reconciled.extractCalls.length, 0);
});

test('a completed operation is idempotent for the same operation id and refuses changed intent or another actor', async () => {
  const world = new World();
  world.takes.push({ id: OTHER_TAKE, projectId: PROJECT, shotId: SOURCE_SHOT, attemptId: 'a0000000-0000-4000-8000-000000000002', assetId: VIDEO, createdAt: '2026-01-01T00:00:00.000Z' });
  const service = createContinueShot(world.ports);
  assert.equal((await service.continueShot(operator(), base)).status, 'completed');

  const replay = await service.continueShot(operator(), base);
  assert.equal(replay.status, 'completed');
  assert.equal(replay.resumed, true);
  assert.equal(world.extractCalls.length, 1);
  assert.equal(world.commands.length, 2);

  await assert.rejects(service.continueShot(operator(), { ...base, prompt: 'A different intention.' }), { code: 'CONTINUE_INTENT_CONFLICT' });
  await assert.rejects(service.continueShot(operator(), { ...base, sourceTakeId: OTHER_TAKE }), { code: 'CONTINUE_INTENT_CONFLICT' });
  await assert.rejects(service.continueShot(operator(), { ...base, title: 'Another title' }), { code: 'CONTINUE_INTENT_CONFLICT' });
  // Command receipts are keyed by (actor_id, command_id): a different actor must not replay them.
  await assert.rejects(
    service.continueShot({ id: OTHER_OPERATOR, kind: 'operator', projectIds: [PROJECT] }, base),
    { code: 'CONTINUE_ACTOR_MISMATCH' },
  );
  assert.equal(world.commands.length, 2);
});
