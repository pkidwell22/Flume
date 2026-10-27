// Opt-in native OpenRouter Image API transport (POST /api/v1/images).
// Controlled fixtures only: synthetic fetch, synthetic bytes, no network, no credentials, no spend.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import * as image from '../src/image-generation.ts';
import {createOpenRouterImageProvider} from '../src/image-generation-openrouter.ts';

const FAKE_KEY = 'fixture-only-not-a-real-key';
const MODEL = 'bytedance-seed/seedream-4.5';
const PROMPT = '  keep literal café 🟠 spacing\nand newline  ';

function pngBytes(width = 64, height = 32) {
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
const intent = () => ({prompt: PROMPT, modelId: MODEL, aspectRatio: '16:9', reference: reference()});
const capabilities = () => [{
  modelId: MODEL, name: 'Seedream (fixture)', aspectRatios: ['1:1', '16:9', '9:16'],
  availability: 'available', blocker: null,
}];
const dataUrl = bytes => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
const b64 = bytes => Buffer.from(bytes).toString('base64');

function fakeFetch(responses) {
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
  fetch, getApiKey: () => FAKE_KEY, maxResponseBytes: 8 * 1024 * 1024, models: capabilities(), ...extra,
});
const nativeAccepted = (bytes, extra = {}) => ({
  status: 200,
  body: {created: 1748372400, data: [{b64_json: b64(bytes), media_type: 'image/png'}], usage: {cost: 0.04}, ...extra},
});
const resign = (body, modelId = body.model) => {
  const bodyJson = JSON.stringify(body);
  return {provider: 'openrouter', modelId, body: bodyJson, bodySha256: sha(bodyJson)};
};

test('frozen request references require the compiled input shape before any dispatch', async () => {
  for (const mutate of [part => { delete part.type; }, part => { delete part.type; part.detail = 'unexpected'; }]) {
    const body = JSON.parse(image.compileImageRequest(intent()).bodyJson);
    mutate(body.messages[0].content[1]);
    const {fetch, calls} = fakeFetch([]);
    const result = await provider(fetch, {transport: 'images'}).submit(resign(body));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'request_shape_invalid');
    assert.equal(calls.length, 0, 'a response may omit type, but a compiled request may not');
  }
});

test('frozen inline references must retain valid bounded image bytes', async () => {
  for (const native of [false, true]) {
    const body = JSON.parse((native ? image.compileNativeImageRequest(intent()) : image.compileImageRequest(intent())).bodyJson);
    const part = native ? body.input_references[0] : body.messages[0].content[1];
    part.image_url.url = 'data:image/png;base64,bm90LWltYWdlLWJ5dGVz';
    const {fetch, calls} = fakeFetch([]);
    const result = await provider(fetch).submit(resign(body));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'request_shape_invalid');
    assert.equal(calls.length, 0);
  }
});

test('native PNG requests reject JPEG or WebP results even without MIME metadata', async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 1, 0x11, 0]);
  const webp = Buffer.alloc(30); webp.write('RIFF', 0); webp.write('WEBP', 8); webp.write('VP8X', 12);
  webp.writeUIntLE(15, 24, 3); webp.writeUIntLE(15, 27, 3);
  for (const [bytes, mime] of [[jpeg, 'image/jpeg'], [webp, 'image/webp']]) {
    assert.equal(image.inspectImageBytes(bytes).mimeType, mime, 'fixture passes existing magic inspection');
    for (const includeMime of [true, false]) {
      const item = {b64_json: b64(bytes), ...(includeMime ? {media_type: mime} : {})};
      const {fetch, calls} = fakeFetch([{body: {created: 1, data: [item]}}]);
      const adapter = provider(fetch, {transport: 'images'});
      const prepared = await adapter.prepare(intent());
      assert.equal(JSON.parse(prepared.envelope.body).output_format, 'png');
      const result = await adapter.submit(prepared.envelope);
      assert.equal(result.status, 'failed');
      assert.equal(result.error.code, 'provider_output_invalid');
      assert.equal(calls.length, 1, 'format mismatch must not retry');
    }
  }
});

