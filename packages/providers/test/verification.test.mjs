import assert from 'node:assert/strict';
import test from 'node:test';
import {createOpenRouterVideoProvider} from '../src/index.ts';
import {FAKE_KEY, fixture, options} from './helpers.mjs';

// All values are synthetic. Only the owned loopback fixture is contacted.
const REQUESTED = 'alibaba/wan-2.7';
const CANONICAL = 'alibaba/wan-2.7-20260414';
const JOB = 'fixture-wan-job';
const GENERATION = 'fixture-wan-generation';
const catalogModel = {
  id: REQUESTED, name: 'Synthetic Wan 2.7', canonical_slug: CANONICAL,
  supported_durations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
  supported_resolutions: ['720p', '1080p'], supported_aspect_ratios: ['16:9'],
  supported_frame_images: ['first_frame', 'last_frame'], seed: false, generate_audio: false,
  pricing_skus: {duration_seconds: '0.1'},
};
const catalog = {data: [catalogModel]};
const job = {
  id: JOB, generation_id: GENERATION, status: 'completed',
  unsigned_urls: [`https://openrouter.ai/api/v1/videos/${JOB}/content?index=0`],
  urls: [`https://signed.example.invalid/secret?signature=fixture`],
  expires_at: '2030-01-01T00:00:00.000Z', usage: {cost: 0.5},
};
const generation = {
  id: GENERATION, model: CANONICAL, provider: 'AtlasCloud',
  total_cost: 0.5, is_byok: false, cancelled: false,
};

async function serve(t, overrides = {}) {
  const state = {catalog, job, generation, jobStatus: 200, generationStatus: 200, ...overrides};
  const f = await fixture(t, (req, res) => {
    if (req.method === 'GET' && req.url === '/api/v1/videos/models') return json(res, 200, state.catalog);
    if (req.method === 'GET' && req.url === `/api/v1/videos/${JOB}`) return json(res, state.jobStatus, state.job);
    if (req.method === 'GET' && req.url === `/api/v1/generation?id=${GENERATION}`) return json(res, state.generationStatus, {data: state.generation});
    json(res, 404, {error: {message: 'Unexpected fixture path'}});
  });
  return {f, state};
}

function json(res, status, data) {
  res.writeHead(status, {'content-type': 'application/json'});
  res.end(JSON.stringify(data));
}

const provider = (f, extra = {}, key = () => FAKE_KEY) => createOpenRouterVideoProvider({
  ...options(f), getApiKey: key,
  verificationReference: {modelId: REQUESTED, jobId: JOB},
  ...extra,
});

const reads = f => f.requests.filter(r => r.url !== '/api/v1/videos/models');

test('verifies one completed prior job against the exact catalog canonical identity', async t => {
  const {f} = await serve(t);
  const result = await provider(f).discoverModels();
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.verification, {
    status: 'verified', modelId: REQUESTED, jobId: JOB,
    generationId: GENERATION, canonicalModelId: CANONICAL,
  });
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.requests.map(r => [r.method, r.url, r.headers.authorization ?? null]), [
    ['GET', '/api/v1/videos/models', null],
    ['GET', `/api/v1/videos/${JOB}`, `Bearer ${FAKE_KEY}`],
    ['GET', `/api/v1/generation?id=${GENERATION}`, `Bearer ${FAKE_KEY}`],
  ]);
  assert.equal(f.requests.some(r => r.method === 'POST'), false, 'verification must never submit');
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('signed.example.invalid'), false, 'signed URLs are never retained');
  assert.equal(serialized.includes('signature'), false);
});

test('does not verify when no reference is configured and performs no authenticated reads', async t => {
  const {f} = await serve(t);
  const result = await createOpenRouterVideoProvider(options(f)).discoverModels();
  assert.equal(result.status, 'ok');
  assert.equal(Object.hasOwn(result, 'verification'), false);
  assert.deepEqual(reads(f), []);
});

test('rejects malformed references without dispatching any authenticated read', async t => {
  const {f} = await serve(t);
  for (const value of [
    null, {}, [], 'alibaba/wan-2.7', {modelId: REQUESTED}, {jobId: JOB},
    {modelId: REQUESTED, jobId: JOB, extra: 'x'},
    {modelId: ' alibaba/wan-2.7', jobId: JOB},
    {modelId: REQUESTED, jobId: ''},
    {modelId: REQUESTED, jobId: 'job id with spaces'},
    {modelId: 7, jobId: JOB},
  ]) {
    const result = await createOpenRouterVideoProvider({...options(f), verificationReference: value}).discoverModels();
    assert.equal(result.status, 'ok');
    assert.equal(result.verification?.status, 'unverified');
    assert.equal(result.verification?.reason, 'invalid_reference');
    assert.deepEqual(reads(f), []);
  }
});

