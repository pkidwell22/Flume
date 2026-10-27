// Opt-in native image transport: configuration flag, provider wiring and spend-guard behaviour.
// Entirely synthetic: in-memory store, fixture media, synthetic fetch. No network, no database,
// no provider credential, no spend.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {readAuthoringConfiguration} from '../src/local-configuration.ts';
import {createFrameProvider, type ImageAuthoringConfiguration} from '../src/authoring-runtime.ts';
import {createFrameAuthoringService} from '../src/frame-authoring.ts';
import {
  createMemoryFrameAuthoringStore, createFixtureMedia, pngBytes, PROJECT, SHOT, SOURCE_ASSET, OPERATOR,
} from './frame-authoring-fixtures.ts';

const MODEL = 'bytedance-seed/seedream-4.5';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const B64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

const baseEnv = {
  FLUME_IMAGE_AUTHORING_MODE: 'openrouter',
  FLUME_OPENROUTER_SCOPE: 'openrouter/fixture/v1',
  FLUME_IMAGE_AUTHORING_MODELS: JSON.stringify([{modelId: MODEL, name: 'Seedream', aspectRatios: ['16:9'], availability: 'available'}]),
  OPENROUTER_API_KEY: 'synthetic-native-transport-key',
};

test('real capability route survives the browser parser with both application frame roles', async () => {
  const {createAuthoringRuntime} = await import('../src/authoring-runtime.ts');
  const {registerAuthoringRoutes} = await import('../src/authoring-routes.ts');
  const {default: Fastify} = await import('fastify');
  const {createAuthoringApi} = await import(new URL('../../web/src/authoring-api.ts', import.meta.url).href);
  const h = harness({transport: 'images'});
  for (const useOverride of [false, true]) {
  const app = Fastify();
  const capabilities = useOverride ? async () => ({imageModels: await h.service.capabilities(), storyboard: {available: false, blocker: 'fixture'}}) : undefined;
  registerAuthoringRoutes(app, {authoring: createAuthoringRuntime({service: h.service, capabilities}), getActor: () => OPERATOR});
  try {
    const api = createAuthoringApi(async (path: string) => {
      assert.equal(path, '/api/authoring/capabilities');
      const response = await app.inject({method: 'GET', url: path});
      return new Response(response.body, {status: response.statusCode, headers: {'content-type': 'application/json'}});
    });
    const capabilities = await api.capabilities();
    assert.equal(capabilities.imageModels.length, 1);
    assert.deepEqual(capabilities.imageModels[0].frameRoles, ['first_frame', 'last_frame']);
    assert.equal(capabilities.imageModels[0].availability, 'available');
    assert.equal(h.calls.length, 0, 'application target roles do not dispatch or approve generation');
  } finally { await app.close(); }
  }
});

test('the native transport is opt-in and defaults to the legacy chat route', () => {
  assert.equal(readAuthoringConfiguration(baseEnv).image.mode, 'openrouter');
  const legacy = readAuthoringConfiguration(baseEnv).image;
  assert.equal(legacy.mode === 'openrouter' && legacy.transport, 'chat-completions', 'omission keeps chat-completions');

  const native = readAuthoringConfiguration({...baseEnv, FLUME_IMAGE_AUTHORING_TRANSPORT: 'images'}).image;
  assert.equal(native.mode === 'openrouter' && native.transport, 'images');
  const explicit = readAuthoringConfiguration({...baseEnv, FLUME_IMAGE_AUTHORING_TRANSPORT: 'chat-completions'}).image;
  assert.equal(explicit.mode === 'openrouter' && explicit.transport, 'chat-completions', 'the legacy literal is accepted explicitly');

  for (const value of ['', 'Images', 'image', ' images', 'images ', 'native', 'chat', 'chat_completions', 'true']) {
    assert.throws(() => readAuthoringConfiguration({...baseEnv, FLUME_IMAGE_AUTHORING_TRANSPORT: value}), /FLUME_IMAGE_AUTHORING_TRANSPORT/, JSON.stringify(value));
  }
});