test('native compile freezes the documented body with n:1 and owned reference bytes', () => {
  assert.equal(typeof image.compileNativeImageRequest, 'function', 'compileNativeImageRequest must be implemented');
  const bytes = pngBytes(120, 80);
  const compiled = image.compileNativeImageRequest({...intent(), reference: reference(bytes)});
  assert.equal(compiled.provider, 'openrouter');
  assert.equal(compiled.modelId, MODEL);
  assert.equal(compiled.bodyJson, JSON.stringify(compiled.body));
  assert.equal(compiled.bodySha256, sha(compiled.bodyJson));
  assert.deepEqual(compiled.body, {
    model: MODEL,
    prompt: PROMPT,
    aspect_ratio: '16:9',
    n: 1,
    output_format: 'png',
    input_references: [{type: 'image_url', image_url: {url: dataUrl(bytes)}}],
  });
  assert.deepEqual(image.compileNativeImageRequest({...intent(), reference: reference(bytes)}), compiled, 'compile is deterministic');
  for (const frozen of [compiled.body, compiled.body.input_references, compiled.body.input_references[0], compiled.body.input_references[0].image_url]) {
    assert.ok(Object.isFrozen(frozen), 'compiled body is deeply frozen');
  }
  const url = compiled.body.input_references[0].image_url.url;
  assert.deepEqual(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'), Buffer.from(bytes), 'reference bytes are preserved exactly');
  for (const key of ['quality', 'resolution', 'size', 'stream', 'provider', 'background', 'seed', 'messages', 'modalities', 'image_config', 'output_compression', 'user']) {
    assert.equal(key in compiled.body, false, `no passthrough field ${key}`);
  }
  const textOnly = image.compileNativeImageRequest({...intent(), reference: null});
  assert.equal('input_references' in textOnly.body, false, 'an absent reference is omitted, never invented');
  assert.equal(textOnly.body.prompt, PROMPT);
  assert.equal(textOnly.body.n, 1);
});

test('native compile rejects the same invalid intents as the chat compile', () => {
  for (const change of [{prompt: ''}, {prompt: '   '}, {aspectRatio: '16x9'}, {modelId: 'gemini'}, {unexpected: true},
    {reference: {...reference(), bytes: new Uint8Array([1, 2, 3])}}, {reference: {url: 'https://example.com/a.png'}}]) {
    assert.throws(() => image.compileNativeImageRequest({...intent(), ...change}), {name: 'ImageValidationError'}, JSON.stringify(change).slice(0, 60));
  }
});

test('prepare under the native transport compiles n:1 and leaves an absent estimate unknown', async () => {
  const {fetch, calls} = fakeFetch([]);
  const adapter = provider(fetch, {transport: 'images'});
  const prepared = await adapter.prepare(intent());
  assert.equal(calls.length, 0, 'prepare never dispatches');
  assert.ok(prepared.envelope);
  assert.equal(prepared.envelope.bodySha256, prepared.requestHash);
  const body = JSON.parse(prepared.envelope.body);
  assert.equal(body.n, 1);
  assert.equal(body.prompt, PROMPT);
  assert.equal(body.model, MODEL);
  assert.equal(body.aspect_ratio, '16:9');
  assert.equal('messages' in body, false);
  assert.equal(prepared.estimateUsd, null, 'no configured estimate stays unknown');
  assert.deepEqual(prepared.blockers, []);

  const estimated = await provider(fetch, {transport: 'images', estimateUsd: () => '0.04'}).prepare(intent());
  assert.equal(estimated.estimateUsd, '0.04');
  // The static map mechanism is unchanged; a malformed estimate is still refused as unknown.
  assert.equal((await provider(fetch, {transport: 'images', estimateUsd: () => '4 cents'}).prepare(intent())).estimateUsd, null);
});

test('native submit is exactly one POST to /images with the frozen body', async () => {
  const bytes = pngBytes(96, 54);
  const {fetch, calls} = fakeFetch([nativeAccepted(bytes)]);
  const adapter = provider(fetch, {transport: 'images'});
  const prepared = await adapter.prepare(intent());
  const result = await adapter.submit(prepared.envelope);
  assert.equal(result.status, 'accepted');
  assert.equal(calls.length, 1, 'exactly one request');
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/images');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, prepared.envelope.body, 'the reviewed bytes are what was sent');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(result.receipt.providerModelId, MODEL);
  assert.equal(result.receipt.providerReceiptId, null, 'the documented native response carries no id; none is invented');
  assert.equal(result.receipt.costUsd, '0.04');
  assert.equal(result.receipt.bodySha256, prepared.envelope.bodySha256);
  assert.equal(result.image.mimeType, 'image/png');
  assert.equal(result.image.width, 96);
  assert.equal(result.image.height, 54);
  assert.equal(result.image.sha256, sha(bytes));
  assert.deepEqual(Buffer.from(result.image.bytes), Buffer.from(bytes));
});

test('native submit keeps a missing usage.cost and media_type honest', async () => {
  const bytes = pngBytes(80, 40);
  const {fetch, calls} = fakeFetch([{status: 200, body: {created: 1748372400, data: [{b64_json: b64(bytes)}]}}]);
  const adapter = provider(fetch, {transport: 'images'});
  const result = await adapter.submit((await adapter.prepare(intent())).envelope);
  assert.equal(result.status, 'accepted');
  assert.equal(calls.length, 1);
  assert.equal(result.receipt.costUsd, null, 'a missing cost is null, never zero or a guess');
  assert.equal(result.receipt.providerReceiptId, null);
  assert.equal(result.image.mimeType, 'image/png', 'magic bytes decide the mime when media_type is absent');
  assert.equal(result.image.width, 80);
});

test('native parsing refuses multiple, remote, malformed and mismatched images without retrying', async () => {
  const bytes = pngBytes(64, 32);
  const cases = [
    ['zero images', {created: 1, data: []}, 'failed', 'provider_invalid_output'],
    ['two images', {created: 1, data: [{b64_json: b64(bytes)}, {b64_json: b64(bytes)}]}, 'failed', 'provider_ambiguous_output'],
    ['remote url', {created: 1, data: [{image_url: {url: 'https://example.com/out.png'}}]}, 'failed', 'provider_output_invalid'],
    ['chat-shaped part', {created: 1, data: [{type: 'image_url', image_url: {url: dataUrl(bytes)}}]}, 'failed', 'provider_output_invalid'],
    ['data url instead of base64', {created: 1, data: [{b64_json: dataUrl(bytes)}]}, 'failed', 'provider_output_invalid'],
    ['invalid base64', {created: 1, data: [{b64_json: '%%%%'}]}, 'failed', 'provider_output_invalid'],
    ['not an image', {created: 1, data: [{b64_json: Buffer.from('not an image at all').toString('base64')}]}, 'failed', 'provider_output_invalid'],
    ['media_type mismatch', {created: 1, data: [{b64_json: b64(bytes), media_type: 'image/jpeg'}]}, 'failed', 'provider_output_invalid'],
    ['unsupported media_type', {created: 1, data: [{b64_json: b64(bytes), media_type: 'image/svg+xml'}]}, 'failed', 'provider_output_invalid'],
    ['undeclared extra field', {created: 1, data: [{b64_json: b64(bytes), urls: ['https://example.com/a.png']}]}, 'failed', 'provider_output_invalid'],
    ['oversized image', {created: 1, data: [{b64_json: Buffer.from(new Uint8Array(image.MAX_IMAGE_RESULT_BYTES + 1)).toString('base64')}]}, 'failed', 'provider_output_invalid'],
    ['readable but not an object', [1, 2, 3], 'failed', 'provider_invalid_response'],
    ['wrong model', {created: 1, model: 'other/model', data: [{b64_json: b64(bytes)}]}, 'failed', 'provider_model_mismatch'],
    ['not json', 'not json', 'acceptance_unknown', 'provider_invalid_response'],
  ];
  for (const [label, body, status, code] of cases) {
    const {fetch, calls} = fakeFetch([{status: 200, body}]);
    const adapter = provider(fetch, {transport: 'images'});
    const result = await adapter.submit((await adapter.prepare(intent())).envelope);
    assert.equal(result.status, status, label);
    assert.equal(result.error.code, code, label);
    assert.equal(calls.length, 1, `no retry: ${label}`);
    assert.ok(!JSON.stringify(result).includes(FAKE_KEY), label);
    assert.ok(!JSON.stringify(result).includes('example.com'), `no remote location echoed: ${label}`);
  }
});

test('a frozen chat envelope still routes to chat-completions under a native current configuration', async () => {
  const bytes = pngBytes(50, 25);
  const {fetch, calls} = fakeFetch([{
    status: 200,
    body: {id: 'gen-fixture-1', model: MODEL, choices: [{message: {images: [{type: 'image_url', image_url: {url: dataUrl(bytes)}}]}}], usage: {cost: 0.039}},
  }]);
  const legacy = provider(fetch);
  const chatEnvelope = (await legacy.prepare(intent())).envelope;
  assert.equal(JSON.parse(chatEnvelope.body).modalities.join(','), 'image,text', 'the legacy body is unchanged');
  assert.equal('n' in JSON.parse(chatEnvelope.body), false, 'the legacy body still carries no n');

  // Same frozen request, but the server configuration has since been switched to the native route.
  const nativeConfigured = provider(fetch, {transport: 'images'});
  const result = await nativeConfigured.submit(chatEnvelope);
  assert.equal(result.status, 'accepted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions', 'the body decides the endpoint, not current config');
  assert.equal(result.receipt.providerReceiptId, 'gen-fixture-1');
  assert.equal(result.receipt.costUsd, '0.039');
});

test('a frozen native envelope still routes to /images under a default chat configuration', async () => {
  const bytes = pngBytes(50, 25);
  const {fetch, calls} = fakeFetch([nativeAccepted(bytes)]);
  const nativeAdapter = provider(fetch, {transport: 'images'});
  const nativeEnvelope = (await nativeAdapter.prepare(intent())).envelope;
  const chatConfigured = provider(fetch);
  const result = await chatConfigured.submit(nativeEnvelope);
  assert.equal(result.status, 'accepted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/images');
  assert.equal(result.receipt.costUsd, '0.04');
});

test('shape, n, reference and model tampering is refused before any dispatch', async () => {
  const {fetch, calls} = fakeFetch([]);
  const adapter = provider(fetch, {transport: 'images'});
  const prepared = await adapter.prepare(intent());
  const body = JSON.parse(prepared.envelope.body);
  const rejected = [
    ['n is not 1', resign({...body, n: 2}), 'request_shape_invalid'],
    ['n missing', resign(Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'n'))), 'request_shape_invalid'],
    ['n as string', resign({...body, n: '1'}), 'request_shape_invalid'],
    ['extra passthrough field', resign({...body, quality: 'high'}), 'request_shape_invalid'],
    ['mixed chat and native body', resign({...body, messages: [{role: 'user', content: [{type: 'text', text: PROMPT}]}]}), 'request_shape_invalid'],
    ['two references', resign({...body, input_references: [body.input_references[0], body.input_references[0]]}), 'request_shape_invalid'],
    ['remote reference', resign({...body, input_references: [{type: 'image_url', image_url: {url: 'https://example.com/ref.png'}}]}), 'request_shape_invalid'],
    ['reference without type', resign({...body, input_references: [{image_url: body.input_references[0].image_url}]}), 'request_shape_invalid'],
    ['output format changed', resign({...body, output_format: 'svg'}), 'request_shape_invalid'],
    ['model missing', resign({prompt: PROMPT, aspect_ratio: '16:9', n: 1, output_format: 'png'}, MODEL), 'request_shape_invalid'],
    ['model mismatch', resign({...body, model: 'openai/gpt-image-2.5-sunburst'}, MODEL), 'request_model_mismatch'],
    ['not an object', {...prepared.envelope, body: '[]', bodySha256: sha('[]')}, 'request_shape_invalid'],
  ];
  for (const [label, envelope, code] of rejected) {
    const result = await adapter.submit(envelope);
    assert.equal(result.status, 'failed', label);
    assert.equal(result.error.code, code, label);
  }
  assert.equal(calls.length, 0, 'nothing was dispatched');
});

