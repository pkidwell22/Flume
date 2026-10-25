import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import * as image from '../src/image-generation.ts';
import {createOpenRouterImageProvider} from '../src/image-generation-openrouter.ts';

// Controlled transport fixture: no network, no live provider, no credentials.
const FAKE_KEY = 'fixture-only-not-a-real-key';

export function pngBytes(width = 64, height = 32) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(21);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; ihdr[17] = 6; ihdr[18] = 0; ihdr[19] = 0; ihdr[20] = 0;
  return new Uint8Array(Buffer.concat([header, ihdr]));
}
const sha = value => createHash('sha256').update(value).digest('hex');
const reference = (bytes = pngBytes()) => ({
  assetId: '00000007-0000-4000-8000-000000000007', sha256: sha(bytes), mimeType: 'image/png', bytes,
});
const intent = () => ({
  prompt: '  keep literal café 🟠 spacing\nand newline  ',
  modelId: 'google/gemini-2.5-flash-image', aspectRatio: '16:9', reference: reference(),
});
const capabilities = () => [{
  modelId: 'google/gemini-2.5-flash-image', name: 'Gemini image (fixture)',
  aspectRatios: ['1:1', '16:9', '9:16'], availability: 'available', blocker: null,
}];

export function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({url, options});
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch');
    if (next instanceof Error) throw next;
    const status = next.status ?? 200;
    const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return new Response(body, {status, headers: {'content-type': 'application/json'}});
  };
  return {fetch, calls};
}
const provider = (fetch, extra = {}) => createOpenRouterImageProvider({
  fetch, getApiKey: () => FAKE_KEY, maxResponseBytes: 1024 * 1024,
  models: capabilities(), ...extra,
});
const dataUrl = bytes => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
const accepted = (bytes, extra = {}) => ({
  status: 200,
  body: {
    id: 'gen-fixture-1', model: 'google/gemini-2.5-flash-image',
    choices: [{message: {images: [{type: 'image_url', image_url: {url: dataUrl(bytes)}}]}}],
    usage: {cost: 0.039}, ...extra,
  },
});

test('compile builds one deterministic reference-conditioned request with hashed bytes', () => {
  assert.equal(typeof image.compileImageRequest, 'function', 'compileImageRequest must be implemented');
  const compiled = image.compileImageRequest(intent());
  assert.equal(compiled.provider, 'openrouter');
  assert.equal(compiled.modelId, 'google/gemini-2.5-flash-image');
  assert.equal(compiled.bodyJson, JSON.stringify(compiled.body));
  assert.equal(compiled.bodySha256, sha(compiled.bodyJson));
  assert.deepEqual(compiled.body, {
    model: 'google/gemini-2.5-flash-image',
    messages: [{role: 'user', content: [
      {type: 'text', text: intent().prompt},
      {type: 'image_url', image_url: {url: dataUrl(pngBytes())}},
    ]}],
    modalities: ['image', 'text'],
    image_config: {aspect_ratio: '16:9'},
  });
  assert.deepEqual(image.compileImageRequest(intent()), compiled);
  assert.ok(Object.isFrozen(compiled.body.messages[0].content[1].image_url));
});

