import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import * as provider from '../src/index.ts';
import {FAKE_KEY, paired, intent, frames, fixture, jsonResponse, options} from './helpers.mjs';

const compiled = () => provider.compileVideoRequest(intent, paired, frames);

test('one POST transmits reviewed bytes and returns a receipt without polling', async t => {
  const f = await fixture(t, (_req, res) => jsonResponse(res, 202, {id: 'fixture-job-1', status: 'pending', polling_url: '/api/v1/videos/fixture-job-1'}));
  assert.equal(typeof provider.createOpenRouterVideoProvider, 'function', 'HTTP adapter factory must be implemented');
  const client = provider.createOpenRouterVideoProvider(options(f));
  const request = compiled();
  const result = await client.submit(request);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.receipt, {provider: 'openrouter', modelId: paired.modelId, jobId: 'fixture-job-1', bodySha256: request.bodySha256});
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].method, 'POST');
  assert.equal(f.requests[0].url, '/api/v1/videos');
  assert.equal(f.requests[0].headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(f.requests[0].body, request.bodyJson);
  assert.equal(createHash('sha256').update(f.requests[0].body).digest('hex'), request.bodySha256);
  assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
});

test('H3 account ZDR exclusion becomes a nonretryable privacy blocker, not model-not-found', async t => {
  const f = await fixture(t, (_req, res) => jsonResponse(res, 404, {
    error: {code: 404, message: `upstream echoed ${FAKE_KEY}`, metadata: {
      reasons: [{code: 'zdr-violation-by-account', count: 1}],
    }},
  }));
  const request = compiled();
  const result = await provider.createOpenRouterVideoProvider(options(f)).submit(request);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.code, 'provider_privacy_blocked');
  assert.equal(result.error.providerCode, 'zdr-violation-by-account');
  assert.equal(result.error.excludedEndpointCount, 1);
  assert.equal(result.error.httpStatus, 404);
  assert.equal(result.error.retryable, false);
  assert.equal(result.error.nextAction, 'resolve_privacy_route');
  assert.match(result.error.message, /Zero Data Retention/);
  assert.equal('receipt' in result, false);
  assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
  assert.equal(f.requests.length, 1);
});

test('known ZDR requirement blocks video before credentials or network without a privacy override', async () => {
  let calls = 0;
  const client = provider.createOpenRouterVideoProvider({
    zdrRequired: true,
    getApiKey: () => {calls++; return FAKE_KEY;},
    fetch: async () => {calls++; throw Error('must not dispatch');},
  });
  const result = await client.submit(compiled());
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.code, 'provider_privacy_blocked');
  assert.equal(result.error.retryable, false);
  assert.equal(calls, 0);
  assert.equal('provider' in compiled().body, false);
});

for (const [httpStatus, expectedStatus, code] of [
  [400, 'failed', 'provider_invalid_request'],
  [401, 'blocked', 'provider_authentication_required'],
  [402, 'blocked', 'provider_payment_required'],
  [404, 'blocked', 'provider_unavailable'],
  [429, 'blocked', 'provider_rate_limited'],
  [500, 'acceptance_unknown', 'provider_acceptance_unknown'],
]) {
  test(`HTTP ${httpStatus} is classified without a POST retry or raw error leak`, async t => {
    const f = await fixture(t, (_req, res) => jsonResponse(res, httpStatus, {error: {message: `${FAKE_KEY} private prompt`}}));
    const result = await provider.createOpenRouterVideoProvider(options(f)).submit(compiled());
    assert.equal(result.status, expectedStatus);
    assert.equal(result.error.code, code);
    assert.equal(result.error.retryable, false);
    assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
    assert.equal(f.requests.length, 1);
  });
}