test('native transport failure after dispatch is unknown acceptance with one request and no receipt', async () => {
  const {fetch, calls} = fakeFetch([new Error('socket hang up')]);
  const adapter = provider(fetch, {transport: 'images'});
  const result = await adapter.submit((await adapter.prepare(intent())).envelope);
  assert.equal(result.status, 'acceptance_unknown');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/images');
  assert.equal(result.receipt, undefined);
  assert.match(result.error.message, /do not (automatically )?(submit|resubmit)/i);
  assert.ok(!JSON.stringify(result.error).includes('socket hang up'));
});

test('native HTTP failures map to the same safe codes without retries', async () => {
  for (const [status, expected, code] of [[400, 'failed', 'provider_invalid_request'], [402, 'blocked', 'provider_payment_required'], [429, 'blocked', 'provider_rate_limited'], [500, 'acceptance_unknown', 'provider_acceptance_unknown']]) {
    const {fetch, calls} = fakeFetch([{status, body: {error: {message: `raw detail ${FAKE_KEY}`}}}]);
    const adapter = provider(fetch, {transport: 'images'});
    const result = await adapter.submit((await adapter.prepare(intent())).envelope);
    assert.equal(result.status, expected, String(status));
    assert.equal(result.error.code, code, String(status));
    assert.equal(calls.length, 1, `no retry for ${status}`);
    assert.ok(!JSON.stringify(result.error).includes(FAKE_KEY));
  }
});

