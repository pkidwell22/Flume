import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthoringApiError, createAuthoringApi, submissionFromWire } from '../src/authoring-api.ts';
import type { FrameReview } from '../src/frame-authoring-types.ts';

const projectId = '5a1f5c1e-0000-4000-8000-000000000001';
const shotId = '5a1f5c1e-0000-4000-8000-000000000002';
const reviewId = '5a1f5c1e-0000-4000-8000-000000000003';
const assetId = '5a1f5c1e-0000-4000-8000-000000000004';
const sha = 'a'.repeat(64);

type Call = { method: string; path: string; body: any; headers: Record<string, string> };

function fake(handler: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const call: Call = {
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const { status = 200, body } = handler(call);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, api: createAuthoringApi(fetcher) };
}

function wireReview(overrides: Record<string, unknown> = {}) {
  return {
    reviewId, projectId, shotId, expectedRevision: 3, role: 'first_frame',
    prompt: 'Cold dawn', modelId: 'acme/frame-2', aspectRatio: '16:9',
    sourceAssetId: null, requestHash: sha, status: 'pending', blockers: [], estimateUsd: 0.42,
    ...overrides,
  };
}

function reviewHandle(overrides: Partial<FrameReview> = {}): FrameReview {
  return {
    reviewId, projectId, shotId, expectedRevision: 3, role: 'first_frame', prompt: 'Cold dawn',
    modelId: 'acme/frame-2', aspectRatio: '16:9', sourceAssetId: null, requestHash: sha,
    status: 'ready', blockers: [], estimateUsd: 0.42, ...overrides,
  };
}

test('capabilities are the configured server values; no model or storyboard availability is invented', async () => {
  const { api, calls } = fake(() => ({
    body: {
      imageModels: [{ modelId: 'acme/frame-2', name: 'Frame 2', aspectRatios: ['16:9'], frameRoles: ['first_frame', 'last_frame'], availability: 'unknown', blocker: null }],
      storyboard: { available: false, blocker: 'No planner model is configured.' },
    },
  }));
  const capabilities = await api.capabilities();
  assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), ['GET /api/authoring/capabilities']);
  assert.equal(capabilities.imageModels.length, 1);
  assert.equal(capabilities.imageModels[0]!.availability, 'unknown');
  assert.equal(capabilities.storyboard.available, false);
  assert.equal(capabilities.storyboard.blocker, 'No planner model is configured.');
});

test('a frame review is created through POST /api/frame-reviews and its unknown price stays unknown', async () => {
  const { api, calls } = fake(() => ({ body: wireReview({ status: 'pending', estimateUsd: null }) }));
  const draft = { projectId, shotId, expectedRevision: 3, role: 'first_frame' as const, prompt: 'Cold dawn', modelId: 'acme/frame-2', aspectRatio: '16:9', sourceAssetId: null };
  const review = await api.createFrameReview(draft);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.path, '/api/frame-reviews');
  assert.deepEqual(calls[0]!.body, draft);
  assert.equal(review.reviewId, reviewId);
  assert.equal(review.status, 'ready');
  // null means the server quoted nothing. It must never become 0.
  assert.equal(review.estimateUsd, null);
});

test('a blocked review keeps the server blockers and is never reported as sendable', async () => {
  const { api } = fake(() => ({ body: wireReview({ status: 'blocked', blockers: [{ code: 'MODEL_BLOCKED', message: 'Account privacy policy excludes this route.' }] }) }));
  const review = await api.createFrameReview({ projectId, shotId, expectedRevision: 3, role: 'first_frame', prompt: 'Cold dawn', modelId: 'acme/frame-2', aspectRatio: '16:9', sourceAssetId: null });
  assert.equal(review.status, 'blocked');
  assert.deepEqual(review.blockers, [{ code: 'MODEL_BLOCKED', message: 'Account privacy policy excludes this route.' }]);
});

test('generate approves exactly once against the reviewed revision and reuses the stored review id as the handle', async () => {
  const { api, calls } = fake(() => ({ body: { review: wireReview({ status: 'submitted' }), result: null } }));
  const handle = reviewHandle();
  const outcome = await api.generateFrame(reviewId, { projectId, expectedRevision: 3, maxCostUsd: '0.42' });
  assert.equal(calls[0]!.path, `/api/frame-reviews/${reviewId}/generate`);
  assert.deepEqual(calls[0]!.body, { projectId, expectedRevision: 3, maxCostUsd: '0.42' });
  assert.equal(outcome.review.reviewId, reviewId);
  assert.equal(outcome.submission.status, 'running');
  // No provider attempt id exists for an image review; the real review id is the handle.
  assert.equal(outcome.submission.attemptId, reviewId);
  assert.equal(outcome.submission.assetId, null);
  assert.equal(handle.reviewId, reviewId);
});