test('mutated envelope or absent credential never reaches HTTP', async t => {
  const f = await fixture(t, (_req, res) => jsonResponse(res, 202, {id: 'should-not-exist'}));
  const client = provider.createOpenRouterVideoProvider(options(f));
  for (const mutate of [r => {r.bodyJson += ' ';}, r => {r.body.model = 'another/model';}, r => {r.modelId = 'another/model';}, r => {r.bodySha256 = '0'.repeat(64);}]) {
    const request = structuredClone(compiled()); mutate(request);
    const result = await client.submit(request);
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'request_integrity_mismatch');
  }
  const missing = await provider.createOpenRouterVideoProvider(options(f, {getApiKey: () => undefined})).submit(compiled());
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.error.code, 'provider_authentication_required');
  assert.equal(f.requests.length, 0);
});

test('factory rejects credential destinations other than OpenRouter or opted-in loopback fixtures', () => {
  for (const baseUrl of ['https://attacker.example/api/v1', 'http://openrouter.ai/api/v1', 'https://openrouter.ai.evil.example/api/v1', 'https://openrouter.ai/api/v1?token=bad', 'http://127.0.0.1:9999/api/v1']) {
    assert.throws(() => provider.createOpenRouterVideoProvider({getApiKey: () => FAKE_KEY, fetch: globalThis.fetch, baseUrl}), /baseUrl/);
  }
});

test('a streaming response is deadline-bounded and leaves acceptance unknown, not resubmitted', async t => {
  const f = await fixture(t, (_req, res) => {res.writeHead(202, {'content-type': 'application/json'}); res.write('{');});
  const operation = provider.createOpenRouterVideoProvider(options(f, {timeoutMs: 25})).submit(compiled()).catch(() => ({status: 'unhandled'}));
  const result = await Promise.race([operation, new Promise(resolve => {const timer = setTimeout(() => resolve({status: 'test-deadline'}), 500); timer.unref();})]);
  assert.equal(result.status, 'acceptance_unknown');
  assert.equal(result.error.code, 'provider_timeout');
  assert.equal(f.requests.length, 1);
});

test('oversized and malformed successful responses are ambiguous, never fake receipts', async t => {
  const f = await fixture(t, (_req, res) => {res.writeHead(202); res.end('x'.repeat(256));});
  const result = await provider.createOpenRouterVideoProvider(options(f, {maxResponseBytes: 32})).submit(compiled());
  assert.equal(result.status, 'acceptance_unknown');
  assert.equal(result.error.code, 'provider_response_too_large');
  assert.equal('receipt' in result, false);
  assert.equal(f.requests.length, 1);
});

test('success without a usable job ID is acceptance unknown', async t => {
  const f = await fixture(t, (_req, res) => jsonResponse(res, 202, {status: 'pending'}));
  const result = await provider.createOpenRouterVideoProvider(options(f)).submit(compiled());
  assert.equal(result.status, 'acceptance_unknown');
  assert.equal(result.error.code, 'provider_invalid_response');
  assert.equal(f.requests.length, 1);
});

test('submit reports a model mismatch while retaining the returned job identity', async t => {
  const f = await fixture(t, (_req, res) => jsonResponse(res, 202, {id: 'fixture-job-1', model: 'another/model', status: 'pending'}));
  const result = await provider.createOpenRouterVideoProvider(options(f)).submit(compiled());
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'provider_model_mismatch');
  assert.equal(result.error.retryable, false);
  assert.equal(result.receipt.jobId, 'fixture-job-1');
  assert.equal(result.receipt.modelId, paired.modelId);
  assert.equal(f.requests.length, 1);
});

test('HTTP redirects are never followed with credentials', async t => {
  const target = await fixture(t, (_req, res) => jsonResponse(res, 202, {id: 'stolen'}));
  const source = await fixture(t, (_req, res) => {res.writeHead(307, {location: `${target.baseUrl}/videos`}); res.end();});
  const result = await provider.createOpenRouterVideoProvider(options(source)).submit(compiled());
  assert.equal(result.status, 'acceptance_unknown');
  assert.equal(source.requests.length, 1);
  assert.equal(target.requests.length, 0);
});
