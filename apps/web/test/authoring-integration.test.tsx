import '../../../packages/shot-editor/test/setup.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FlumeApp } from '../src/App.tsx';
import { WorkspaceController } from '../src/controller.ts';
import { createAuthoringApi } from '../src/authoring-api.ts';
import type { WorkspaceComponents } from '../src/ports.ts';
import type { Workspace } from '../src/types.ts';

afterEach(cleanup);

const projectId = '5a1f5c1e-0000-4000-8000-000000000001';
const shotId = '5a1f5c1e-0000-4000-8000-000000000002';
const reviewId = '5a1f5c1e-0000-4000-8000-000000000003';
const assetId = '5a1f5c1e-0000-4000-8000-000000000004';
const sha = 'a'.repeat(64);

const parts: WorkspaceComponents = {
  Brand: () => <span>Flume</span>,
  ShotEditor: () => <div>Editor contract probe</div>,
  TakeReview: () => <div>Take review contract probe</div>,
  ActivityPanel: () => <div>Activity contract probe</div>,
  GenerationReview: () => <div>Video review probe</div>,
};

function workspace(revision = 3): Workspace {
  return {
    project: { id: projectId, name: 'Ridge', brief: '', revision: 1 },
    shots: [{
      id: shotId, projectId, title: 'The opening', prompt: 'A ridge at dawn', revision,
      selectionRevision: 0, selectedTakeId: null,
      controls: { modelId: 'acme/video-1', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false },
      bindings: { firstFrameAssetId: null, lastFrameAssetId: null },
    }],
    assets: [], takes: [], attempts: [], reviews: [], exports: [], capabilities: [],
  };
}

/** In-memory stand-in for the fixed Wave 2 routes. Every value is a fixture, not live evidence. */
function serve(options: { storyboard?: { available: boolean; blocker: string | null } } = {}) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  let generated = false;
  let resultReady = false;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const path = url.pathname;
    calls.push({ method, path: `${url.pathname}${url.search}`, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/authoring/capabilities') {
      return json({
        imageModels: [{ modelId: 'acme/frame-2', name: 'Frame 2', aspectRatios: ['16:9'], frameRoles: ['first_frame', 'last_frame'], availability: 'available', blocker: null }],
        storyboard: options.storyboard ?? { available: true, blocker: null },
      });
    }
    if (path === '/api/frame-reviews' && method === 'POST') {
      return json({
        reviewId, projectId, shotId, expectedRevision: body.expectedRevision, role: body.role,
        prompt: body.prompt, modelId: body.modelId, aspectRatio: body.aspectRatio, sourceAssetId: null,
        requestHash: sha, status: 'pending', blockers: [], estimateUsd: 0.42,
      });
    }
    if (/^\/api\/frame-reviews\/[^/]+\/generate$/.test(path)) {
      generated = true;
      return json({
        review: { reviewId, projectId, shotId, expectedRevision: 3, role: 'first_frame', prompt: 'Cold dawn', modelId: 'acme/frame-2', aspectRatio: '16:9', sourceAssetId: null, requestHash: sha, status: 'submitted', blockers: [], estimateUsd: 0.42 },
        result: null,
      });
    }
    if (/^\/api\/frame-reviews\/[^/]+$/.test(path)) {
      return json({
        review: { reviewId, projectId, shotId, expectedRevision: 3, role: 'first_frame', prompt: 'Cold dawn', modelId: 'acme/frame-2', aspectRatio: '16:9', sourceAssetId: null, requestHash: sha, status: resultReady ? 'result_ready' : 'submitted', blockers: [], estimateUsd: 0.42 },
        result: resultReady ? { assetId, projectId, reviewId, mimeType: 'image/png', width: 1024, height: 576, sha256: sha } : null,
      });
    }
    if (/^\/api\/frame-reviews\/[^/]+\/import$/.test(path)) {
      return json({ assetId, projectId, reviewId, mimeType: 'image/png', width: 1024, height: 576, sha256: sha });
    }
    if (/^\/api\/frame-reviews\/[^/]+\/bind$/.test(path)) {
      return json({ shotId, assetId, role: body.role, revision: 5 });
    }
    return json({ code: 'NOT_FOUND', message: `No fixture route for ${method} ${path}` }, 404);
  }) as typeof fetch;
  return { calls, fetcher, markResultReady: () => { resultReady = true; }, generated: () => generated };
}

async function mount(options: { storyboard?: { available: boolean; blocker: string | null } } = {}) {
  const server = serve(options);
  const api = createAuthoringApi(server.fetcher);
  const controller = new WorkspaceController({
    listProjects: async () => [workspace().project!],
    getWorkspace: async () => workspace(),
    command: async () => { throw new Error('The authoring surface must not send video commands.'); },
    uploadAsset: async () => { throw new Error('Not used by these tests.'); },
  }, api);
  await controller.openProject(projectId);
  await controller.loadAuthoring();
  const view = render(<FlumeApp controller={controller} components={parts} autoStart={false} />);
  return { ...server, controller, api, view };
}

const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); };

