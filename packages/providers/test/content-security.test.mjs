import assert from 'node:assert/strict';
import test from 'node:test';
import {getEventListeners} from 'node:events';
import {createOpenRouterVideoProvider} from '../src/index.ts';
import {FAKE_KEY, fixture, options} from './helpers.mjs';

const receipt = () => ({provider: 'openrouter', modelId: 'fixture/model', jobId: 'Fixture-Job-1', bodySha256: 'a'.repeat(64)});
const output = () => ({kind: 'openrouter_content', jobId: receipt().jobId, index: 0});
async function collect({body}) {for await (const _chunk of body) { /* consume the complete stream */ }}

for (const status of [301, 302, 303, 307, 308]) {
  test(`content never follows HTTP ${status} to another numeric-loopback host`, async t => {
    const media = await fixture(t, (_req, res) => {res.writeHead(200, {'content-type': 'video/mp4'}); res.end('never fetch this');});
    const f = await fixture(t, (_req, res) => {res.writeHead(status, {location: `${media.baseUrl}/private.mp4?secret=signed-fixture`}); res.end(FAKE_KEY);});
    const result = await createOpenRouterVideoProvider(options(f)).readContent(receipt(), output(), collect);
    assert.equal(result.status, 'content_unavailable');
    assert.deepEqual(result.receipt, receipt());
    assert.deepEqual(result.output, output());
    assert.equal(f.requests.length, 1);
    assert.equal(media.requests.length, 0, 'no request, with or without credentials, may reach the redirect host');
    assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
    assert.equal(JSON.stringify(result).includes('signed-fixture'), false);
  });
}

test('content never follows same-origin redirects to a different job', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url.includes('/Other-Job/')) {res.writeHead(200, {'content-type': 'video/mp4'}); res.end('wrong job');}
    else {res.writeHead(307, {location: '/api/v1/videos/Other-Job/content?index=0'}); res.end();}
  });
  const result = await createOpenRouterVideoProvider(options(f)).readContent(receipt(), output(), collect);
  assert.equal(result.status, 'content_unavailable');
  assert.equal(f.requests.length, 1);
});

test('invalid, URL-bearing or wrong-job descriptors cannot trigger credential lookup or HTTP', async t => {
  const f = await fixture(t, (_req, res) => {res.writeHead(200, {'content-type': 'video/mp4'}); res.end('wrong');});
  let credentials = 0;
  const client = createOpenRouterVideoProvider(options(f, {getApiKey: () => {credentials++; return FAKE_KEY;}}));
  for (const candidate of [
    null, 'https://example.invalid/content', {...output(), url: 'https://example.invalid/content'},
    {...output(), jobId: 'Other-Job'}, {...output(), jobId: ' Fixture-Job-1'}, {...output(), jobId: 'fixture-job-1'},
    {...output(), kind: 'url'}, ...[-1, -0, 8, 1.5, Infinity, '0'].map(index => ({...output(), index})),
  ]) {
    const result = await client.readContent(receipt(), candidate, collect);
    assert.equal(result.status, 'content_unavailable');
    assert.equal(result.error.code, 'invalid_provider_output');
  }
  for (const jobId of ['../models', 'job%2f2', 'job?x=1', 'Fixture-Job-1 ', ' Fixture-Job-1', '', null]) {
    const result = await client.readContent({...receipt(), jobId}, output(), collect);
    assert.equal(result.error.code, 'invalid_provider_receipt');
  }
  assert.equal(credentials, 0);
  assert.equal(f.requests.length, 0);
});

test('pre-abort and missing credentials do not dispatch or expose credential errors', async t => {
  const f = await fixture(t, (_req, res) => res.end('wrong'));
  const controller = new AbortController(); controller.abort(FAKE_KEY);
  let credentials = 0;
  const result = await createOpenRouterVideoProvider(options(f, {getApiKey: () => {credentials++; return FAKE_KEY;}})).readContent(receipt(), output(), collect, {signal: controller.signal});
  assert.equal(result.error.code, 'provider_aborted');
  assert.equal(credentials, 0);
  for (const getApiKey of [() => undefined, () => '', () => `${FAKE_KEY}\n`, () => {throw new Error(FAKE_KEY);}]) {
    const result = await createOpenRouterVideoProvider(options(f, {getApiKey})).readContent(receipt(), output(), collect);
    assert.equal(result.error.code, 'provider_authentication_required');
    assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
  }
  assert.equal(f.requests.length, 0);
});

for (const status of [206, 401, 403, 404, 429, 500]) {
  test(`HTTP ${status} content failure retains identity, redacts raw bodies and never retries`, async t => {
    const f = await fixture(t, (_req, res) => {res.writeHead(status, {'content-type': 'video/mp4'}); res.end(FAKE_KEY);});
    let consumed = false;
    const result = await createOpenRouterVideoProvider(options(f)).readContent(receipt(), output(), async () => {consumed = true;});
    assert.equal(result.status, 'content_unavailable');
    assert.equal(result.error.httpStatus, status);
    assert.deepEqual(result.receipt, receipt());
    assert.deepEqual(result.output, output());
    assert.equal(consumed, false);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].method, 'GET');
    assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
  });
}