test('legacy chat parsing accepts the documented typeless image item but rejects an explicit wrong type', async () => {
  const bytes = pngBytes(44, 22);
  const accepted = async part => {
    const {fetch, calls} = fakeFetch([{status: 200, body: {id: 'gen-fixture-1', choices: [{message: {images: [part]}}]}}]);
    const adapter = provider(fetch);
    const result = await adapter.submit((await adapter.prepare(intent())).envelope);
    assert.equal(calls.length, 1);
    return result;
  };
  const typeless = await accepted({image_url: {url: dataUrl(bytes)}});
  assert.equal(typeless.status, 'accepted', 'the documented ChatAssistantImages item has no type field');
  assert.equal(typeless.image.sha256, sha(bytes));
  assert.equal(typeless.receipt.costUsd, null);

  assert.equal((await accepted({type: 'image_url', image_url: {url: dataUrl(bytes)}})).status, 'accepted');
  assert.equal((await accepted({type: 'text', image_url: {url: dataUrl(bytes)}})).status, 'failed');
  assert.equal((await accepted({type: 'input_image', image_url: {url: dataUrl(bytes)}})).status, 'failed');

  const {fetch, calls} = fakeFetch([{status: 200, body: {id: 'gen-1', choices: [{message: {images: [{image_url: {url: dataUrl(bytes)}}, {image_url: {url: dataUrl(bytes)}}]}}]}}]);
  const adapter = provider(fetch);
  const ambiguous = await adapter.submit((await adapter.prepare(intent())).envelope);
  assert.equal(ambiguous.error.code, 'provider_ambiguous_output');
  assert.equal(calls.length, 1);
});

test('an unknown transport option is a configuration error, never a fallback', () => {
  for (const transport of ['image', 'Images', '', 'images ', 'chat', 'chat_completions', 1, null]) {
    assert.throws(() => provider(async () => new Response(''), {transport}), TypeError, String(transport));
  }
  assert.ok(provider(async () => new Response(''), {transport: 'chat-completions'}));
  assert.ok(provider(async () => new Response(''), {transport: 'images'}));
  assert.ok(provider(async () => new Response('')), 'the default stays chat-completions');
});