test('the authoring panel is mounted inside the real workspace stage, beside frames and takes', async () => {
  await mount();
  assert.equal(screen.queryByRole('heading', { name: 'Author a frame' }), null);
  await click('Author');
  assert.ok(screen.getByRole('heading', { name: 'Author a frame' }));
  assert.ok(screen.getByRole('button', { name: 'Frames' }));
  assert.ok(screen.getByRole('button', { name: 'Takes 0' }));
});

test('image authoring reaches the fixed routes and never sends a video command', async () => {
  const { calls, generated, markResultReady, controller } = await mount();
  await click('Author');
  await act(async () => { fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Cold dawn over the ridge' } }); });
  await click('Prepare review');

  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.path), ['/api/frame-reviews']);
  assert.equal(calls.filter(call => call.path === '/api/commands').length, 0);
  assert.equal(calls.filter(call => /take|attempt/i.test(call.path)).length, 0);
  assert.equal(generated(), false);

  await click('Approve and generate once');
  const generate = calls.find(call => /\/generate$/.test(call.path));
  assert.ok(generate);
  assert.deepEqual(generate!.body, { projectId, expectedRevision: 3, maxCostUsd: '0.42' });
  assert.equal(controller.getSnapshot().workspace?.shots[0]!.revision, 3, 'a refresh must follow the accepted submit');

  // The stored review id is the only status handle for a still image.
  markResultReady();
  await click('Check status');
  assert.ok(calls.some(call => call.method === 'GET' && call.path === `/api/frame-reviews/${reviewId}?projectId=${projectId}`), JSON.stringify(calls.map(call => `${call.method} ${call.path}`)));

  await click('Inspect returned image');
  const imported = calls.find(call => /\/import$/.test(call.path));
  assert.deepEqual(imported!.body, { projectId });
  const image = await screen.findByRole('img', { name: /Returned start frame/ });
  assert.equal(image.getAttribute('src'), `/api/media/${assetId}`);

  await click('Bind to start frame');
  const bind = calls.find(call => /\/bind$/.test(call.path));
  assert.deepEqual(bind!.body, { projectId, shotId, role: 'first_frame', assetId, expectedRevision: 3 });
  assert.ok(screen.getByText(/Bound to start frame at shot revision 5/));
});

test('an unsaved shot draft stops frame authoring instead of spending from a stale revision', async () => {
  const { controller, calls } = await mount();
  controller.markDirty(shotId);
  await assert.rejects(
    () => controller.prepareFrameReview({ projectId, shotId, expectedRevision: 3, role: 'first_frame', prompt: 'Cold dawn', modelId: 'acme/frame-2', aspectRatio: '16:9', sourceAssetId: null }),
    /Save or discard/,
  );
  await assert.rejects(
    () => controller.approveAndGenerate({ reviewId, projectId, shotId, expectedRevision: 3, role: 'first_frame', prompt: 'Cold dawn', modelId: 'acme/frame-2', aspectRatio: '16:9', sourceAssetId: null, requestHash: sha, status: 'ready', blockers: [], estimateUsd: 0.42 }, { maxAttempts: 1, maxCostUsd: '0.42' }),
    /Save or discard/,
  );
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
});

test('an unquoted estimate keeps generation blocked in the mounted panel', async () => {
  const { controller } = await mount();
  await click('Author');
  await act(async () => { fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Cold dawn' } }); });
  await click('Prepare review');
  const review = { reviewId, projectId, shotId, expectedRevision: 3, role: 'first_frame' as const, prompt: 'Cold dawn', modelId: 'acme/frame-2', aspectRatio: '16:9', sourceAssetId: null, requestHash: sha, status: 'ready' as const, blockers: [], estimateUsd: null };
  await assert.rejects(() => controller.approveAndGenerate(review, { maxAttempts: 1, maxCostUsd: '1.00' }), /Unknown is not free/);
});

test('storyboard planning reports the actual planner blocker and never fabricates a proposal', async () => {
  const { calls, controller } = await mount({ storyboard: { available: false, blocker: 'No planner model is configured.' } });
  assert.equal(controller.getSnapshot().authoring.capabilities?.storyboard.available, false);
  await assert.rejects(() => controller.proposeStoryboard('A ridge at dawn.'), /No planner model is configured\./);
  assert.equal(calls.filter(call => call.path === '/api/storyboard-proposals').length, 0);
  assert.equal(controller.getSnapshot().authoring.proposal, null);
});

test('an unconfigured planner leaves storyboard availability unknown rather than assumed', async () => {
  const { calls, controller } = await mount({ storyboard: { available: false, blocker: 'No planner model is configured.' } });
  const storyboard = controller.getSnapshot().authoring.capabilities?.storyboard;
  assert.deepEqual(storyboard, { available: false, blocker: 'No planner model is configured.' });
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
});

test('the storyboard and authoring entry points are in the real workspace chrome', async () => {
  const { controller } = await mount();
  const storyboard = screen.getByRole('button', { name: 'Storyboard' }) as HTMLButtonElement;
  assert.equal(storyboard.disabled, false);
  assert.equal(storyboard.getAttribute('aria-expanded'), 'false');
  const author = screen.getByRole('button', { name: 'Author' }) as HTMLButtonElement;
  assert.equal(author.disabled, false);
  assert.equal(controller.getSnapshot().authoring.capabilities?.imageModels.length, 1);
});