test('the transport flag never enables authoring by itself and never changes the spend configuration', () => {
  const blocked = readAuthoringConfiguration({FLUME_IMAGE_AUTHORING_TRANSPORT: 'images'});
  assert.deepEqual(blocked.image, {mode: 'blocked'}, 'an opt-in transport does not turn authoring on');
  assert.throws(() => readAuthoringConfiguration({FLUME_IMAGE_AUTHORING_TRANSPORT: 'Images'}), /FLUME_IMAGE_AUTHORING_TRANSPORT/,
    'an invalid literal is a startup error rather than a silent fallback');

  const configured = readAuthoringConfiguration({
    ...baseEnv,
    FLUME_IMAGE_AUTHORING_TRANSPORT: 'images',
    FLUME_IMAGE_AUTHORING_ESTIMATES_USD: JSON.stringify({[MODEL]: '0.04'}),
  }).image;
  assert.equal(configured.mode, 'openrouter');
  assert.deepEqual(configured.mode === 'openrouter' ? configured.estimatesUsd : null, {[MODEL]: '0.04'}, 'the static estimate map mechanism is unchanged');
  assert.ok(!JSON.stringify(configured).includes('synthetic-native-transport-key'), 'the credential stays in a closure');
});

test('a native-transport server still refuses to spend without an estimate and dispatches nothing', async () => {
  const {service, store, calls} = harness({transport: 'images'});
  const created = await service.createReview({actor: OPERATOR, draft: draft()});
  assert.equal(created.estimateUsd, null, 'no estimate configured stays unknown');
  assert.deepEqual(created.blockers, [], 'the transport itself adds no blocker');

  const envelope = (await store.getReview(PROJECT, created.reviewId))!.envelope!;
  assert.equal(JSON.parse(envelope.body).n, 1);
  assert.equal('messages' in JSON.parse(envelope.body), false);

  await assert.rejects(
    service.approveAndSubmit({actor: OPERATOR, projectId: PROJECT, reviewId: created.reviewId, expectedRevision: 3, maxCostUsd: '1.00'}),
    {code: 'ESTIMATE_UNKNOWN'},
  );
  assert.equal(calls.length, 0, 'no provider request was made');
});

test('with an operator-configured per-image estimate the native route submits exactly once', async () => {
  const h = harness({transport: 'images', estimatesUsd: {[MODEL]: '0.04'}});
  const created = await h.service.createReview({actor: OPERATOR, draft: draft()});
  assert.equal(created.estimateUsd, 0.04);

  await assert.rejects(
    h.service.approveAndSubmit({actor: OPERATOR, projectId: PROJECT, reviewId: created.reviewId, expectedRevision: 3, maxCostUsd: '0.03'}),
    {code: 'COST_CAP_EXCEEDED'},
  );
  assert.equal(h.calls.length, 0, 'a cap below the estimate never dispatches');

  const outcome = await h.service.approveAndSubmit({actor: OPERATOR, projectId: PROJECT, reviewId: created.reviewId, expectedRevision: 3, maxCostUsd: '0.04'});
  assert.equal(h.calls.length, 1, 'exactly one provider request');
  assert.equal(h.calls[0]!.url, 'https://openrouter.ai/api/v1/images');
  assert.equal(h.calls[0]!.options.body, (await h.store.getReview(PROJECT, created.reviewId))!.envelope!.body);
  assert.ok(['submitted', 'result_ready'].includes(outcome.review.status), `unexpected status ${outcome.review.status}`);
  const stored = (await h.store.getReview(PROJECT, created.reviewId))!;
  assert.equal(stored.providerReceiptId, null, 'the native response carries no id and none is invented');
  assert.equal(stored.output!.mimeType, 'image/png');
  assert.equal(stored.output!.sha256, sha(pngBytes(64, 36)), 'the accepted bytes are the synthetic native image');
});

