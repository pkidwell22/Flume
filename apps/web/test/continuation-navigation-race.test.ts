// Regression tests for the continuation recovery navigation race (QA verdict
// continuation-recovery-01, defect D2).
//
// The gate is on the continuation GET itself (`readContinuation`), not on `getWorkspace`: only then
// does `openProject()` run while `busy === 'continuation.restore'`, which is the branch the existing
// "late read" test never reaches. No browser, no server, no database: the controller is driven
// directly through its public API with in-memory ports.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceController } from '../src/controller.ts';
import { createAuthoringApi } from '../src/authoring-api.ts';
import type { ContinueShotPublicView } from '../src/ContinueShot.tsx';
import type { FlumePort, Workspace } from '../src/types.ts';

const A = '10000000-0000-4000-8000-0000000000a1';
const B = '10000000-0000-4000-8000-0000000000b2';
const OP_A = '90000000-0000-4000-8000-0000000000a1';
const OP_B = '90000000-0000-4000-8000-0000000000b2';
const TAKE = '50000000-0000-4000-8000-000000000001';
const SHOT = '40000000-0000-4000-8000-000000000001';
const ASSET = '60000000-0000-4000-8000-000000000001';
const NEW_SHOT = '80000000-0000-4000-8000-000000000001';

function workspace(id: string): Workspace {
  return { project: { id, name: `Project ${id.slice(-2)}`, brief: '', revision: 1 }, shots: [], assets: [], takes: [], attempts: [], reviews: [], exports: [], capabilities: [] };
}

const view = (projectId: string, operationId: string): ContinueShotPublicView => ({
  operationId, projectId, status: 'partial', resumable: true, active: false,
  sourceTakeId: TAKE, sourceShotId: SHOT, sourceAssetId: ASSET,
  extractedAssetId: ASSET, shotId: null, shotRevision: null, nextStep: 'create',
  blockers: ['CREATE_FAILED'], message: 'The next shot was not created.', updatedAt: '2026-01-01T00:00:00.000Z',
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 500; i++) { if (check()) return; await tick(1); }
  throw new Error(`timed out waiting for ${label}`);
}

type Call = { method: string; url: string };
type Gate = { promise: Promise<void>; release: () => void };
function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/**
 * A controller whose continuation reads for the gated operation ids hang until `release(id)` is
 * called. `getWorkspace` never blocks, so any busy label observed here belongs to a restore.
 */
function setup(options: { bookmarks: Array<[string, string]>; gated: string[]; proposalId?: string }) {
  const bookmarks = new Map(options.bookmarks);
  const calls: Call[] = [];
  const gates = new Map<string, Gate>(options.gated.map(id => [id, gate()]));
  const commands: Array<Record<string, unknown>> = [];
  const shots = new Map<string, any[]>();
  const port: FlumePort = {
    listProjects: async () => [workspace(A).project!, workspace(B).project!],
    getWorkspace: async (id?: string) => ({ ...workspace(id ?? A), shots: [...(shots.get(id ?? A) ?? [])] }),
    command: async (command: any) => {
      commands.push(command);
      const created = { id: NEW_SHOT, projectId: command.projectId, title: command.title, prompt: command.prompt, revision: 1, controls: {}, bindings: { firstFrameAssetId: null, lastFrameAssetId: null }, selectedTakeId: null, selectionRevision: 0 };
      shots.set(command.projectId, [...(shots.get(command.projectId) ?? []), created]);
      return { commandId: command.commandId, projectId: command.projectId, resourceId: NEW_SHOT, revision: 1 };
    },
    uploadAsset: async () => { throw new Error('regression: no upload may happen'); },
  };
  const authoring = createAuthoringApi(async (input, init) => {
    const url = String(input);
    calls.push({ method: init?.method ?? 'GET', url });
    if (options.proposalId) { await gates.get('proposal')!.promise; return json({}, 500); }
    const match = /continue-shot\/([0-9a-f-]{36})/.exec(url);
    if (!match) throw new Error(`regression: unexpected authoring call ${url}`);
    const operationId = match[1]!;
    await gates.get(operationId)?.promise;
    return json(view(operationId === OP_A ? A : B, operationId));
  });
  const store = {
    read: (id: string) => bookmarks.get(id) ?? null,
    write: (id: string, value: string | null) => { if (value) bookmarks.set(id, value); else bookmarks.delete(id); },
  };
  return { bookmarks, calls, commands, gates, store, port, authoring, release: (id: string) => gates.get(id)!.release() };
}

