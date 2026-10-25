import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceController } from '../src/controller.ts';
import { createAuthoringApi, continuationFromWire, AuthoringApiError } from '../src/authoring-api.ts';
import type { ContinueShotOutcome, ContinueShotPublicView } from '../src/ContinueShot.tsx';
import type { FlumePort, Workspace } from '../src/types.ts';

const projectId = '6a1f5c1e-0000-4000-8000-000000000001';
const otherProject = '6a1f5c1e-0000-4000-8000-000000000002';
const operationId = '9a1f5c1e-0000-4000-8000-000000000001';
const takeId = '5a1f5c1e-0000-4000-8000-000000000001';
const shotId = '4a1f5c1e-0000-4000-8000-000000000001';

const view = (patch: Partial<ContinueShotPublicView> = {}): ContinueShotPublicView => ({
  operationId, projectId, status: 'partial', resumable: true, active: false,
  sourceTakeId: takeId, sourceShotId: shotId,
  sourceAssetId: '6a1f5c1e-0000-4000-8000-0000000000aa', extractedAssetId: '7a1f5c1e-0000-4000-8000-000000000001',
  shotId: null, shotRevision: null, nextStep: 'create',
  blockers: ['CREATE_FAILED'], message: 'The next shot was not created.', updatedAt: '2026-10-24T00:00:00.000Z',
  ...patch,
});

const outcome = (patch: Partial<ContinueShotOutcome> = {}): ContinueShotOutcome => ({
  operationId, projectId, status: 'completed', resumed: true,
  sourceTakeId: takeId, sourceShotId: shotId,
  sourceAssetId: '6a1f5c1e-0000-4000-8000-0000000000aa', sourceAssetSha256: 'a'.repeat(64),
  extractedAssetId: '7a1f5c1e-0000-4000-8000-000000000001', shotId: '8a1f5c1e-0000-4000-8000-000000000001', shotRevision: 2,
  firstFrameAssetId: '7a1f5c1e-0000-4000-8000-000000000001', lastFrameAssetId: null,
  nextStep: 'done', commandIds: { shotCreate: '8a1f5c1e-0000-4000-8000-0000000000c1', shotBind: '8a1f5c1e-0000-4000-8000-0000000000b1' },
  lineage: { sourceTakeId: takeId, sourceShotId: shotId, sourceAssetId: '6a1f5c1e-0000-4000-8000-0000000000aa', sourceAssetSha256: 'a'.repeat(64), extractedAssetId: '7a1f5c1e-0000-4000-8000-000000000001' },
  code: null, message: null, resumable: false, ...patch,
});

function workspace(id = projectId): Workspace {
  return { project: { id, name: 'Continuation fixture', brief: '', revision: 1 }, shots: [], assets: [], takes: [], attempts: [], reviews: [], exports: [], capabilities: [] };
}

type Call = { method: string; url: string; body: unknown };