test('missing credentials cannot verify and never dispatches job or generation reads', async t => {
  const {f} = await serve(t);
  const result = await provider(f, {getApiKey: () => undefined}).discoverModels();
  assert.equal(result.status, 'ok');
  assert.equal(result.verification?.status, 'unverified');
  assert.equal(result.verification?.reason, 'credentials_missing');
  assert.deepEqual(reads(f), []);
});

test('privacy holds take precedence over prior-job evidence', async t => {
  const {f} = await serve(t);
  for (const extra of [
    {privacyBlockedModelIds: [REQUESTED]},
    {zdrRequired: true},
  ]) {
    const result = await provider(f, extra).discoverModels();
    assert.equal(result.status, 'ok');
    assert.equal(result.verification?.status, 'unverified');
    assert.equal(result.verification?.reason, 'privacy_blocked');
    assert.deepEqual(reads(f), []);
  }
});

test('a model absent from the catalog or without a canonical slug cannot be verified', async t => {
  for (const [payload, reason] of [
    [{data: [{...catalogModel, id: 'alibaba/wan-2.6'}]}, 'model_not_catalogued'],
    [{data: [{...catalogModel, canonical_slug: undefined}]}, 'canonical_identity_missing'],
    [{data: [{...catalogModel, canonical_slug: ' not-a-model'}]}, 'canonical_identity_missing'],
  ]) {
    const {f} = await serve(t, {catalog: payload});
    const result = await provider(f).discoverModels();
    assert.equal(result.status, 'ok');
    assert.equal(result.verification?.reason, reason);
    assert.deepEqual(reads(f), []);
  }
});

test('a canonical identity shared by multiple catalog aliases cannot verify either alias', async t => {
  const {f} = await serve(t, {catalog: {data: [
    catalogModel,
    {...catalogModel, id: 'alibaba/wan-2.7-alias', name: 'Synthetic Wan alias'},
  ]}});
  const result = await provider(f).discoverModels();
  assert.equal(result.status, 'ok');
  assert.equal(result.verification?.status, 'unverified');
  assert.equal(result.verification?.reason, 'canonical_identity_ambiguous');
  assert.deepEqual(reads(f), [], 'ambiguity is refused before any authenticated read');
});

test('mismatched or foreign job metadata remains unverified', async t => {
  for (const [patch, status, reason] of [
    [{id: 'another-job'}, 200, 'job_identity_mismatch'],
    [{status: 'pending'}, 200, 'job_not_completed'],
    [{status: 'failed'}, 200, 'job_not_completed'],
    [{generation_id: undefined}, 200, 'generation_identity_mismatch'],
    [{generation_id: 'bad id'}, 200, 'generation_identity_mismatch'],
    [{}, 404, 'job_unavailable'],
    [{}, 500, 'job_unavailable'],
  ]) {
    const {f} = await serve(t, {job: {...job, ...patch}, jobStatus: status});
    const result = await provider(f).discoverModels();
    assert.equal(result.verification?.status, 'unverified', JSON.stringify(patch));
    assert.equal(result.verification?.reason, reason, JSON.stringify(patch));
    assert.equal(f.requests.some(r => r.method === 'POST'), false);
    if (reason !== 'generation_identity_mismatch') {
      assert.equal(f.requests.some(r => String(r.url).startsWith('/api/v1/generation')), false);
    }
  }
});

test('generation identity and canonical model must match exactly, including suffixes', async t => {
  for (const [patch, status, reason] of [
    [{id: 'another-generation'}, 200, 'generation_identity_mismatch'],
    [{id: undefined}, 200, 'generation_identity_mismatch'],
    [{model: 'alibaba/wan-2.7'}, 200, 'canonical_model_mismatch'],
    [{model: 'alibaba/wan-2.7-20260415'}, 200, 'canonical_model_mismatch'],
    [{model: CANONICAL.toUpperCase()}, 200, 'canonical_model_mismatch'],
    [{cancelled: true}, 200, 'generation_not_successful'],
    [{}, 404, 'generation_unavailable'],
    [{}, 401, 'generation_unavailable'],
  ]) {
    const {f} = await serve(t, {generation: {...generation, ...patch}, generationStatus: status});
    const result = await provider(f).discoverModels();
    assert.equal(result.verification?.status, 'unverified', JSON.stringify(patch));
    assert.equal(result.verification?.reason, reason, JSON.stringify(patch));
    assert.equal(f.requests.some(r => r.method === 'POST'), false);
  }
});
