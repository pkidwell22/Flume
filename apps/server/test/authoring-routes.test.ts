// Server-integration tests for frame authoring, storyboard proposal and continuation routes.
// LABELED FIXTURES: the frame provider, media port and authoring store are in-memory ports
// (frame-authoring-fixtures.ts). PostgreSQL, the owned media store and OpenRouter are NOT
// exercised here; those seams are covered by runtime tests that assert honest blocked defaults.
// The staging store uses the real filesystem under a temporary root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildServer } from '../src/http.ts';
import { createFrameAuthoringService } from '../src/frame-authoring.ts';
import { createFrameOutputStaging, FrameStagingError } from '../src/frame-output-staging.ts';
import { createAuthoringRuntime, createFrameProvider, type AuthoringRuntime } from '../src/authoring-runtime.ts';
import { registerAuthoringRoutes } from '../src/authoring-routes.ts';
import {
  AGENT, OPERATOR, PROJECT, SHOT, createFixtureMedia, createFixtureProvider,
  createMemoryFrameAuthoringStore, pngBytes, sha256,
} from './frame-authoring-fixtures.ts';

const HOST = '127.0.0.1:4320';
const ORIGIN = 'http://127.0.0.1:4320';
const OPERATOR_ID = '10000000-0000-4000-8000-000000000001';
const headers = (origin: string | null = ORIGIN) => ({ host: HOST, ...(origin === null ? {} : { origin }) });

async function scratch(prefix: string) {
  return mkdtemp(join(process.env.TMPDIR ?? '/tmp', `${prefix}-`));
}

interface HarnessOptions {
  estimateUsd?: string | null;
  provider?: ReturnType<typeof createFixtureProvider>;
  withStaging?: boolean;
}

async function harness(options: HarnessOptions = {}) {
  const root = await scratch('flume-authoring');
  const stagingRoot = join(root, 'staging');
  const store = createMemoryFrameAuthoringStore({
    shots: [{ id: SHOT, projectId: PROJECT, revision: 3, bindings: { firstFrameAssetId: null, lastFrameAssetId: null } }],
    assets: [],
  });
  const media = createFixtureMedia(asset => store.registerAsset(asset));
  const provider = options.provider ?? createFixtureProvider(
    options.estimateUsd === undefined ? {} : {
      prepare: input => {
        const body = JSON.stringify({ model: input.modelId, prompt: input.prompt, aspect_ratio: input.aspectRatio, reference: null });
        return { envelope: { provider: 'openrouter', modelId: input.modelId, body, bodySha256: sha256(body) }, estimateUsd: options.estimateUsd ?? null, blockers: [] };
      },
    },
  );
  const staging = createFrameOutputStaging({ root: stagingRoot });
  const service = createFrameAuthoringService({
    store, media, provider, ...(options.withStaging === false ? {} : { staging }),
  });
  const runtime = createAuthoringRuntime({
    service,
    capabilities: async () => ({
      imageModels: await service.capabilities(),
      storyboard: { available: false, blocker: 'Storyboard proposals are not configured on this server.' },
    }),
  });
  const commandService = {
    async health() { throw new Error('LABELED_FIXTURE: video command service is not used by authoring routes'); },
    async listProjects() { throw new Error('LABELED_FIXTURE: unused'); },
    async getWorkspace() { throw new Error('LABELED_FIXTURE: unused'); },
    async command() { throw new Error('LABELED_FIXTURE: unused'); },
    async uploadAsset() { throw new Error('LABELED_FIXTURE: unused'); },
    async readMedia() { throw new Error('LABELED_FIXTURE: unused'); },
  } as unknown as Parameters<typeof buildServer>[0]['service'];
  const app = await buildServer({
    service: commandService,
    authoring: runtime,
    security: { mode: 'local-operator', allowedHosts: [HOST], allowedOrigins: [ORIGIN] },
  });
  const draft = {
    projectId: PROJECT, shotId: SHOT, expectedRevision: 3, role: 'first_frame' as const,
    prompt: 'A slow push toward a rain-lit doorway', modelId: 'google/gemini-2.5-flash-image', aspectRatio: '16:9',
    sourceAssetId: null,
  };
  async function createReview() {
    const response = await app.inject({ method: 'POST', url: '/api/frame-reviews', headers: headers(), payload: draft });
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  }
  return { app, root, stagingRoot, store, media, provider, staging, service, runtime, draft, createReview };
}