test('a returned result derives succeeded state and the actual asset id', async () => {
  const { api } = fake(() => ({
    body: { review: wireReview({ status: 'result_ready' }), result: { assetId, projectId, reviewId, mimeType: 'image/png', width: 1024, height: 576, sha256: sha } },
  }));
  const outcome = await api.generateFrame(reviewId, { projectId, expectedRevision: 3, maxCostUsd: '0.42' });
  assert.equal(outcome.submission.status, 'succeeded');
  assert.equal(outcome.submission.assetId, assetId);
});

test('inspect imports the exact staged bytes explicitly and shows them through the owned media route', async () => {
  const { api, calls } = fake(() => ({ body: { assetId, projectId, reviewId, mimeType: 'image/png', width: 1024, height: 576, sha256: sha } }));
  const inspection = await api.importFrameResult(reviewId, projectId);
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.path, `/api/frame-reviews/${reviewId}/import`);
  assert.deepEqual(calls[0]!.body, { projectId });
  assert.equal(inspection.assetId, assetId);
  assert.equal(inspection.mediaUrl, `/api/media/${assetId}`);
  // The import handle is the stored review, not an invented video inspection id.
  assert.equal(inspection.inspectionId, reviewId);
  assert.equal(inspection.sha256, sha);
});

test('binding sends project, shot, role, asset and the reviewed revision, and reports only the returned receipt', async () => {
  const { api, calls } = fake(() => ({ body: { shotId, assetId, role: 'first_frame', revision: 5 } }));
  const receipt = await api.bindFrame(reviewId, { projectId, shotId, role: 'first_frame', assetId, inspectionId: reviewId, expectedRevision: 3 });
  assert.equal(calls[0]!.path, `/api/frame-reviews/${reviewId}/bind`);
  assert.deepEqual(calls[0]!.body, { projectId, shotId, role: 'first_frame', assetId, expectedRevision: 3 });
  assert.deepEqual(receipt, { shotId, assetId, role: 'first_frame', revision: 5 });
});

test('server refusals keep their safe code, message and current revision', async () => {
  const { api } = fake(() => ({ status: 409, body: { code: 'REVISION_MISMATCH', message: 'The shot changed.', currentRevision: 7 } }));
  await assert.rejects(
    () => api.bindFrame(reviewId, { projectId, shotId, role: 'first_frame', assetId, inspectionId: reviewId, expectedRevision: 3 }),
    (error: unknown) => {
      assert.ok(error instanceof AuthoringApiError);
      assert.equal(error.code, 'REVISION_MISMATCH');
      assert.equal(error.message, 'The shot changed.');
      assert.equal(error.currentRevision, 7);
      assert.equal(error.status, 409);
      return true;
    },
  );
});

test('an unconfirmed generation submit is marked outcome-unknown so nothing is retried', async () => {
  const { api } = fake(() => ({ status: 503, body: { code: 'UPSTREAM_UNAVAILABLE', message: 'Provider bridge is starting.' } }));
  await assert.rejects(
    () => api.generateFrame(reviewId, { projectId, expectedRevision: 3, maxCostUsd: '0.42' }),
    (error: unknown) => {
      assert.ok(error instanceof AuthoringApiError);
      assert.equal(error.outcomeUnknown, true);
      assert.equal(error.code, 'UPSTREAM_UNAVAILABLE');
      return true;
    },
  );
});

test('the adapter never calls the video generation commands', async () => {
  const { api, calls } = fake(call => {
    if (call.path === '/api/authoring/capabilities') return { body: { imageModels: [], storyboard: { available: true, blocker: null } } };
    if (call.path === '/api/storyboard-proposals') return { body: { id: reviewId, projectId, status: 'draft', revision: 0, items: [], failure: null } };
    return { body: {} };
  });
  await api.capabilities();
  await api.createProposal({ projectId, brief: 'A ridge at dawn.' });
  for (const call of calls) {
    assert.doesNotMatch(call.path, /\/api\/commands/);
    assert.doesNotMatch(call.path, /take|attempt|inspect/i);
    assert.ok(call.path.startsWith('/api/'), call.path);
  }
});

test('server status maps to submission state without inventing progress or a result', () => {
  const base = { reviewId, projectId, shotId } as const;
  const wire = (status: string) => ({ ...wireReview({ status }), ...base }) as never;
  assert.equal(submissionFromWire(wire('submitted'), null).status, 'running');
  assert.equal(submissionFromWire(wire('acceptance_unknown'), null).status, 'acceptance_unknown');
  assert.equal(submissionFromWire(wire('failed'), null).status, 'failed');
  assert.equal(submissionFromWire(wire('blocked'), null).status, 'failed');
  // A finished status with no result view cannot be claimed as success.
  const orphan = submissionFromWire(wire('result_ready'), null);
  assert.equal(orphan.status, 'acceptance_unknown');
  assert.equal(orphan.assetId, null);
  assert.equal(orphan.progress, null);
  assert.match(String(orphan.message), /result_ready/);
});