function setup(options: { snapshot?: ContinueShotPublicView; workspaceGate?: { promise: Promise<void>; release: () => void } } = {}) {
  const bookmarks = new Map<string, string>();
  const store = {
    read: (id: string) => bookmarks.get(id) ?? null,
    write: (id: string, value: string | null) => { if (value) bookmarks.set(id, value); else bookmarks.delete(id); },
  };
  const calls: Call[] = [];
  const snapshot = options.snapshot ?? view();
  const port: FlumePort = {
    listProjects: async () => [workspace().project!],
    getWorkspace: async id => {
      if (id === projectId && options.workspaceGate) await options.workspaceGate.promise;
      return workspace(id);
    },
    command: async () => { throw new Error('continuation recovery must never send a command'); },
    uploadAsset: async () => { throw new Error('continuation recovery must never upload'); },
  };
  const authoring = createAuthoringApi(async (input, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url: String(input), body });
    if (method === 'GET') return new Response(JSON.stringify(snapshot), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(outcome()), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { bookmarks, store, calls, port, authoring, workspaceGate: options.workspaceGate };
}

test('a saved continuation is restored by one authorized GET and no mutation', async () => {
  const s = setup();
  s.bookmarks.set(projectId, operationId);
  const controller = new WorkspaceController(s.port, s.authoring, null, s.store);
  await controller.openProject(projectId);

  const recovery = controller.getSnapshot().authoring.continuation;
  assert.equal(recovery?.phase, 'restored');
  assert.equal(recovery?.operationId, operationId);
  assert.equal(recovery?.view?.status, 'partial');
  assert.equal(recovery?.view?.resumable, true);
  assert.ok(s.calls.length >= 1);
  assert.ok(s.calls.every(call => call.method === 'GET'), 'reopening must issue zero POSTs');
  const reads = s.calls.filter(call => call.url.startsWith(`/api/continue-shot/${operationId}`));
  assert.equal(reads.length, 1);
  assert.equal(reads[0]?.url, `/api/continue-shot/${operationId}?projectId=${projectId}`);
  assert.equal(s.calls.filter(call => call.url.includes('/continue-shot') && call.method === 'POST').length, 0);
});

test('browser storage failures leave the project usable and do not invent a recovery', async () => {
  const s = setup();
  const store = { read: () => { throw new Error('storage denied'); }, write: () => { throw new Error('storage denied'); } };
  const controller = new WorkspaceController(s.port, s.authoring, null, store);
  await controller.openProject(projectId);
  assert.equal(controller.getSnapshot().phase, 'ready');
  assert.equal(controller.getSnapshot().authoring.continuation, null);
  assert.match(controller.getSnapshot().notice ?? '', /storage is unavailable/i);
  assert.equal(s.calls.filter(call => call.method === 'POST').length, 0);
});

test('a failed recovery read shows a truthful error, keeps identity, and retries read-only', async () => {
  const s = setup();
  s.bookmarks.set(projectId, operationId);
  let fail = true;
  const api = {
    ...s.authoring,
    readContinuation: async (id: string, project: string) => {
      if (fail) throw new AuthoringApiError('CONNECTION_LOST', 'Could not reach Flume.');
      return s.authoring.readContinuation(id, project);
    },
  };
  const controller = new WorkspaceController(s.port, api, null, s.store);
  await controller.openProject(projectId);
  const failed = controller.getSnapshot().authoring.continuation;
  assert.equal(failed?.phase, 'error');
  assert.equal(failed?.operationId, operationId, 'identity survives a failed read');
  assert.equal(controller.getSnapshot().phase, 'ready', 'the project stays usable');

  fail = false;
  await controller.restoreContinuation();
  assert.equal(controller.getSnapshot().authoring.continuation?.phase, 'restored');
  assert.equal(s.calls.every(call => call.method === 'GET'), true, 'a read retry never falls back to POST');
});

test('a late read from the previous project cannot overwrite the visible project', async () => {
  const s = setup({ workspaceGate: (() => { let release = () => {}; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; })() });
  s.bookmarks.set(projectId, operationId);
  const controller = new WorkspaceController(s.port, s.authoring, null, s.store);
  const opening = controller.openProject(projectId);
  await new Promise(resolve => setTimeout(resolve, 5));
  const switching = controller.openProject(otherProject);
  s.workspaceGate!.release();
  await Promise.all([opening.catch(() => {}), switching]);
  assert.equal(controller.getSnapshot().workspace?.project?.id, otherProject);
  assert.equal(controller.getSnapshot().authoring.continuation, null, 'the other project has no saved continuation');
  assert.equal(s.bookmarks.get(projectId), operationId, 'the old bookmark is preserved');
});

test('resume is explicit, uses only the stored operation id, and honours resumable status', async () => {
  const s = setup();
  s.bookmarks.set(projectId, operationId);
  const controller = new WorkspaceController(s.port, s.authoring, null, s.store);
  await controller.openProject(projectId);

  const result = await controller.resumeContinuation(operationId);
  assert.equal(result.status, 'completed');
  const posts = s.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.url, `/api/continue-shot/${operationId}/resume`);
  assert.deepEqual(posts[0]?.body, { projectId }, 'resume carries no prompt, title or take');
  assert.equal(controller.getSnapshot().authoring.continuation?.view?.status, 'partial', 'the post-read is authoritative');

  const blocked = setup({ snapshot: view({ status: 'blocked', resumable: false }) });
  blocked.bookmarks.set(projectId, operationId);
  const guarded = new WorkspaceController(blocked.port, blocked.authoring, null, blocked.store);
  await guarded.openProject(projectId);
  await assert.rejects(guarded.resumeContinuation(operationId), /cannot be resumed/i);
  assert.equal(blocked.calls.filter(call => call.method === 'POST').length, 0, 'a non-resumable state never posts');
});

test('the public decoder is strict about identity and status', () => {
  assert.equal(continuationFromWire(view()).operationId, operationId);
  assert.throws(() => continuationFromWire({ ...view(), status: 'running' }), (error: unknown) => error instanceof AuthoringApiError && error.code === 'MALFORMED_RESPONSE');
  assert.throws(() => continuationFromWire({ ...view(), projectId: '' }), (error: unknown) => error instanceof AuthoringApiError && error.code === 'MALFORMED_RESPONSE');
  assert.throws(() => continuationFromWire({ ...view(), resumable: 'yes' }), (error: unknown) => error instanceof AuthoringApiError && error.code === 'MALFORMED_RESPONSE');
  const unknown = continuationFromWire({ ...view(), status: 'unknown', resumable: false });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.resumable, false);
});