test('the provider port exposes the native body and keeps the legacy body for the default route', async () => {
  const synthetic = () => {
    const calls: {url: string; options: any}[] = [];
    const fetch = async (url: any, options: any = {}) => {
      calls.push({url: String(url), options});
      return new Response(JSON.stringify({created: 1, data: [{b64_json: B64(pngBytes(32, 16))}]}), {status: 200, headers: {'content-type': 'application/json'}});
    };
    return {calls, fetch};
  };
  const reference = {assetId: SOURCE_ASSET, sha256: sha(pngBytes(80, 45)), mimeType: 'image/png' as const, bytes: pngBytes(80, 45)};
  const input = {role: 'first_frame' as const, prompt: 'native exact prompt', modelId: MODEL, aspectRatio: '16:9', reference};

  const nativeFetch = synthetic();
  const native = createFrameProvider({mode: 'openrouter', transport: 'images', models: [{modelId: MODEL, name: 'Seedream', availability: 'available'}], getApiKey: () => 'synthetic-key'} as ImageAuthoringConfiguration, {fetch: nativeFetch.fetch as any});
  const nativePrepared = await native.prepare(input);
  assert.deepEqual(JSON.parse(nativePrepared.envelope!.body), {
    model: MODEL, prompt: 'native exact prompt', aspect_ratio: '16:9', n: 1, output_format: 'png',
    input_references: [{type: 'image_url', image_url: {url: `data:image/png;base64,${B64(pngBytes(80, 45))}`}}],
  });
  const submitted = await native.submit(nativePrepared.envelope!);
  assert.equal(submitted.status, 'accepted');
  if (submitted.status !== 'accepted') throw new Error('unreachable');
  assert.equal(submitted.receipt.costUsd, null);
  assert.equal(submitted.receipt.providerReceiptId, null);
  assert.equal(nativeFetch.calls[0]!.url, 'https://openrouter.ai/api/v1/images');

  const chatFetch = synthetic();
  const chat = createFrameProvider({mode: 'openrouter', models: [{modelId: MODEL, name: 'Seedream', availability: 'available'}], getApiKey: () => 'synthetic-key'}, {fetch: chatFetch.fetch as any});
  const chatPrepared = await chat.prepare(input);
  const chatBody = JSON.parse(chatPrepared.envelope!.body);
  assert.deepEqual(Object.keys(chatBody), ['model', 'messages', 'modalities', 'image_config'], 'the legacy body is byte-shape unchanged');
  assert.equal('n' in chatBody, false);
  await chat.submit(chatPrepared.envelope!);
  assert.equal(chatFetch.calls[0]!.url, 'https://openrouter.ai/api/v1/chat/completions');
});

// --- fixture harness (in-memory store, owned fixture media, synthetic provider fetch) ---

function draft() {
  return {
    projectId: PROJECT, shotId: SHOT, expectedRevision: 3, role: 'first_frame' as const,
    prompt: '  native frame prompt café 🟠\n', modelId: MODEL, aspectRatio: '16:9', sourceAssetId: SOURCE_ASSET,
  };
}

function harness(options: {transport: 'images' | 'chat-completions'; estimatesUsd?: Record<string, string>}) {
  const sourceBytes = pngBytes(80, 45);
  const outputBytes = pngBytes(64, 36);
  const store = createMemoryFrameAuthoringStore({
    shots: [{id: SHOT, projectId: PROJECT, revision: 3, bindings: {firstFrameAssetId: null, lastFrameAssetId: null}}],
    assets: [{id: SOURCE_ASSET, projectId: PROJECT, kind: 'image', sha256: sha(sourceBytes), mimeType: 'image/png', byteSize: sourceBytes.length}],
  });
  const media = createFixtureMedia(asset => store.registerAsset(asset));
  media.seedOwned(PROJECT, SOURCE_ASSET, sourceBytes);

  const calls: {url: string; options: any}[] = [];
  const fetch = async (url: any, init: any = {}) => {
    calls.push({url: String(url), options: init});
    // Synthetic provider response: labeled fixture bytes, no id and no usage on purpose.
    return new Response(JSON.stringify({created: 1748372400, data: [{b64_json: B64(outputBytes), media_type: 'image/png'}]}),
      {status: 200, headers: {'content-type': 'application/json'}});
  };
  const configuration: ImageAuthoringConfiguration = {
    mode: 'openrouter',
    transport: options.transport,
    models: [{modelId: MODEL, name: 'Seedream (fixture)', aspectRatios: ['16:9'], availability: 'available'}],
    ...(options.estimatesUsd ? {estimatesUsd: options.estimatesUsd} : {}),
    getApiKey: () => 'synthetic-key',
  };
  const provider = createFrameProvider(configuration, {fetch: fetch as any});
  let sequence = 0;
  const service = createFrameAuthoringService({
    store, media, provider,
    ids: {
      reviewId: () => `0000000a-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
      assetId: () => `0000000b-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    },
    clock: () => new Date('2026-10-27T00:00:00.000Z'),
  });
  return {store, media, service, calls};
}
