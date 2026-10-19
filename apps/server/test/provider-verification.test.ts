import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {MediaStore} from '@flume/media';
import {createProviderBridge, type ProviderBridgeVerificationReference} from '../src/provider-bridge.ts';
import type {Shot} from '../src/dto.ts';
import {createCommandService} from '../src/service.ts';
import {verifyReview} from '../src/generation.ts';
import {sha256} from '../src/contracts.ts';
import {migrate} from '@flume/database';
import {ownedPostgres} from '../../../packages/database/test/owned-postgres.ts';
import {WorkspaceSchema} from '@flume/domain';

const WAN = 'alibaba/wan-2.7';
const CANONICAL = 'alibaba/wan-2.7-20260414';
const H3 = 'minimax/hailuo-3';
const JOB = 'fixture-wan-job';
const GENERATION = 'fixture-wan-generation';
const scope = 'controlled-verification-fixture';
const KEY = 'SYNTHETIC-FIXTURE-KEY';
const allowRetention = {h3RetentionDecision: 'allow-temporary-retention'} as const;
const keepBlocked = {h3RetentionDecision: 'keep-blocked'} as const;

const model = (id: string, canonicalSlug: string, extra: Record<string, unknown> = {}) => ({
  id, name: `Synthetic ${id}`, canonical_slug: canonicalSlug,
  supported_durations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
  supported_resolutions: ['720p', '1080p'], supported_aspect_ratios: ['16:9'],
  supported_frame_images: ['first_frame', 'last_frame'], seed: false, generate_audio: false,
  pricing_skus: {duration_seconds: '0.1'}, ...extra,
});
const defaultCatalog = {data: [model(WAN, CANONICAL), model('fixture/other', 'fixture/other')]};
// A catalog that explicitly advertises controls outside the WAN estimator's narrow pricing
// profile, so capability validation alone cannot reject the request.
const wideCatalog = (extra: Record<string, unknown> = {}) => ({data: [
  model(WAN, CANONICAL, {supported_durations: [5, 12], supported_resolutions: ['720p', '1080p', '4K'],
    supported_aspect_ratios: ['16:9', '9:16'], ...extra}),
  model('fixture/other', 'fixture/other'),
]});

const defaultJob = {
  id: JOB, generation_id: GENERATION, status: 'completed',
  unsigned_urls: [`https://openrouter.ai/api/v1/videos/${JOB}/content?index=0`],
  urls: ['https://signed.example.invalid/never-retained?signature=fixture'],
  expires_at: '2030-01-01T00:00:00.000Z', usage: {cost: 0.5},
};
const defaultGeneration = {id: GENERATION, model: CANONICAL, provider: 'AtlasCloud', total_cost: 0.5, is_byok: false, cancelled: false};
const noDatabase = {async query() {throw new Error('Unexpected database access');}} as unknown as Pool;
const noMedia = {} as MediaStore;
const signal = () => new AbortController().signal;