test('opening another project during the saved-continuation read releases the superseded label', async () => {
  const s = setup({ bookmarks: [[A, OP_A], [B, OP_B]], gated: [OP_A, OP_B] });
  const controller = new WorkspaceController(s.port, s.authoring, null, s.store);

  const openingA = controller.openProject(A);
  await waitFor(() => controller.getSnapshot().busy === 'continuation.restore', 'busy=continuation.restore for A');
  assert.equal(controller.getSnapshot().workspace?.project?.id, A);

  // Direct controller call (no shell guard): switch to B while A's read is still in flight.
  const switching = controller.openProject(B);
  for (let i = 0; i < 300 && !s.calls.some(call => call.url.includes(OP_B)); i++) await tick(1);
  assert.ok(
    s.calls.some(call => call.url.includes(OP_B)),
    "B's own saved continuation is read after the switch: the superseded label must not block it",
  );

  const duringSwitch = controller.getSnapshot();
  assert.equal(duringSwitch.workspace?.project?.id, B, 'B is the visible project');
  assert.equal(duringSwitch.authoring.continuation?.operationId, OP_B, "B's recovery replaced A's");
  assert.equal(duringSwitch.phase, 'ready');

  // The stale A response lands while B's restore is still pending: it must not clear B's busy label.
  s.release(OP_A);
  await openingA;
  await tick(10);
  assert.equal(controller.getSnapshot().busy, 'continuation.restore', "a late A response must not clear B's busy label");
  assert.equal(controller.getSnapshot().authoring.continuation?.operationId, OP_B, "a late A response must not overwrite B's recovery");

  // B's restore completes and the controller is usable again.
  s.release(OP_B);
  await switching;
  await tick(10);
  const settled = controller.getSnapshot();
  assert.equal(settled.busy, null, 'the busy label is released');
  assert.equal(settled.phase, 'ready');
  assert.equal(settled.workspace?.project?.id, B);
  assert.equal(settled.authoring.continuation?.phase, 'restored');
  assert.equal(settled.authoring.continuation?.view?.projectId, B);

  await controller.createShot('Next', 'A prompt for the next shot.');
  assert.ok(s.commands.length >= 1, 'commands are accepted again after the switch');
  assert.equal(s.commands.at(-1)?.type, 'shot.create');
  assert.equal(controller.getSnapshot().activeShotId, NEW_SHOT);
  assert.equal(s.calls.filter(call => call.method === 'POST').length, 0, 'no mutation is sent from a recovery read');
});

test('a project with no saved continuation is usable while another project read is still in flight', async () => {
  const s = setup({ bookmarks: [[A, OP_A]], gated: [OP_A] });
  const controller = new WorkspaceController(s.port, s.authoring, null, s.store);

  const openingA = controller.openProject(A);
  await waitFor(() => controller.getSnapshot().busy === 'continuation.restore', 'busy=continuation.restore for A');

  await controller.openProject(B);
  const switched = controller.getSnapshot();
  assert.equal(switched.busy, null, 'openProject releases a label owned by the superseded navigation');
  assert.equal(switched.workspace?.project?.id, B);
  assert.equal(switched.authoring.continuation, null, 'B has no saved continuation to show');
  assert.equal(switched.phase, 'ready');

  // The controller is not blocked while the stale read is still out.
  await controller.createShot('Next', 'A prompt for the next shot.');
  assert.equal(controller.getSnapshot().activeShotId, NEW_SHOT);

  // A's late response changes nothing visible and leaves no label behind.
  s.release(OP_A);
  await openingA;
  await tick(20);
  assert.equal(controller.getSnapshot().busy, null);
  assert.equal(controller.getSnapshot().workspace?.project?.id, B);
  assert.equal(controller.getSnapshot().authoring.continuation, null);
  assert.equal(s.bookmarks.get(A), OP_A, "A's own bookmark is preserved");
});

test('the storyboard restore path still releases its superseded label', async () => {
  // Control: the same navigation during a storyboard.restore must keep its existing cleanup.
  const s = setup({ bookmarks: [], gated: ['proposal'], proposalId: 'prop-a' });
  const proposalBookmarks = { read: (id: string) => (id === A ? 'prop-a' : null), write: () => {} };
  const controller = new WorkspaceController(s.port, s.authoring, proposalBookmarks, s.store);

  const openingA = controller.openProject(A);
  await waitFor(() => controller.getSnapshot().busy === 'storyboard.restore', 'busy=storyboard.restore');
  await controller.openProject(B);
  assert.equal(controller.getSnapshot().busy, null, 'the superseded storyboard label is released');
  assert.equal(controller.getSnapshot().workspace?.project?.id, B);

  s.release('proposal');
  await openingA;
  await tick(20);
  assert.equal(controller.getSnapshot().busy, null, 'the late storyboard response leaves no label behind');
  assert.equal(controller.getSnapshot().workspace?.project?.id, B);
});