test('compile rejects arbitrary locations, wrong mime, hash mismatch and oversized references', () => {
  const bad = [
    {url: 'https://example.com/frame.png'},
    {url: 'file:///private/frame.png'},
    {url: 'data:text/html;base64,AQID'},
    {bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png'},
    {...reference(), sha256: 'b'.repeat(64)},
    {...reference(), mimeType: 'image/gif'},
    {...reference(), bytes: new Uint8Array(0)},
    {...reference(), bytes: new Uint8Array(image.MAX_IMAGE_REFERENCE_BYTES + 1)},
  ];
  for (const reference of bad) {
    assert.throws(() => image.compileImageRequest({...intent(), reference}), {name: 'ImageValidationError'}, JSON.stringify(reference).slice(0, 80));
  }
  for (const change of [
    {prompt: ''}, {prompt: '   '}, {prompt: 'x'.repeat(8001)}, {modelId: ' gemini'},
    {modelId: 'google/gemini image'}, {aspectRatio: '16x9'}, {aspectRatio: '16:9 '},
    {unexpected: true}, {...intent(), reference: {...reference(), unexpected: 'x'}},
  ]) assert.throws(() => image.compileImageRequest({...intent(), ...change}), {name: 'ImageValidationError'});
  // A reference is optional; absence is explicit null, never an invented image.
  const textOnly = image.compileImageRequest({...intent(), reference: null});
  assert.equal(textOnly.body.messages[0].content.length, 1);
});

test('image byte inspection validates magic, mime, dimensions and hash without trusting callers', () => {
  const png = pngBytes(120, 80);
  const inspected = image.inspectImageBytes(png, 'image/png');
  assert.equal(inspected.width, 120);
  assert.equal(inspected.height, 80);
  assert.equal(inspected.byteSize, png.length);
  assert.equal(inspected.sha256, sha(png));
  assert.throws(() => image.inspectImageBytes(png, 'image/jpeg'), {name: 'ImageValidationError'});
  assert.throws(() => image.inspectImageBytes(new Uint8Array([0x89, 0x50, 0x4e])), {name: 'ImageValidationError'});
  const huge = new Uint8Array(image.MAX_IMAGE_RESULT_BYTES + 1);
  assert.throws(() => image.inspectImageBytes(huge, 'image/png'), {name: 'ImageValidationError'});
  assert.throws(() => image.inspectImageBytes(new Uint8Array(0), 'image/png'), {name: 'ImageValidationError'});
});

test('prepare reports explicit capability blockers and unknown estimates as null', async () => {
  const {fetch, calls} = fakeFetch([]);
  const adapter = provider(fetch);
  const prepared = await adapter.prepare(intent());
  assert.equal(calls.length, 0, 'prepare must not submit or upload');
  assert.ok(prepared.envelope);
  assert.equal(prepared.envelope.bodySha256, prepared.requestHash);
  assert.equal(prepared.estimateUsd, null);
  assert.deepEqual(prepared.blockers, []);

  const unavailable = await provider(fetch, {models: []}).prepare(intent());
  assert.equal(unavailable.envelope, null);
  assert.deepEqual(unavailable.blockers.map(b => b.code), ['model_unavailable']);
  assert.equal(unavailable.estimateUsd, null);

  const blocked = await provider(fetch, {models: [{...capabilities()[0], availability: 'blocked', blocker: 'Account policy'}]}).prepare(intent());
  assert.deepEqual(blocked.blockers.map(b => b.code), ['provider_blocked']);
  assert.equal(blocked.envelope, null);

  const unknown = await provider(fetch, {models: [{...capabilities()[0], availability: 'unknown'}]}).prepare(intent());
  assert.deepEqual(unknown.blockers.map(b => b.code), ['model_availability_unknown']);

  const ratio = await provider(fetch, {models: [{...capabilities()[0], aspectRatios: ['1:1']}]}).prepare(intent());
  assert.deepEqual(ratio.blockers.map(b => b.code), ['unsupported_aspect_ratio']);

  const estimated = await provider(fetch, {estimateUsd: () => '0.040000'}).prepare(intent());
  assert.equal(estimated.estimateUsd, '0.040000');
  const badEstimate = await provider(fetch, {estimateUsd: () => 'free'}).prepare(intent());
  assert.equal(badEstimate.estimateUsd, null);
});

test('submit performs exactly one authenticated request and returns inspected image bytes', async () => {
  const bytes = pngBytes(96, 54);
  const {fetch, calls} = fakeFetch([accepted(bytes)]);
  const adapter = provider(fetch);
  const prepared = await adapter.prepare(intent());
  const result = await adapter.submit(prepared.envelope);
  assert.equal(result.status, 'accepted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(calls[0].options.body, prepared.envelope.body);
  assert.equal(result.receipt.providerModelId, 'google/gemini-2.5-flash-image');
  assert.equal(result.receipt.providerReceiptId, 'gen-fixture-1');
  assert.equal(result.receipt.costUsd, '0.039');
  assert.equal(result.image.mimeType, 'image/png');
  assert.equal(result.image.width, 96);
  assert.equal(result.image.height, 54);
  assert.equal(result.image.sha256, sha(bytes));
  assert.deepEqual(Buffer.from(result.image.bytes), Buffer.from(bytes));
});

test('transport failure after dispatch is unknown acceptance; no retry and no fabricated receipt', async () => {
  const {fetch, calls} = fakeFetch([new Error('socket hang up')]);
  const adapter = provider(fetch);
  const prepared = await adapter.prepare(intent());
  const result = await adapter.submit(prepared.envelope);
  assert.equal(result.status, 'acceptance_unknown');
  assert.equal(calls.length, 1);
  assert.equal(result.receipt, undefined);
  assert.match(result.error.message, /do not (automatically )?(submit|resubmit)/i);
  assert.ok(!JSON.stringify(result.error).includes('socket hang up'));
  assert.ok(!JSON.stringify(result.error).includes(FAKE_KEY));
});

test('HTTP failures map to safe blocked/failed/unknown codes without provider text or retries', async () => {
  const cases = [
    [400, 'failed', 'provider_invalid_request'],
    [401, 'blocked', 'provider_authentication_required'],
    [402, 'blocked', 'provider_payment_required'],
    [403, 'blocked', 'provider_access_denied'],
    [404, 'blocked', 'provider_unavailable'],
    [413, 'failed', 'provider_request_too_large'],
    [429, 'blocked', 'provider_rate_limited'],
    [500, 'acceptance_unknown', 'provider_acceptance_unknown'],
    [503, 'acceptance_unknown', 'provider_acceptance_unknown'],
  ];
  for (const [status, expected, code] of cases) {
    const {fetch, calls} = fakeFetch([{status, body: {error: {message: `raw provider detail ${FAKE_KEY}`}}}]);
    const adapter = provider(fetch);
    const prepared = await adapter.prepare(intent());
    const result = await adapter.submit(prepared.envelope);
    assert.equal(result.status, expected, String(status));
    assert.equal(result.error.code, code, String(status));
    assert.equal(result.error.httpStatus, status);
    assert.equal(calls.length, 1, `no retry for ${status}`);
    assert.ok(!JSON.stringify(result.error).includes(FAKE_KEY));
    assert.ok(!JSON.stringify(result.error).includes('raw provider detail'));
  }
});

test('malformed, ambiguous, oversized or non-image payloads never become accepted results', async () => {
  const bytes = pngBytes();
  const cases = [
    {status: 200, body: {id: 'gen-1', choices: []}},
    {status: 200, body: {id: 'gen-1', choices: [{message: {images: []}}]}},
    {status: 200, body: {id: 'gen-1', choices: [{message: {images: [1, 2].map(() => ({type: 'image_url', image_url: {url: dataUrl(bytes)}}))}}]}},
    {status: 200, body: {id: 'gen-1', choices: [{message: {images: [{type: 'image_url', image_url: {url: 'https://example.com/out.png'}}]}}]}},
    {status: 200, body: {id: 'gen-1', choices: [{message: {images: [{type: 'image_url', image_url: {url: 'data:image/png;base64,%%%%'}}]}}]}},
    {status: 200, body: {id: 'gen-1', choices: [{message: {images: [{type: 'image_url', image_url: {url: `data:image/png;base64,${Buffer.from(new Uint8Array(image.MAX_IMAGE_RESULT_BYTES + 1)).toString('base64')}`}}]}}]}},
    {status: 200, body: 'not json'},
  ];
  for (const response of cases) {
    const {fetch, calls} = fakeFetch([response]);
    const adapter = provider(fetch);
    const prepared = await adapter.prepare(intent());
    const result = await adapter.submit(prepared.envelope);
    assert.notEqual(result.status, 'accepted', JSON.stringify(response).slice(0, 90));
    assert.ok(['failed', 'acceptance_unknown', 'blocked'].includes(result.status));
    assert.equal(calls.length, 1);
    if (result.error.code === 'provider_invalid_response') assert.equal(result.status, 'acceptance_unknown');
  }
});

test('missing credentials and tampered envelopes never dispatch', async () => {
  const noKey = createOpenRouterImageProvider({fetch: fakeFetch([]).fetch, getApiKey: () => undefined, models: capabilities()});
  const prepared = await noKey.prepare(intent());
  const keyless = await noKey.submit(prepared.envelope);
  assert.equal(keyless.status, 'blocked');
  assert.equal(keyless.error.code, 'provider_authentication_required');

  const {fetch, calls} = fakeFetch([]);
  const adapter = provider(fetch);
  const envelope = (await adapter.prepare(intent())).envelope;
  for (const tampered of [
    {...envelope, bodySha256: 'b'.repeat(64)},
    {...envelope, body: envelope.body.replace('16:9', '9:16')},
    {...envelope, bodySha256: envelope.bodySha256.toUpperCase()},
    {...envelope, provider: 'other'},
  ]) {
    const result = await adapter.submit(tampered);
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'request_integrity_mismatch');
  }
  assert.equal(calls.length, 0);
});

test('only loopback fixtures may override the official base URL', () => {
  assert.throws(() => createOpenRouterImageProvider({fetch: async () => new Response(''), getApiKey: () => FAKE_KEY, baseUrl: 'https://evil.example/api/v1', models: capabilities()}), TypeError);
  assert.throws(() => createOpenRouterImageProvider({fetch: async () => new Response(''), getApiKey: () => FAKE_KEY, baseUrl: 'http://127.0.0.1:1234/api/v1', models: capabilities()}), TypeError);
  assert.ok(createOpenRouterImageProvider({fetch: async () => new Response(''), getApiKey: () => FAKE_KEY, baseUrl: 'http://127.0.0.1:1234/api/v1', allowLoopbackHttpForTests: true, models: capabilities()}));
});