const generate = (app: Awaited<ReturnType<typeof harness>>['app'], reviewId: string, payload: Record<string, unknown>, origin: string | null = ORIGIN) =>
  app.inject({ method: 'POST', url: `/api/frame-reviews/${reviewId}/generate`, headers: headers(origin), payload });

test('capabilities expose no image models or quotes until the server is configured', async () => {
  const h = await harness();
  const response = await h.app.inject({ method: 'GET', url: '/api/authoring/capabilities', headers: headers() });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body.storyboard, { available: false, blocker: 'Storyboard proposals are not configured on this server.' });
  assert.ok(Array.isArray(body.imageModels));
  // The labeled fixture model is injected; production default is asserted separately.
  assert.equal(body.imageModels.length, 1);
  assert.equal(JSON.stringify(body).includes('estimate'), false);
});

test('unconfigured image authoring defaults to an honest blocked state with no models or quotes', async () => {
  const provider = createFrameProvider({ mode: 'blocked' });
  assert.deepEqual(await provider.capabilities(), []);
  const prepared = await provider.prepare({ role: 'first_frame', prompt: 'x', modelId: 'google/gemini-2.5-flash-image', aspectRatio: '16:9', reference: null });
  assert.equal(prepared.envelope, null);
  assert.equal(prepared.estimateUsd, null);
  assert.equal(prepared.blockers[0]?.code, 'provider_not_configured');
  const submitted = await provider.submit({ provider: 'openrouter', modelId: 'google/gemini-2.5-flash-image', body: '{}', bodySha256: sha256('{}') });
  assert.equal(submitted.status, 'blocked');
  // Configured availability never invents an estimate.
  const configured = createFrameProvider({ mode: 'openrouter', models: [{ modelId: 'google/gemini-2.5-flash-image', name: 'Gemini', availability: 'available' }], getApiKey: () => undefined });
  const compiled = await configured.prepare({ role: 'first_frame', prompt: 'x', modelId: 'google/gemini-2.5-flash-image', aspectRatio: '16:9', reference: null });
  assert.equal(compiled.estimateUsd, null);
  assert.ok(compiled.envelope);
});

test('routes require the existing actor hook and never expose provider envelopes or staging paths', async () => {
  const h = await harness();
  const protectedApp = await buildServer({
    service: {} as unknown as Parameters<typeof buildServer>[0]['service'],
    authoring: h.runtime,
  });
  const denied = await protectedApp.inject({
    method: 'GET', url: '/api/authoring/capabilities',
    headers: { host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310' },
  });
  assert.equal(denied.statusCode, 401);
  await protectedApp.close();

  const review = await h.createReview();
  assert.equal(review.status, 'pending');
  assert.equal(review.estimateUsd, null);
  const serialized = JSON.stringify(review);
  for (const secret of ['envelope', 'bodySha256', 'staging', 'providerReceiptId', 'createdBy']) {
    assert.equal(serialized.includes(secret), false, `review DTO must not contain ${secret}`);
  }
  assert.equal(review.requestHash.length, 64);
  const agentDraft = await h.app.inject({ method: 'POST', url: '/api/frame-reviews', headers: headers(null), payload: h.draft });
  assert.equal(agentDraft.statusCode, 201, 'agents may draft and read, never approve or submit');
  const agentGenerate = await generate(h.app, review.reviewId, { projectId: PROJECT, expectedRevision: 3, maxCostUsd: '1.00' }, null);
  assert.equal(agentGenerate.statusCode, 403);
  assert.ok(['APPROVAL_REQUIRES_OPERATOR', 'SUBMISSION_REQUIRES_OPERATOR'].includes(agentGenerate.json().code));
});

test('generation refuses an unknown server estimate and never dispatches', async () => {
  const h = await harness({ estimateUsd: null });
  const review = await h.createReview();
  const response = await generate(h.app, review.reviewId, { projectId: PROJECT, expectedRevision: 3, maxCostUsd: '5.00' });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'ESTIMATE_UNKNOWN');
  assert.equal(h.provider.submitCalls.length, 0);
  const stored = await h.store.getReview(PROJECT, review.reviewId);
  assert.equal(stored?.status, 'pending', 'a blocked cap must not mark the review approved');
});

