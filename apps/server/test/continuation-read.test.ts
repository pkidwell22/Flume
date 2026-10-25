import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ServiceError, defaultControls, uuid } from '../src/contracts.ts';
import {
  continueShotIntentHash,
  createContinueShot,
  createMemoryContinueShotJournal,
  type ContinueShotPorts,
  type ContinueShotRecord,
} from '../src/continue-shot.ts';

// Fixture ids and actors. The journal is the labelled in-memory fixture: read/resume behaviour
// below is proven against the same fence/expiry semantics as the durable adapter, not a database.
const PROJECT = '10000000-0000-4000-8000-000000000001';
const OTHER_PROJECT = '10000000-0000-4000-8000-000000000002';
const OPERATOR = '30000000-0000-4000-8000-000000000001';
const OTHER_OPERATOR = '30000000-0000-4000-8000-000000000002';
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
const derivedFrame = (id = FRAME) => ({ id, projectId: PROJECT, filename: 'last-frame.png', kind: 'image' as const, origin: 'imported' as const, sha256: 'b'.repeat(64), mediaUrl: `/api/media/${id}`, width: 64, height: 48, provenance: { kind: 'extracted-frame', frame: 'last', sourceAssetId: VIDEO, sourceSha256: VIDEO_SHA } });

class World {
  shots: any[] = [sourceShot()];
  assets: any[] = [videoAsset()];
  takes: any[] = [{ id: TAKE, projectId: PROJECT, shotId: SOURCE_SHOT, attemptId: 'a0000000-0000-4000-8000-000000000001', assetId: VIDEO, createdAt: '2026-01-01T00:00:00.000Z' }];
  extractCalls: Array<{ projectId: string; assetId: string; frame: string }> = [];
  commands: any[] = [];
  commandError: ((cmd: any) => Error | null) | null = null;
  clock = Date.parse('2026-01-01T00:00:00.000Z');
  journal = createMemoryContinueShotJournal({ now: () => this.clock });
  service: ReturnType<typeof createContinueShot>;
  ports: ContinueShotPorts;
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
        this.extractCalls.push({ ...input });
        const derived = derivedFrame();
        this.assets.push(derived);
        return structuredClone(derived);
      }) as any,
      command: (async (_actor: unknown, cmd: any) => {
        this.commands.push(structuredClone(cmd));
        const failure = this.commandError?.(cmd);
        if (failure) throw failure;
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
  /** A partially applied continuation: extraction succeeded, the shot create failed. */
  async partial(): Promise<void> {
    this.commandError = cmd => cmd.type === 'shot.create' ? new ServiceError('COMMAND_CONFLICT', 'The create was refused.', 409) : null;
    await this.service.continueShot(operator(), base);
    this.commandError = null;
  }
}

const record = (patch: Partial<ContinueShotRecord> = {}): ContinueShotRecord => ({
  operationId: OP, projectId: PROJECT, actorId: OPERATOR, actorKind: 'operator',
  intentHash: continueShotIntentHash({ projectId: PROJECT, sourceTakeId: TAKE, sourceAssetId: VIDEO, sourceAssetSha256: VIDEO_SHA, title: TITLE, prompt: PROMPT, actorId: OPERATOR, actorKind: 'operator' }),
  sourceTakeId: TAKE, sourceShotId: SOURCE_SHOT, sourceAssetId: VIDEO, sourceAssetSha256: VIDEO_SHA,
  title: TITLE, prompt: PROMPT, status: 'pending', extractionDispatched: false, extractedAssetId: null,
  shotId: null, shotRevision: null, createPayload: null, createPayloadHash: null, bindPayload: null, bindPayloadHash: null,
  blockers: [], message: null, resumable: true, updatedAt: '2026-01-01T00:00:00.000Z', ...patch,
});

test('reading a continuation returns a minimal project-scoped snapshot and performs no write', async () => {
  const world = new World();
  await world.partial();
  const before = await world.journal.load(OP);
  const extractsBefore = world.extractCalls.length, commandsBefore = world.commands.length;

  const view = await world.service.readContinueShot(operator(), { projectId: PROJECT, operationId: OP });
  assert.equal(view.operationId, OP);
  assert.equal(view.projectId, PROJECT);
  assert.equal(view.status, 'partial');
  assert.equal(view.resumable, true);
  assert.equal(view.active, false);
  assert.equal(view.sourceTakeId, TAKE);
  assert.equal(view.sourceShotId, SOURCE_SHOT);
  assert.equal(view.sourceAssetId, VIDEO);
  assert.equal(view.extractedAssetId, FRAME);
  assert.equal(view.shotId, null);
  assert.equal(view.nextStep, 'create');
  assert.deepEqual(view.blockers, ['CREATE_FAILED']);
  assert.equal(view.updatedAt, before?.updatedAt);

  // A read must never extract media, create or bind shots, or advance the journal.
  assert.equal(world.extractCalls.length, extractsBefore);
  assert.equal(world.commands.length, commandsBefore);
  assert.equal((await world.journal.load(OP))?.status, before?.status);

  // No prompt, title, intent hash, lease material or command payload crosses the read surface.
  const wire = JSON.stringify(view);
  for (const secret of [PROMPT, TITLE, before!.intentHash, 'PRIVATE-PROMPT', 'ownerToken', 'createPayload']) {
    assert.equal(wire.includes(secret), false, `read view must not expose ${secret}`);
  }
});

test('reading a missing, cross-project or cross-actor operation does not leak another project', async () => {
  const world = new World();
  await world.partial();
  const missing = '90000000-0000-4000-8000-0000000000ff';
  await assert.rejects(world.service.readContinueShot(operator(), { projectId: PROJECT, operationId: missing }), (error: unknown) => error instanceof ServiceError && error.status === 404);
  await assert.rejects(world.service.readContinueShot(operator(), { projectId: OTHER_PROJECT, operationId: OP }), (error: unknown) => error instanceof ServiceError && error.status === 403);

  const crossProject = { id: OPERATOR, kind: 'operator' as const, projectIds: [PROJECT, OTHER_PROJECT] };
  await assert.rejects(world.service.readContinueShot(crossProject, { projectId: OTHER_PROJECT, operationId: OP }), (error: unknown) => {
    if (!(error instanceof ServiceError) || error.status !== 404) return false;
    const text = `${error.code} ${error.message} ${JSON.stringify(error.details ?? null)}`;
    return !text.includes('PRIVATE-PROMPT') && !text.includes(FRAME);
  });

  const otherActor = { id: OTHER_OPERATOR, kind: 'operator' as const, projectIds: [PROJECT] };
  await assert.rejects(world.service.readContinueShot(otherActor, { projectId: PROJECT, operationId: OP }), (error: unknown) => error instanceof ServiceError && error.status === 404);

  // A malformed identifier is refused before any journal lookup.
  await assert.rejects(world.service.readContinueShot(operator(), { projectId: PROJECT, operationId: 'not-a-uuid' }), (error: unknown) => error instanceof ServiceError && error.code === 'INVALID_REQUEST' && error.status === 400);
  assert.equal(uuid.safeParse(OP).success, true);
});

test('resume replays the frozen intention from the journal, never from client-supplied content', async () => {
  const world = new World();
  await world.partial();
  const extractsBefore = world.extractCalls.length;
  const createdBefore = world.commands.filter(cmd => cmd.type === 'shot.create').length;

  const outcome = await world.service.resumeContinueShot(operator(), { projectId: PROJECT, operationId: OP });
  assert.equal(outcome.operationId, OP);
  assert.equal(outcome.projectId, PROJECT);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.resumed, true);
  assert.equal(outcome.shotId, NEW_SHOT);
  assert.equal(outcome.firstFrameAssetId, FRAME);
  assert.equal(world.extractCalls.length, extractsBefore, 'resume must not extract again');
  const creates = world.commands.filter(cmd => cmd.type === 'shot.create');
  assert.equal(creates.length, createdBefore + 1);
  assert.equal(creates.at(-1)?.prompt, PROMPT, 'the frozen prompt is replayed');
  assert.equal(creates.at(-1)?.title, TITLE, 'the frozen title is replayed');

  const view = await world.service.readContinueShot(operator(), { projectId: PROJECT, operationId: OP });
  assert.equal(view.status, 'completed');
  assert.equal(view.resumable, false);
  assert.equal(view.nextStep, 'done');
});

