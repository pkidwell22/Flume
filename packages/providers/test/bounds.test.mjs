import assert from 'node:assert/strict';
import test from 'node:test';
import * as provider from '../src/index.ts';
import {FAKE_KEY, paired, intent, frames, fixture, jsonResponse, options} from './helpers.mjs';

const compile = () => provider.compileVideoRequest(intent, paired, frames);
const receipt = () => ({provider: 'openrouter', modelId: paired.modelId, jobId: 'fixture-job-1', bodySha256: compile().bodySha256});

test('a response disconnect after the POST is acceptance unknown, with one dispatch', async t => {
  const f = await fixture(t, (_req, _res, req) => req.socket.destroy());
  const result = await provider.createOpenRouterVideoProvider(options(f)).submit(compile());
  assert.equal(result.status, 'acceptance_unknown');
  assert.equal(result.error.code, 'provider_transport_error');
  assert.equal(result.error.retryable, false);
  assert.equal(f.requests.length, 1);
});

test('an injected fetch ignoring AbortSignal still cannot hang the caller', async () => {
  let calls = 0;
  const client = provider.createOpenRouterVideoProvider({getApiKey: () => FAKE_KEY, timeoutMs: 10, fetch: async () => {calls++; return new Promise(() => {});}});
  const result = await client.submit(compile());
  assert.equal(result.status, 'acceptance_unknown');
  assert.equal(result.error.code, 'provider_timeout');
  assert.equal(calls, 1);
});

test('pre-dispatch cancellation and request byte limits make zero HTTP requests', async t => {
  const f = await fixture(t, (_req, res) => jsonResponse(res, 202, {id: 'bad'}));
  const controller = new AbortController(); controller.abort();
  const client = provider.createOpenRouterVideoProvider(options(f));
  assert.equal((await client.submit(compile(), {signal: controller.signal})).status, 'failed');
  const tooLarge = await provider.createOpenRouterVideoProvider(options(f, {maxRequestBytes: 10})).submit(compile());
  assert.equal(tooLarge.error.code, 'request_too_large');
  assert.equal(f.requests.length, 0);
});

test('credential exceptions and invalid credentials are redacted and do not dispatch', async t => {
  const f = await fixture(t, (_req, res) => jsonResponse(res, 202, {id: 'bad'}));
  for (const getApiKey of [() => {throw Error(FAKE_KEY);}, () => `${FAKE_KEY}\nunsafe`, () => '']) {
    const result = await provider.createOpenRouterVideoProvider(options(f, {getApiKey})).submit(compile());
    assert.equal(result.status, 'blocked');
    assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
  }
  assert.equal(f.requests.length, 0);
});

test('invalid JSON under the response size limit remains unknown after POST', async t => {
  const f = await fixture(t, (_req, res) => {res.writeHead(202); res.end('{oops');});
  const result = await provider.createOpenRouterVideoProvider(options(f)).submit(compile());
  assert.equal(result.status, 'acceptance_unknown');
  assert.equal(result.error.code, 'provider_invalid_response');
});

test('chunked byte limits do not depend on content-length', async t => {
  const f = await fixture(t, (_req, res) => {res.writeHead(202); res.write('x'.repeat(40)); res.end('x'.repeat(40));});
  const result = await provider.createOpenRouterVideoProvider(options(f, {maxResponseBytes: 64})).submit(compile());
  assert.equal(result.error.code, 'provider_response_too_large');
});

test('in-flight mutation cannot change the submitted receipt hash or model', async t => {
  const request = structuredClone(compile());
  const originalHash = request.bodySha256;
  const f = await fixture(t, (_req, res) => {
    request.modelId = 'another/model'; request.bodySha256 = '0'.repeat(64);
    jsonResponse(res, 202, {id: 'fixture-job-1'});
  });
  const result = await provider.createOpenRouterVideoProvider(options(f)).submit(request);
  assert.equal(result.receipt.bodySha256, originalHash);
  assert.equal(result.receipt.modelId, paired.modelId);
});

test('invalid job identifiers are rejected literally, not trimmed or repaired', async t => {
  const f = await fixture(t, (_req, res) => jsonResponse(res, 200, {id: 'bad', status: 'pending'}));
  const client = provider.createOpenRouterVideoProvider(options(f));
  for (const jobId of [' fixture-job-1', 'fixture-job-1 ', '../models', 'job?key=1', 'job%2F1', '', null]) {
    const result = await client.status({...receipt(), jobId});
    assert.equal(result.status, 'status_unavailable');
    assert.equal(result.error.code, 'invalid_provider_receipt');
    assert.equal(result.receipt, null);
  }
  assert.equal(f.requests.length, 0);
});

test('poll transport failure preserves a known receipt and permits only a later read', async t => {
  const f = await fixture(t, (_req, _res, req) => req.socket.destroy());
  const result = await provider.createOpenRouterVideoProvider(options(f)).status(receipt());
  assert.equal(result.status, 'status_unavailable');
  assert.equal(result.error.retryable, true);
  assert.equal(result.error.nextAction, 'check_status');
  assert.deepEqual(result.receipt, receipt());
  assert.equal(f.requests[0].method, 'GET');
});

test('catalog null controls stay unconfirmed and duplicate IDs are rejected', () => {
  const model = {id: 'fixture/model', name: 'Fixture', supported_durations: null, supported_resolutions: null, supported_aspect_ratios: null, supported_frame_images: null, seed: null, generate_audio: null};
  const [cap] = provider.readVideoCatalog({data: [model]});
  assert.equal(cap.availability, 'unknown');
  assert.deepEqual(cap.durations, []);
  assert.deepEqual(cap.frameRoles, []);
  assert.equal(cap.seedSupported, false);
  assert.throws(() => provider.readVideoCatalog({data: [model, model]}), {name: 'ProviderValidationError'});
});

test('a privacy rejection can be keyed in metadata without exposing raw payloads', () => {
  const result = provider.normalizeOpenRouterError(404, {error: {metadata: {'zdr-violation-by-account': 1}, message: FAKE_KEY}});
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.excludedEndpointCount, 1);
  assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
});

test('limit configuration rejects unbounded, zero, negative and fractional budgets', () => {
  for (const values of [{timeoutMs: Infinity}, {timeoutMs: 0}, {timeoutMs: 120001}, {maxResponseBytes: -1}, {maxRequestBytes: 1.5}]) {
    assert.throws(() => provider.createOpenRouterVideoProvider({getApiKey: () => FAKE_KEY, fetch: globalThis.fetch, ...values}), RangeError);
  }
});