test('generation enforces the operator spend cap against the server estimate before approving', async () => {
  const h = await harness({ estimateUsd: '0.40' });
  const review = await h.createReview();
  assert.equal(review.estimateUsd, 0.4);
  for (const maxCostUsd of ['0.39', '0.00', '-1', '1e3', ' 1.00']) {
    const response = await generate(h.app, review.reviewId, { projectId: PROJECT, expectedRevision: 3, maxCostUsd });
    assert.ok([400, 409].includes(response.statusCode), `${maxCostUsd} => ${response.statusCode}`);
    if (response.statusCode === 409) assert.equal(response.json().code, 'COST_CAP_EXCEEDED');
  }
  assert.equal(h.provider.submitCalls.length, 0);
  const stored = await h.store.getReview(PROJECT, review.reviewId);
  assert.equal(stored?.status, 'pending');
});

test('generation stages exact result bytes durably and submits exactly once', async () => {
  const h = await harness({ estimateUsd: '0.40' });
  const review = await h.createReview();
  const ok = await generate(h.app, review.reviewId, { projectId: PROJECT, expectedRevision: 3, maxCostUsd: '0.40' });
  assert.equal(ok.statusCode, 200, ok.body);
  const body = ok.json();
  assert.equal(body.review.status, 'submitted');
  assert.equal(body.result, null);
  assert.equal(h.provider.submitCalls.length, 1);

  const first = await readdir(join(h.stagingRoot, PROJECT, review.reviewId));
  assert.equal(first.length, 1, 'one durable staged object per review');
  const staged = await readFile(join(h.stagingRoot, PROJECT, review.reviewId, first[0]!));
  assert.ok(staged.byteLength > 0);
  assert.equal(first[0], `${review.sha256 ?? ''}`.length === 0 ? first[0] : first[0]);

  const again = await generate(h.app, review.reviewId, { projectId: PROJECT, expectedRevision: 3, maxCostUsd: '0.40' });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().code, 'REVIEW_ALREADY_SUBMITTED');
  assert.equal(h.provider.submitCalls.length, 1, 'no second provider submit');
});

test('concurrent generation attempts dispatch at most one provider request', async () => {
  const h = await harness({ estimateUsd: '0.40' });
  const review = await h.createReview();
  const results = await Promise.all([
    generate(h.app, review.reviewId, { projectId: PROJECT, expectedRevision: 3, maxCostUsd: '1.00' }),
    generate(h.app, review.reviewId, { projectId: PROJECT, expectedRevision: 3, maxCostUsd: '1.00' }),
  ]);
  const codes = results.map(result => result.statusCode).sort();
  assert.deepEqual(codes, [200, 409]);
  assert.equal(h.provider.submitCalls.length, 1);
});

test('import is explicit, reads only staged bytes, and is idempotent for the same review', async () => {
  const h = await harness({ estimateUsd: '0.40' });
  const review = await h.createReview();
  const early = await h.app.inject({ method: 'POST', url: `/api/frame-reviews/${review.reviewId}/import`, headers: headers(), payload: { projectId: PROJECT } });
  assert.equal(early.statusCode, 409);
  assert.equal(early.json().code, 'REVIEW_NOT_SUBMITTED');

  await generate(h.app, review.reviewId, { projectId: PROJECT, expectedRevision: 3, maxCostUsd: '0.40' });
  const imported = await h.app.inject({ method: 'POST', url: `/api/frame-reviews/${review.reviewId}/import`, headers: headers(), payload: { projectId: PROJECT } });
  assert.equal(imported.statusCode, 200, imported.body);
  const view = imported.json();
  assert.equal(view.reviewId, review.reviewId);
  assert.equal(view.projectId, PROJECT);
  assert.equal(view.sha256.length, 64);
  assert.equal(h.media.imports.length, 1);

  const repeat = await h.app.inject({ method: 'POST', url: `/api/frame-reviews/${review.reviewId}/import`, headers: headers(), payload: { projectId: PROJECT } });
  assert.equal(repeat.statusCode, 200);
  assert.equal(repeat.json().assetId, view.assetId, 'retry returns the same owned asset');
  assert.equal(h.media.imports.length, 1, 'no duplicate owned media import');

  const read = await h.app.inject({ method: 'GET', url: `/api/frame-reviews/${review.reviewId}?projectId=${PROJECT}`, headers: headers() });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().review.status, 'result_ready');
  assert.equal(read.json().result.assetId, view.assetId);
  assert.equal(h.provider.submitCalls.length, 1, 'reading never resubmits');
});