test('resume refuses non-resumable, unknown and live operations without touching any port', async () => {
  const world = new World();
  await world.partial();
  const extractsBefore = world.extractCalls.length, commandsBefore = world.commands.length;

  // Live owner: the operation is in progress, so no second worker may resume it.
  await world.journal.begin(record({ status: 'creating', extractedAssetId: FRAME }), { ownerToken: randomUUID(), ttlMs: 60_000 });
  const live = await world.service.readContinueShot(operator(), { projectId: PROJECT, operationId: OP });
  assert.equal(live.active, true);
  assert.equal(live.resumable, false, 'a live operation is not resume-able from another request');
  await assert.rejects(world.service.resumeContinueShot(operator(), { projectId: PROJECT, operationId: OP }), (error: unknown) => error instanceof ServiceError && error.code === 'CONTINUE_IN_PROGRESS' && error.status === 409);

  // Unknown extraction outcome is terminal for that operation, even with an expired lease.
  const UNKNOWN_OP = '90000000-0000-4000-8000-000000000002';
  await world.journal.begin(record({ operationId: UNKNOWN_OP, status: 'extraction_unknown', extractionDispatched: true, resumable: false }), { ownerToken: randomUUID(), ttlMs: 250 });
  world.clock += 5_000;
  const unknown = await world.service.readContinueShot(operator(), { projectId: PROJECT, operationId: UNKNOWN_OP });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.resumable, false);
  await assert.rejects(world.service.resumeContinueShot(operator(), { projectId: PROJECT, operationId: UNKNOWN_OP }), (error: unknown) => error instanceof ServiceError && error.code === 'CONTINUE_NOT_RESUMABLE' && error.status === 409);
  assert.equal(world.extractCalls.length, extractsBefore);
  assert.equal(world.commands.length, commandsBefore);
});
