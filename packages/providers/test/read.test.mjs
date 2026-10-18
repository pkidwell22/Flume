import assert from 'node:assert/strict';
import test from 'node:test';
import * as provider from '../src/index.ts';
import {FAKE_KEY, paired, intent, frames, fixture, jsonResponse, options} from './helpers.mjs';

const rawModel = {
  id: 'minimax/hailuo-3', name: 'Fixture H3', supported_durations: [5, 6], supported_resolutions: ['2K'],
  supported_aspect_ratios: ['16:9'], supported_frame_images: ['first_frame', 'last_frame'], seed: false, generate_audio: true,
};

test('public catalog discovery uses one unauthenticated GET and never treats metadata as entitlement', async t => {
  const f = await fixture(t, (_req, res) => jsonResponse(res, 200, {data: [rawModel]}));
  let keysRead = 0;
  const client = provider.createOpenRouterVideoProvider(options(f, {getApiKey: () => {keysRead++; return FAKE_KEY;}}));
  assert.equal(typeof client.discoverModels, 'function', 'catalog port must be implemented');
  const result = await client.discoverModels();
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.capabilities, [{
    modelId: 'minimax/hailuo-3', name: 'Fixture H3', durations: [5, 6], resolutions: ['2K'],
    aspectRatios: ['16:9'], frameRoles: ['first_frame', 'last_frame'], seedSupported: false, generateAudioSupported: true,
    availability: 'unknown', blocker: null,
  }]);
  assert.equal(keysRead, 0);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, '/api/v1/videos/models');
  assert.equal(f.requests[0].method, 'GET');
  assert.equal(f.requests[0].headers.authorization, undefined);
});

test('known ZDR requirement projects blocked catalog capabilities without declaring a compatible model', async t => {
  const f = await fixture(t, (_req, res) => jsonResponse(res, 200, {data: [rawModel]}));
  const client = provider.createOpenRouterVideoProvider(options(f, {zdrRequired: true}));
  assert.equal(typeof client.discoverModels, 'function');
  const result = await client.discoverModels();
  assert.equal(result.status, 'ok');
  assert.equal(result.capabilities[0].availability, 'blocked');
  assert.match(result.capabilities[0].blocker, /Zero Data Retention/);
});

test('a model-specific observed ZDR rejection does not claim account-wide video entitlement or denial', async t => {
  const f = await fixture(t, (_req, res) => jsonResponse(res, 200, {data: [rawModel, {...rawModel, id: 'google/veo-3.1', name: 'Fixture Veo'}]}));
  const client = provider.createOpenRouterVideoProvider(options(f, {privacyBlockedModelIds: ['minimax/hailuo-3']}));
  const result = await client.discoverModels();
  assert.equal(result.capabilities[0].availability, 'blocked');
  assert.equal(result.capabilities[1].availability, 'unknown');
  const h3Intent = {...intent, controls: {modelId: 'minimax/hailuo-3', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false}};
  const request = provider.compileVideoRequest(h3Intent, result.capabilities[0], frames);
  const blocked = await client.submit(request);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.error.code, 'provider_privacy_blocked');
  assert.equal(f.requests.length, 1);
  assert.equal('seed' in request.body, false);
});

test('malformed or duplicate catalog entries fail closed instead of returning a plausible partial catalog', async t => {
  const f = await fixture(t, (_req, res) => jsonResponse(res, 200, {data: [rawModel, {...rawModel, supported_durations: ['5']}]}));
  const client = provider.createOpenRouterVideoProvider(options(f));
  assert.equal(typeof client.discoverModels, 'function');
  const result = await client.discoverModels();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.error.code, 'provider_invalid_catalog');
  assert.equal('capabilities' in result, false);
});

function receipt() {
  const request = provider.compileVideoRequest(intent, paired, frames);
  return {provider: 'openrouter', modelId: paired.modelId, jobId: 'fixture-job-1', bodySha256: request.bodySha256};
}
for (const [remoteStatus, localStatus] of [['pending', 'queued'], ['in_progress', 'running'], ['completed', 'retrieving'], ['failed', 'failed'], ['cancelled', 'failed'], ['expired', 'failed']]) {
  test(`one status GET maps ${remoteStatus} to ${localStatus}; provider completion is not owned readiness`, async t => {
    const f = await fixture(t, (_req, res) => jsonResponse(res, 200, {
      id: 'fixture-job-1', model: paired.modelId, status: remoteStatus,
      polling_url: 'https://attacker.example/not-followed',
      unsigned_urls: [`${f.baseUrl}/videos/fixture-job-1/content?index=0`],
      error: `never echo ${FAKE_KEY}`, usage: {cost: 0, is_byok: false},
    }));
    const client = provider.createOpenRouterVideoProvider(options(f));
    assert.equal(typeof client.status, 'function', 'status port must be implemented');
    const result = await client.status(receipt());
    assert.equal(result.status, localStatus);
    assert.deepEqual(result.receipt, receipt());
    assert.equal(result.providerStatus, remoteStatus);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].method, 'GET');
    assert.equal(f.requests[0].url, '/api/v1/videos/fixture-job-1');
    assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
    if (remoteStatus === 'completed') {
      assert.equal(result.costUsd, '0');
      assert.deepEqual(result.outputs, [{kind: 'openrouter_content', jobId: 'fixture-job-1', index: 0}]);
      assert.equal('assetId' in result, false);
    }
  });
}

test('wrong identity, model, future status and missing outputs keep the receipt on hold', async t => {
  let body;
  const f = await fixture(t, (_req, res) => jsonResponse(res, 200, body));
  const client = provider.createOpenRouterVideoProvider(options(f));
  assert.equal(typeof client.status, 'function');
  for (const changed of [
    {id: 'wrong-job', status: 'pending'},
    {id: 'fixture-job-1', model: 'another/model', status: 'pending'},
    {id: 'fixture-job-1', status: 'future-status'},
    {id: 'fixture-job-1', status: 'completed'},
    {id: 'fixture-job-1', status: 'completed', unsigned_urls: ['https://attacker.example/content']},
  ]) {
    body = changed;
    const result = await client.status(receipt());
    assert.equal(result.status, 'status_unavailable');
    assert.deepEqual(result.receipt, receipt());
  }
});

test('status 404 does not erase acceptance or cause a new POST', async t => {
  const f = await fixture(t, (_req, res) => jsonResponse(res, 404, {error: {message: 'Not found'}}));
  const client = provider.createOpenRouterVideoProvider(options(f));
  assert.equal(typeof client.status, 'function');
  const result = await client.status(receipt());
  assert.equal(result.status, 'status_unavailable');
  assert.equal(result.error.code, 'provider_job_unavailable');
  assert.deepEqual(result.receipt, receipt());
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].method, 'GET');
});