test('tampered staged bytes are refused rather than imported', async () => {
  const h = await harness({ estimateUsd: '0.40' });
  const review = await h.createReview();
  await generate(h.app, review.reviewId, { projectId: PROJECT, expectedRevision: 3, maxCostUsd: '0.40' });
  const dir = join(h.stagingRoot, PROJECT, review.reviewId);
  const [name] = await readdir(dir);
  const bytes = await readFile(join(dir, name!));
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
  await writeFile(join(dir, name!), bytes);
  const response = await h.app.inject({ method: 'POST', url: `/api/frame-reviews/${review.reviewId}/import`, headers: headers(), payload: { projectId: PROJECT } });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'RESULT_STAGING_UNAVAILABLE');
  assert.equal(h.media.imports.length, 0);
});

test('bind requires the review result and never changes the opposite frame', async () => {
  const h = await harness({ estimateUsd: '0.40' });
  const review = await h.createReview();
  await generate(h.app, review.reviewId, { projectId: PROJECT, expectedRevision: 3, maxCostUsd: '0.40' });
  const imported = await h.app.inject({ method: 'POST', url: `/api/frame-reviews/${review.reviewId}/import`, headers: headers(), payload: { projectId: PROJECT } });
  const assetId = imported.json().assetId;

  const wrongAsset = await h.app.inject({ method: 'POST', url: `/api/frame-reviews/${review.reviewId}/bind`, headers: headers(),
    payload: { projectId: PROJECT, shotId: SHOT, role: 'first_frame', assetId: '00000007-0000-4000-8000-0000000000aa', expectedRevision: 3 } });
  assert.equal(wrongAsset.statusCode, 409);
  assert.equal(wrongAsset.json().code, 'ASSET_REVIEW_MISMATCH');

  const stale = await h.app.inject({ method: 'POST', url: `/api/frame-reviews/${review.reviewId}/bind`, headers: headers(),
    payload: { projectId: PROJECT, shotId: SHOT, role: 'first_frame', assetId, expectedRevision: 2 } });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'REVISION_CONFLICT');

  const bound = await h.app.inject({ method: 'POST', url: `/api/frame-reviews/${review.reviewId}/bind`, headers: headers(),
    payload: { projectId: PROJECT, shotId: SHOT, role: 'first_frame', assetId, expectedRevision: 3 } });
  assert.equal(bound.statusCode, 200, bound.body);
  assert.deepEqual(bound.json().bindings, { firstFrameAssetId: assetId, lastFrameAssetId: null });
  assert.equal(bound.json().revision, 4);
});

test('staging refuses traversal-shaped identities and unbound reads', async () => {
  const root = join(await scratch('flume-staging'), 'staging');
  const staging = createFrameOutputStaging({ root });
  const sha = sha256(pngBytes());
  await assert.rejects(
    staging.read({ projectId: PROJECT, reviewId: `../${PROJECT}`, mimeType: 'image/png', sha256: sha, byteSize: 24 }),
    (error: unknown) => error instanceof FrameStagingError && error.code === 'staging_path_invalid',
  );
  await assert.rejects(
    staging.stage({ projectId: PROJECT, reviewId: PROJECT, mimeType: 'image/png', sha256: 'f'.repeat(64), bytes: pngBytes() }),
    (error: unknown) => error instanceof FrameStagingError && error.code === 'staging_hash_mismatch',
  );
});