async function fixture(t: TestContext) {
  const state = {
    catalog: defaultCatalog as unknown, catalogStatus: 200,
    job: defaultJob as unknown, jobStatus: 200,
    generation: defaultGeneration as unknown, generationStatus: 200,
  };
  const requests: {method: string | undefined; url: string | undefined; auth: string | undefined; body: string}[] = [];
  const server = createServer(async (q, r) => {
    const chunks: Buffer[] = [];
    for await (const chunk of q) chunks.push(Buffer.from(chunk));
    requests.push({method: q.method, url: q.url, auth: q.headers.authorization, body: Buffer.concat(chunks).toString('utf8')});
    r.setHeader('content-type', 'application/json');
    if (q.method === 'GET' && q.url === '/api/v1/videos/models') {r.statusCode = state.catalogStatus; r.end(JSON.stringify(state.catalog)); return;}
    if (q.method === 'GET' && q.url === `/api/v1/videos/${JOB}`) {r.statusCode = state.jobStatus; r.end(JSON.stringify(state.job)); return;}
    if (q.method === 'GET' && q.url === `/api/v1/generation?id=${GENERATION}`) {r.statusCode = state.generationStatus; r.end(JSON.stringify({data: state.generation})); return;}
    r.statusCode = 404; r.end(JSON.stringify({error: {message: 'Unexpected fixture path'}}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as {port: number}).port}/api/v1`;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(typeof input, 'string');
    assert.ok(String(input).startsWith(`${baseUrl}/`), 'no transport may leave the owned loopback fixture');
    return realFetch(input, init);
  });
  t.after(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    server.closeAllConnections(); await closed;
    assert.equal(server.listening, false);
  });
  return {
    state, requests, transport: {baseUrl, allowLoopbackHttpForTests: true as const},
    posts: () => requests.filter(r => r.method === 'POST'),
    reads: () => requests.filter(r => r.url !== '/api/v1/videos/models'),
  };
}

const bridgeFor = (f: Awaited<ReturnType<typeof fixture>>, options: {
  key?: string | undefined; policy?: typeof allowRetention | typeof keepBlocked;
  reference?: ProviderBridgeVerificationReference; media?: MediaStore;
} = {}) => createProviderBridge(noDatabase, options.media ?? noMedia, scope,
  options.key === undefined ? () => KEY : () => options.key as string,
  f.transport, options.policy, options.reference ?? {modelId: WAN, jobId: JOB});

const wanShot = (projectId = randomUUID()): Shot => ({
  id: randomUUID(), projectId, title: 'Wan verification', prompt: 'Literal fixture prompt', revision: 1,
  controls: {modelId: WAN, durationSeconds: 5, resolution: '720p', aspectRatio: '16:9', generateAudio: false},
  bindings: {firstFrameAssetId: null, lastFrameAssetId: null}, selectedTakeId: null, selectionRevision: 0,
});
const prepare = (bridge: ReturnType<typeof createProviderBridge>, shot: Shot) =>
  bridge.provider.prepare({projectId: shot.projectId, shot, assets: []});
// Catalog-advertised controls that the WAN estimator deliberately cannot price.
const wideShot = (projectId = randomUUID()): Shot => ({
  ...wanShot(projectId),
  controls: {modelId: WAN, durationSeconds: 12, resolution: '4K', aspectRatio: '9:16', generateAudio: false},
});
const codes = (blockers: Awaited<ReturnType<typeof prepare>>['blockers']) =>
  blockers.map(blocker => typeof blocker === 'string' ? blocker : blocker.code);

test('a verified prior Wan job makes exactly that route available and prices it from the catalog', async t => {
  const f = await fixture(t);
  const bridge = bridgeFor(f, {policy: allowRetention});
  assert.equal(await prepare(bridge, wanShot()).then(p => p.envelope), null, 'no catalog observation yet');
  await bridge.discover();
  const capabilities = await bridge.provider.capabilities();
  assert.equal(capabilities.find(c => c.modelId === WAN)!.availability, 'available');
  assert.equal(capabilities.find(c => c.modelId === WAN)!.blocker, null);
  assert.equal(capabilities.find(c => c.modelId === H3)!.availability, 'unknown');
  assert.equal(capabilities.find(c => c.modelId === 'fixture/other')!.availability, 'unknown');
  assert.equal(JSON.stringify(capabilities).includes(JOB), false, 'the job id is not projected');
  assert.equal(JSON.stringify(capabilities).includes(CANONICAL), false, 'the canonical slug is not projected');

  const shot = wanShot();
  const prepared = await prepare(bridge, shot);
  assert.deepEqual(prepared.blockers, []);
  assert.ok(prepared.envelope);
  assert.equal(prepared.estimatedCostUsd, '0.5');
  assert.equal(prepared.estimate?.modelId, WAN);
  assert.equal(prepared.estimate?.bodySha256, prepared.envelope.bodySha256);
  assert.equal(prepared.estimate?.lineItems[0].quantity, 5);

  const other = await prepare(bridge, {...shot, controls: {...shot.controls, modelId: 'fixture/other'}});
  assert.deepEqual(codes(other.blockers), ['ENTITLEMENT_UNKNOWN']);
  assert.equal(other.estimatedCostUsd, null);

  assert.equal(f.requests[0].url, '/api/v1/videos/models');
  assert.equal(f.requests[0].auth, undefined);
  assert.deepEqual(f.reads().map(r => [r.method, r.url, r.auth]), [
    ['GET', `/api/v1/videos/${JOB}`, `Bearer ${KEY}`],
    ['GET', `/api/v1/generation?id=${GENERATION}`, `Bearer ${KEY}`],
  ]);
  assert.equal(f.posts().length, 0, 'verification is read-only');
});

test('a verified route supports ordinary review, approval and hash-bound Wan estimate persistence', async t => {
  const f = await fixture(t);
  const db = await ownedPostgres();
  try {
    await migrate(db.pool);
    const bridge = createProviderBridge(db.pool, noMedia, scope, () => KEY, f.transport, allowRetention, {modelId: WAN, jobId: JOB});
    await bridge.discover();
    const service = createCommandService({pool: db.pool, provider: bridge.provider, workerAvailable: true});
    const actor = {id: randomUUID(), kind: 'operator' as const, projectIds: '*' as const};
    const send = (body: object) => service.command(actor, {commandId: randomUUID(), ...body});
    const {projectId} = await send({type: 'project.create', name: 'Verified Wan fixture', brief: ''});
    const shotId = (await send({type: 'shot.create', projectId, title: 'Wan', prompt: 'Literal fixture prompt'})).resourceId!;
    await send({type: 'shot.update', projectId, shotId, expectedRevision: 1,
      patch: {controls: {modelId: WAN, durationSeconds: 5, resolution: '720p', aspectRatio: '16:9', generateAudio: false}}});
    const {reviewId} = await send({type: 'generation.prepare', projectId, shotId, expectedRevision: 2});
    const row = (await db.pool.query('SELECT * FROM flume.reviews WHERE id=$1', [reviewId])).rows[0];
    assert.equal(row.estimated_cost_usd, '0.500000');
    assert.equal(row.blockers.length, 0);
    assert.equal(row.envelope.bodySha256, sha256(row.envelope.body));
    assert.equal(row.snapshot.estimate.modelId, WAN);
    assert.equal(row.snapshot.estimate.bodySha256, row.envelope.bodySha256);
    assert.deepEqual(WorkspaceSchema.parse(await service.getWorkspace(actor, projectId)).reviews[0].estimate, row.snapshot.estimate);
    assert.doesNotThrow(() => verifyReview(row));
    const tampered = structuredClone(row);
    tampered.snapshot.estimate.bodySha256 = 'f'.repeat(64);
    assert.throws(() => verifyReview(tampered), {code: 'REVIEW_INTEGRITY'});
    await send({type: 'generation.approve', projectId, reviewId, maxAttempts: 1, maxCostUsd: '0.5'});
    await send({type: 'generation.submit', projectId, reviewId});
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM flume.attempts')).rows[0].n, 1);
    assert.equal(f.posts().length, 0, 'queueing an attempt never submits during this path');
  } finally {await db.close();}
});

test('the H3 privacy hold takes precedence over a matching prior-job reference', async t => {
  const f = await fixture(t);
  f.state.catalog = {data: [model(H3, H3, {supported_durations: [5], supported_resolutions: ['2K']}), model(WAN, CANONICAL)]};
  f.state.job = {...defaultJob, id: 'fixture-h3-job'};
  f.state.generation = {...defaultGeneration, model: H3};
  const bridge = createProviderBridge(noDatabase, noMedia, scope, () => KEY, f.transport, keepBlocked,
    {modelId: H3, jobId: 'fixture-h3-job'});
  await bridge.discover();
  const h3 = (await bridge.provider.capabilities()).find(c => c.modelId === H3)!;
  assert.equal(h3.availability, 'blocked');
  const shot: Shot = {...wanShot(), controls: {modelId: H3, durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false}};
  assert.deepEqual(codes((await prepare(bridge, shot)).blockers), ['provider_privacy_blocked']);
  assert.deepEqual(f.reads(), [], 'a privacy-held model is never verified');
  assert.equal(f.posts().length, 0);
});

test('missing credentials remain blocked even with a matching reference', async t => {
  const f = await fixture(t);
  const bridge = createProviderBridge(noDatabase, noMedia, scope, undefined, f.transport, allowRetention, {modelId: WAN, jobId: JOB});
  await bridge.discover();
  const wan = (await bridge.provider.capabilities()).find(c => c.modelId === WAN)!;
  assert.equal(wan.availability, 'blocked');
  assert.match(wan.blocker!, /No generation credentials/);
  assert.deepEqual(codes((await prepare(bridge, wanShot())).blockers), ['PROVIDER_UNAVAILABLE']);
  assert.deepEqual(f.reads(), []);
});

test('mismatched job metadata, foreign jobs and wrong canonical models never verify', async t => {
  const f = await fixture(t);
  for (const [jobPatch, generationPatch, expectedReason] of [
    [{id: 'foreign-job'}, {}, 'job_identity_mismatch'],
    [{status: 'pending'}, {}, 'job_not_completed'],
    [{generation_id: 'foreign-generation'}, {}, 'generation_identity_mismatch'],
    [{}, {model: WAN}, 'canonical_model_mismatch'],
    [{}, {model: 'alibaba/wan-2.7-20260415'}, 'canonical_model_mismatch'],
    [{}, {id: 'foreign-generation'}, 'generation_identity_mismatch'],
  ] as [Record<string, unknown>, Record<string, unknown>, string][]) {
    f.state.job = {...defaultJob, ...jobPatch};
    f.state.generation = {...defaultGeneration, ...generationPatch};
    const bridge = bridgeFor(f, {policy: allowRetention});
    await bridge.discover();
    const wan = (await bridge.provider.capabilities()).find(c => c.modelId === WAN);
    assert.ok(wan, expectedReason);
    assert.equal(wan.availability, 'unknown', expectedReason);
    const prepared = await prepare(bridge, wanShot());
    assert.deepEqual(codes(prepared.blockers), ['ENTITLEMENT_UNKNOWN'], expectedReason);
    assert.equal(f.posts().length, 0);
  }
});

test('a malformed or partial reference is rejected before any bridge is constructed', async t => {
  const f = await fixture(t);
  for (const reference of [
    {modelId: WAN}, {jobId: JOB}, {modelId: WAN, jobId: JOB, extra: true},
    {modelId: ' alibaba/wan-2.7', jobId: JOB}, {modelId: WAN, jobId: 'bad id'},
  ]) {
    assert.throws(() => bridgeFor(f, {reference: reference as ProviderBridgeVerificationReference}), /verification/i);
  }
  assert.deepEqual(f.requests, []);
});

test('a failed or changed refresh clears verification and any prior price observation', async t => {
  const f = await fixture(t);
  const bridge = bridgeFor(f, {policy: allowRetention});
  await bridge.discover();
  assert.equal((await bridge.provider.capabilities()).find(c => c.modelId === WAN)!.availability, 'available');
  assert.equal((await prepare(bridge, wanShot())).estimatedCostUsd, '0.5');

  f.state.catalogStatus = 503;
  f.state.catalog = {error: {message: 'synthetic refresh failure'}};
  await bridge.discover();
  assert.equal((await bridge.provider.capabilities()).some(c => c.modelId === WAN), false,
    'a failed refresh cannot retain a previously discovered model or its price');
  let prepared = await prepare(bridge, wanShot());
  assert.equal(prepared.estimatedCostUsd, null);
  assert.deepEqual(codes(prepared.blockers), ['The requested model is absent from the verified catalog. No fallback was selected.']);

  f.state.catalogStatus = 200; f.state.catalog = defaultCatalog;
  f.state.job = {...defaultJob, status: 'failed'};
  await bridge.discover();
  const wan = (await bridge.provider.capabilities()).find(c => c.modelId === WAN)!;
  assert.equal(wan.availability, 'unknown', 'an observation that no longer proves completion clears verification');
  prepared = await prepare(bridge, wanShot());
  assert.deepEqual(codes(prepared.blockers), ['ENTITLEMENT_UNKNOWN']);
  assert.equal(f.posts().length, 0);
});

test('unknown or malformed Wan pricing blocks preparation instead of reviewing without a price', async t => {
  const f = await fixture(t);
  for (const pricingSkus of [undefined, null, {duration_seconds: '0.1', audio: '0'}, {duration_seconds: 0.1}, {},
    {duration_seconds: 'not-a-price'}, {duration_seconds: '0.0000001'}]) {
    f.state.catalog = {data: [model(WAN, CANONICAL, {pricing_skus: pricingSkus}), model('fixture/other', 'fixture/other')]};
    const bridge = bridgeFor(f, {policy: allowRetention});
    await bridge.discover();
    const wan = (await bridge.provider.capabilities()).find(c => c.modelId === WAN);
    assert.ok(wan, JSON.stringify(pricingSkus));
    assert.equal(wan.availability, 'available', 'canonical identity is independent of price');
    const prepared = await prepare(bridge, wanShot());
    assert.equal(prepared.envelope, null, JSON.stringify(pricingSkus));
    assert.equal(prepared.estimatedCostUsd, null, JSON.stringify(pricingSkus));
    assert.equal(prepared.estimate, undefined);
    assert.deepEqual(codes(prepared.blockers), ['WAN_ESTIMATE_UNKNOWN'], JSON.stringify(pricingSkus));
    assert.equal(f.posts().length, 0);
  }
});

test('a Wan review outside the priced profile is blocked even when the catalog advertises the controls', async t => {
  const f = await fixture(t);
  f.state.catalog = wideCatalog();
  const bridge = bridgeFor(f, {policy: allowRetention});
  await bridge.discover();
  assert.equal((await bridge.provider.capabilities()).find(c => c.modelId === WAN)!.availability, 'available');
  // Capability validation alone accepts these controls; only the estimator's profile refuses them.
  const prepared = await prepare(bridge, wideShot());
  assert.equal(prepared.envelope, null, 'an unpriced request never yields an approvable review envelope');
  assert.equal(prepared.estimatedCostUsd, null);
  assert.equal(prepared.estimate, undefined);
  assert.deepEqual(codes(prepared.blockers), ['WAN_ESTIMATE_UNKNOWN']);
  assert.equal(typeof prepared.blockers[0], 'object');
  assert.match((prepared.blockers[0] as {message: string}).message, /Wan 2\.7 catalog estimate/);
  // The same verified bridge still prices the supported 5s/720p/16:9/no-audio/no-seed profile.
  const priced = await prepare(bridge, wanShot());
  assert.deepEqual(priced.blockers, []);
  assert.ok(priced.envelope);
  assert.equal(priced.estimatedCostUsd, '0.5');
  assert.equal(f.posts().length, 0);
});

test('an unpriced Wan review is stored blocked and approval queues no attempts', async t => {
  const f = await fixture(t);
  f.state.catalog = wideCatalog();
  const db = await ownedPostgres();
  try {
    await migrate(db.pool);
    const bridge = createProviderBridge(db.pool, noMedia, scope, () => KEY, f.transport, allowRetention, {modelId: WAN, jobId: JOB});
    await bridge.discover();
    const service = createCommandService({pool: db.pool, provider: bridge.provider, workerAvailable: true});
    const actor = {id: randomUUID(), kind: 'operator' as const, projectIds: '*' as const};
    const send = (body: object) => service.command(actor, {commandId: randomUUID(), ...body});
    const {projectId} = await send({type: 'project.create', name: 'Unpriced Wan fixture', brief: ''});
    const shotId = (await send({type: 'shot.create', projectId, title: 'Wan wide', prompt: 'Literal fixture prompt'})).resourceId!;
    await send({type: 'shot.update', projectId, shotId, expectedRevision: 1,
      patch: {controls: {modelId: WAN, durationSeconds: 12, resolution: '4K', aspectRatio: '9:16', generateAudio: false}}});
    const {reviewId} = await send({type: 'generation.prepare', projectId, shotId, expectedRevision: 2});
    const row = (await db.pool.query('SELECT * FROM flume.reviews WHERE id=$1', [reviewId])).rows[0];
    assert.equal(row.envelope, null);
    assert.equal(row.estimated_cost_usd, null);
    assert.deepEqual(row.blockers.map((b: {code: string}) => b.code), ['WAN_ESTIMATE_UNKNOWN']);
    assert.equal(row.snapshot.estimate, undefined, 'no estimate metadata is invented');
    const review = (await service.getWorkspace(actor, projectId)).reviews[0]!;
    assert.deepEqual(review.blockers.map(b => b.code), ['WAN_ESTIMATE_UNKNOWN']);
    assert.equal(review.estimatedCostUsd, null);
    assert.equal(review.estimate, undefined);
    // Attempt-only allowance must still be refused: blockers are checked before allowance.
    await assert.rejects(() => send({type: 'generation.approve', projectId, reviewId, maxAttempts: 1, maxCostUsd: null}),
      (error: Error & {code?: string}) => error.code === 'GENERATION_BLOCKED');
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM flume.attempts')).rows[0].n, 0);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM flume.approvals')).rows[0].n, 0);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM flume.reservations')).rows[0].n, 0);
    assert.equal(f.posts().length, 0, 'no provider POST is ever attempted');
  } finally {await db.close();}
});

test('each refresh re-reads the same exact prior job without submitting or retrying', async t => {
  const f = await fixture(t);
  const bridge = bridgeFor(f, {policy: allowRetention});
  await bridge.discover();
  await bridge.discover();
  assert.deepEqual(f.requests.map(r => [r.method, r.url]), [
    ['GET', '/api/v1/videos/models'], ['GET', `/api/v1/videos/${JOB}`], ['GET', `/api/v1/generation?id=${GENERATION}`],
    ['GET', '/api/v1/videos/models'], ['GET', `/api/v1/videos/${JOB}`], ['GET', `/api/v1/generation?id=${GENERATION}`],
  ]);
  assert.equal(f.posts().length, 0);
});