test('content freezes identities and releases the original abort listener despite mutable call options', async t => {
  const controller = new AbortController();
  const call = {signal: controller.signal};
  const accepted = receipt(), descriptor = output();
  let seenResponse, seenInit;
  const f = await fixture(t, (_req, res) => {
    accepted.jobId = 'Other-Job'; descriptor.index = 7; call.signal = new AbortController().signal;
    res.writeHead(200, {'content-type': 'video/mp4'}); res.end('complete');
  });
  const client = createOpenRouterVideoProvider(options(f, {fetch: async (url, init) => {
    seenInit = init; seenResponse = await fetch(url, init); return seenResponse;
  }}));
  const result = await client.readContent(accepted, descriptor, collect, call);
  assert.equal(result.status, 'read');
  assert.deepEqual(result.receipt, receipt()); assert.deepEqual(result.output, output());
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(seenResponse.body.locked, false);
  assert.equal(seenInit.signal.aborted, true);
  assert.equal(seenInit.redirect, 'manual'); assert.equal(seenInit.credentials, 'omit'); assert.equal(seenInit.cache, 'no-store');
});

test('stream failures cannot leak a raw fetch error even to the media consumer', async t => {
  const f = await fixture(t, (_req, res) => {res.writeHead(200, {'content-type': 'video/mp4'}); res.end('complete');});
  const client = createOpenRouterVideoProvider(options(f, {fetch: async (url, init) => {
    const response = await fetch(url, init); await response.body.cancel();
    return new Response(new ReadableStream({pull(controller) {controller.error(new Error(FAKE_KEY));}}), {headers: {'content-type': 'video/mp4'}});
  }}));
  let observed;
  const result = await client.readContent(receipt(), output(), async content => {
    try {await collect(content);} catch (error) {observed = error; throw error;}
  });
  assert.equal(result.status, 'content_unavailable');
  assert.equal(String(observed).includes(FAKE_KEY), false);
});

test('truncated streams fail closed instead of returning a partial successful value', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, {'content-type': 'video/mp4', 'content-length': '100'}); res.write('partial');
    const timer = setTimeout(() => res.destroy(), 10);
    res.once('close', () => clearTimeout(timer));
  });
  let released = false;
  const result = await createOpenRouterVideoProvider(options(f)).readContent(receipt(), output(), async content => {
    try {await collect(content); return 'must not escape';} finally {released = true;}
  });
  assert.equal(result.status, 'content_unavailable');
  assert.equal(result.error.code, 'provider_content_read_error');
  assert.equal('value' in result, false);
  assert.equal(released, true);
});

test('native fetch uses identity encoding and media consumption cannot outlive the network scope', async t => {
  const f = await fixture(t, (_req, res) => {res.writeHead(200, {'content-type': 'Video/MP4; fixture=1'}); res.end('ok');});
  let escaped;
  const result = await createOpenRouterVideoProvider(options(f)).readContent(receipt(), output(), async ({body}) => {escaped = body;});
  assert.equal(result.error.code, 'provider_content_incomplete');
  await assert.rejects(escaped[Symbol.asyncIterator]().next(), {message: 'provider_content_closed'});
  assert.equal(f.requests[0].headers['accept-encoding'], 'identity');
});

test('declared length must agree with streamed bytes even through an injected response adapter', async t => {
  const f = await fixture(t, (_req, res) => {res.writeHead(200, {'content-type': 'video/mp4'}); res.end('four');});
  const client = createOpenRouterVideoProvider(options(f, {fetch: async (url, init) => {
    const response = await fetch(url, init);
    return new Response(response.body, {headers: {'content-type': 'video/mp4', 'content-length': '5'}});
  }}));
  const result = await client.readContent(receipt(), output(), collect);
  assert.equal(result.status, 'content_unavailable');
  assert.equal(result.error.code, 'provider_content_length_invalid');
});

test('invalid consumers fail before credentials and dispatch', async t => {
  const f = await fixture(t, (_req, res) => {res.writeHead(200, {'content-type': 'video/mp4'}); res.end('ok');});
  let credentials = 0;
  const result = await createOpenRouterVideoProvider(options(f, {getApiKey: () => {credentials++; return FAKE_KEY;}})).readContent(receipt(), output(), undefined);
  assert.equal(result.status, 'content_unavailable');
  assert.equal(result.error.code, 'invalid_content_consumer');
  assert.equal(credentials, 0);
  assert.equal(f.requests.length, 0);
});

test('content budget hard ceilings reject nonfinite, zero and fractional configuration', () => {
  for (const [field, values] of [['maxContentBytes', [0, -1, 1.1, Infinity, 512 * 1024 * 1024 + 1]], ['contentTimeoutMs', [0, -1, 0.5, Infinity, 120001]]]) {
    for (const value of values) assert.throws(() => createOpenRouterVideoProvider({fetch, getApiKey: () => FAKE_KEY, [field]: value}), RangeError);
  }
});