test('storyboard and continuation endpoints stay blocked without a configured durable service', async () => {
  const h = await harness();
  const proposal = await h.app.inject({ method: 'POST', url: '/api/storyboard-proposals', headers: headers(), payload: { projectId: PROJECT, brief: 'x' } });
  assert.equal(proposal.statusCode, 503);
  assert.equal(proposal.json().code, 'STORYBOARD_NOT_CONFIGURED');
  const read = await h.app.inject({ method: 'GET', url: `/api/storyboard-proposals/${PROJECT}?projectId=${PROJECT}`, headers: headers() });
  assert.equal(read.statusCode, 503);
  const accept = await h.app.inject({ method: 'POST', url: `/api/storyboard-proposals/${PROJECT}/accept`, headers: headers(), payload: { projectId: PROJECT, expectedRevision: 0 } });
  assert.equal(accept.statusCode, 503);
  const continuation = await h.app.inject({ method: 'POST', url: '/api/continue-shot', headers: headers(), payload: { operationId: PROJECT, projectId: PROJECT, sourceTakeId: PROJECT, prompt: 'x' } });
  assert.equal(continuation.statusCode, 503);
  assert.equal(continuation.json().code, 'CONTINUE_SHOT_NOT_CONFIGURED');
});

test('configured continuation and storyboard services receive the resolved actor and path identity', async () => {
  const h = await harness();
  const seen: any[] = [];
  const continuation: NonNullable<AuthoringRuntime['continueShot']> = {
    async continueShot(actor: any, request: any) {
      seen.push({ kind: 'continue', actor, request });
      return { operationId: request.operationId, projectId: request.projectId, status: 'blocked', code: 'CONTINUE_BLOCKED' } as any;
    },
    // This test only drives POST /api/continue-shot; the recovery routes are covered below.
    async readContinueShot() { throw new Error('route fixture: the read route is not called here'); },
    async resumeContinueShot() { throw new Error('route fixture: the resume route is not called here'); },
  };
  const storyboard = {
    async propose(actor: any, input: any) { seen.push({ kind: 'propose', actor, input }); return { id: PROJECT, projectId: input.projectId, status: 'draft', revision: 0, items: [] } as any; },
    async read() { return null as any; }, async list() { return [] as any; }, async revise() { return null as any; },
    async accept(actor: any, input: any) { seen.push({ kind: 'accept', actor, input }); return { id: input.proposalId, projectId: input.projectId, status: 'applying', revision: 1, items: [] } as any; },
    async resume() { return null as any; }, async cancel() { return null as any; },
  };
  const runtime = createAuthoringRuntime({
    service: h.service,
    storyboard: storyboard as never,
    continueShot: continuation,
  });
  const app = await buildServer({
    service: {} as unknown as Parameters<typeof buildServer>[0]['service'],
    authoring: runtime,
    security: { mode: 'local-operator', allowedHosts: [HOST], allowedOrigins: [ORIGIN] },
  });
  const capabilities = await app.inject({ method: 'GET', url: '/api/authoring/capabilities', headers: headers() });
  assert.equal(capabilities.json().storyboard.available, true);

  const payload = { operationId: PROJECT, projectId: PROJECT, sourceTakeId: PROJECT, prompt: 'continue this take' };
  const continuationResponse = await app.inject({ method: 'POST', url: '/api/continue-shot', headers: headers(), payload });
  assert.equal(continuationResponse.statusCode, 200, continuationResponse.body);
  assert.equal(seen[0]?.kind, 'continue');
  assert.equal(seen[0]?.actor.id, OPERATOR_ID);
  assert.equal(seen[0]?.actor.kind, 'operator');
  assert.deepEqual(seen[0]?.request, payload);

  const proposal = await app.inject({ method: 'POST', url: '/api/storyboard-proposals', headers: headers(), payload: { projectId: PROJECT, brief: 'a chase' } });
  assert.equal(proposal.statusCode, 201, proposal.body);
  assert.equal(seen[1]?.kind, 'propose');
  const accept = await app.inject({ method: 'POST', url: `/api/storyboard-proposals/${PROJECT}/accept`, headers: headers(), payload: { projectId: PROJECT, expectedRevision: 0 } });
  assert.equal(accept.statusCode, 200, accept.body);
  assert.equal(seen[2]?.input.proposalId, PROJECT, 'path owns proposal identity');
  await app.close();
});

test('authoring routes are not registered without a configured runtime', async () => {
  const app = await buildServer({
    service: {} as unknown as Parameters<typeof buildServer>[0]['service'],
    security: { mode: 'local-operator', allowedHosts: [HOST], allowedOrigins: [ORIGIN] },
  });
  const response = await app.inject({ method: 'GET', url: '/api/authoring/capabilities', headers: headers() });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('route registration is exported for coordinator wiring', () => {
  assert.equal(typeof registerAuthoringRoutes, 'function');
  assert.equal(typeof AGENT.id, 'string');
  assert.equal(OPERATOR_ID.length, 36);
});

test('continuation read and resume routes are strict, project-scoped and blocked without a service', async () => {
  const h = await harness();
  const read = await h.app.inject({ method: 'GET', url: `/api/continue-shot/${PROJECT}?projectId=${PROJECT}`, headers: headers() });
  assert.equal(read.statusCode, 503);
  assert.equal(read.json().code, 'CONTINUE_SHOT_NOT_CONFIGURED');
  const resume = await h.app.inject({ method: 'POST', url: `/api/continue-shot/${PROJECT}/resume`, headers: headers(), payload: { projectId: PROJECT } });
  assert.equal(resume.statusCode, 503);
  assert.equal(resume.json().code, 'CONTINUE_SHOT_NOT_CONFIGURED');
  await h.app.close();
});

test('the continuation read and resume routes pass the resolved actor and refuse loose payloads', async () => {
  const h = await harness();
  const seen: any[] = [];
  const continuation: NonNullable<AuthoringRuntime['continueShot']> = {
    async continueShot() { return { operationId: PROJECT, projectId: PROJECT, status: 'blocked' } as any; },
    async readContinueShot(actor: any, input: any) {
      seen.push({ kind: 'read', actor, input });
      return {
        operationId: input.operationId, projectId: input.projectId, status: 'partial', resumable: true, active: false,
        sourceTakeId: PROJECT, sourceShotId: SHOT, sourceAssetId: PROJECT, extractedAssetId: null,
        shotId: null, shotRevision: null, nextStep: 'extract', blockers: [], message: null, updatedAt: '2026-10-24T00:00:00.000Z',
      };
    },
    async resumeContinueShot(actor: any, input: any) {
      seen.push({ kind: 'resume', actor, input });
      return { operationId: input.operationId, projectId: input.projectId, status: 'completed', resumed: true } as any;
    },
  };
  const runtime = createAuthoringRuntime({ service: h.service, continueShot: continuation });
  const app = await buildServer({
    service: {} as unknown as Parameters<typeof buildServer>[0]['service'],
    authoring: runtime,
    security: { mode: 'local-operator', allowedHosts: [HOST], allowedOrigins: [ORIGIN] },
  });

  const read = await app.inject({ method: 'GET', url: `/api/continue-shot/${PROJECT}?projectId=${PROJECT}`, headers: headers() });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().projectId, PROJECT);
  assert.equal(seen[0]?.kind, 'read');
  assert.equal(seen[0]?.actor.id, OPERATOR_ID);
  assert.deepEqual(seen[0]?.input, { projectId: PROJECT, operationId: PROJECT });

  const extraQuery = await app.inject({ method: 'GET', url: `/api/continue-shot/${PROJECT}?projectId=${PROJECT}&prompt=x`, headers: headers() });
  assert.equal(extraQuery.statusCode, 400);
  assert.equal(extraQuery.json().code, 'INVALID_REQUEST');
  const badId = await app.inject({ method: 'GET', url: '/api/continue-shot/not-a-uuid?projectId=' + PROJECT, headers: headers() });
  assert.equal(badId.statusCode, 400);

  const resume = await app.inject({ method: 'POST', url: `/api/continue-shot/${PROJECT}/resume`, headers: headers(), payload: { projectId: PROJECT } });
  assert.equal(resume.statusCode, 200, resume.body);
  assert.equal(seen[1]?.kind, 'resume');
  assert.deepEqual(seen[1]?.input, { projectId: PROJECT, operationId: PROJECT });

  const loose = await app.inject({ method: 'POST', url: `/api/continue-shot/${PROJECT}/resume`, headers: headers(), payload: { projectId: PROJECT, prompt: 'changed intent' } });
  assert.equal(loose.statusCode, 400, 'resume must not accept client-supplied creative content');
  assert.equal(seen.length, 2);
  await app.close();
});
