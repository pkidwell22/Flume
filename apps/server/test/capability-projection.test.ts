import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type { MediaStore } from '@flume/media';
import { VIDEO_PRIVACY_MESSAGE } from '@flume/providers';
import { FlumeClient, FlumeClientError } from '../../../packages/client/src/index.ts';
import type { CapabilityView } from '../../../packages/shot-editor/src/types.ts';
import type { Capability as WebCapability } from '../../web/src/types.ts';
import { createProviderBridge } from '../src/provider-bridge.ts';
import { createCommandService } from '../src/service.ts';
import { buildServer } from '../src/http.ts';
import { blockedProvider, type ProviderPort } from '../src/ports.ts';

// Capability reads with no project must not touch storage, media or paid work.
const pool = new Proxy({} as Pool, { get() { throw new Error('Unexpected database access'); } });
const media = new Proxy({} as MediaStore, { get() { throw new Error('Unexpected media access'); } });
const actor = { id: '10000000-0000-4000-8000-000000000001', kind: 'operator' as const, projectIds: '*' as const };

async function readCapabilities(provider: ProviderPort) {
  const app = await buildServer({
    service: createCommandService({ pool, provider }),
    security: { mode: 'protected', allowedHosts: ['capability-contract.invalid'], allowedOrigins: [] },
    authenticate: async () => actor,
  });
  try {
    // In-process HTTP injection: no listener, live API, credentials or store.
    const client = new FlumeClient({
      baseUrl: 'https://capability-contract.invalid',
      fetch: async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.pathname, '/api/workspace');
        assert.equal(url.search, '');
        assert.equal(init?.method ?? 'GET', 'GET');
        const response = await app.inject({ method: 'GET', url: url.pathname, headers: { host: url.host } });
        assert.equal(response.statusCode, 200);
        return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
      },
    });
    const workspace = await client.getWorkspace();
    const web: WebCapability[] = workspace.capabilities;
    const editor: readonly CapabilityView[] = web;
    // Read through each structural contract, not an assertion/cast to a wider type.
    assert.deepEqual(
      web.map(c => [c.aspectRatios, c.generateAudioSupported]),
      editor.map(c => [c.aspectRatios, c.generateAudioSupported]),
    );
    return { publicCapabilities: workspace.capabilities, web, editor };
  } finally {
    await app.close();
  }
}

test('catalog metadata reaches the canonical client and editor view exactly without granting entitlement', async (t) => {
  const models = [
    { id: 'fixture/portrait-audio', name: 'Controlled portrait fixture', supported_aspect_ratios: ['9:16', '1:1', '16:9'], generate_audio: true },
    { id: 'fixture/wide-silent', name: 'Controlled silent fixture', supported_aspect_ratios: ['2:1'], generate_audio: false },
  ];
  const catalog = { data: models.map(model => ({
    ...model, supported_durations: [7, 5], supported_resolutions: ['1080p', '720p'],
    supported_frame_images: ['first_frame', 'last_frame'], seed: false,
    // Provider-only fields must not become public read fields.
    providerEnvelope: { body: 'private-fixture-envelope' }, unrecognizedCatalogField: 'not-public',
  })) };
  const fetch = t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), 'https://openrouter.ai/api/v1/videos/models');
    assert.equal(init?.method, 'GET');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return Response.json(catalog);
  });
  // A synthetic nonempty configuration exercises the existing unknown route.
  // The public catalog read does not use or transmit it as an authorization key.
  const bridge = createProviderBridge(pool, media, 'capability-test', () => 'fixture-not-a-credential');
  await bridge.discover();
  const projected = await bridge.provider.capabilities();
  assert.deepEqual(projected.find(c => c.modelId === models[0].id)?.aspectRatios, ['9:16', '1:1', '16:9']);

  const { publicCapabilities, web, editor } = await readCapabilities(bridge.provider);
  assert.deepEqual(web, publicCapabilities);
  assert.deepEqual(editor, publicCapabilities);
  assert.equal(editor.length, models.length + 1, 'The existing privacy-blocked H3 fallback remains');
  for (const model of models) {
    const view: CapabilityView | undefined = editor.find(c => c.modelId === model.id);
    assert.deepEqual(view, {
      modelId: model.id, name: model.name, durations: [7, 5], resolutions: ['1080p', '720p'],
      aspectRatios: model.supported_aspect_ratios, frameRoles: ['first', 'last'],
      seedSupported: false, generateAudioSupported: model.generate_audio,
      availability: 'unknown', blocker: null,
    });
  }
  const h3 = editor.find(c => c.modelId === 'minimax/hailuo-3')!;
  assert.deepEqual(h3.aspectRatios, ['16:9']);
  assert.equal(h3.generateAudioSupported, false);
  assert.equal(h3.availability, 'blocked');
  assert.equal(h3.blocker, VIDEO_PRIVACY_MESSAGE);
  assert.equal(fetch.mock.callCount(), 1, 'Discovery only; no prepare, submit or polling');

  // A consumer cannot mutate the bridge's retained aspect-ratio metadata.
  projected.find(c => c.modelId === models[0].id)!.aspectRatios!.push('consumer-only');
  assert.deepEqual((await bridge.provider.capabilities()).find(c => c.modelId === models[0].id)!.aspectRatios, ['9:16', '1:1', '16:9']);
});

test('existing blocked provider and catalog-failure read fixtures retain absent metadata as unknown', async () => {
  const legacy = await blockedProvider.capabilities();
  const read = await readCapabilities(blockedProvider);
  assert.deepEqual(read.publicCapabilities, legacy);
  const unavailable: ProviderPort = {
    async capabilities() { throw new Error('Controlled unavailable catalog'); },
    async prepare() { throw new Error('Unexpected preparation'); },
  };
  const fallback = await readCapabilities(unavailable);
  assert.equal(fallback.editor[0].availability, 'unknown');
  assert.equal(fallback.editor[0].blocker, 'The provider catalog is unavailable. Local editing remains available.');
  for (const model of [...read.editor, ...fallback.editor]) {
    assert.equal(model.aspectRatios, undefined);
    assert.equal(model.generateAudioSupported, undefined);
    assert.equal(Object.hasOwn(model, 'aspectRatios'), false);
    assert.equal(Object.hasOwn(model, 'generateAudioSupported'), false);
  }
});

test('partial read metadata preserves explicit false and empty ratios without filling the missing field', async () => {
  const [legacy] = await blockedProvider.capabilities();
  const metadata = [
    { generateAudioSupported: false }, { generateAudioSupported: true },
    { aspectRatios: [] }, { aspectRatios: ['4:3', '9:16'] },
  ];
  const capabilities = metadata.map((fields, index) => ({ ...legacy, modelId: `fixture/partial-${index}`, ...fields }));
  const read = await readCapabilities({
    async capabilities() { return capabilities; },
    async prepare() { throw new Error('Unexpected preparation'); },
  });
  assert.deepEqual(read.publicCapabilities, capabilities);
  for (const [index, model] of read.editor.entries()) {
    assert.equal(Object.hasOwn(model, 'aspectRatios'), Object.hasOwn(metadata[index], 'aspectRatios'));
    assert.equal(Object.hasOwn(model, 'generateAudioSupported'), Object.hasOwn(metadata[index], 'generateAudioSupported'));
    assert.equal(model.availability, 'blocked');
  }
});

test('canonical client still rejects unknown capability fields and private provider envelopes', async () => {
  const [legacy] = await blockedProvider.capabilities();
  for (const extra of [{ futureCapabilityField: true }, { providerEnvelope: { body: 'private-fixture-envelope' } }]) {
    await assert.rejects(readCapabilities({
      async capabilities() { return [{ ...legacy, ...extra }]; },
      async prepare() { throw new Error('Unexpected preparation'); },
    }), (error: unknown) => error instanceof FlumeClientError && error.code === 'invalid_response' && !error.message.includes('private-fixture-envelope'));
  }
});

test('known metadata does not remove the no-credentials blocker', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), 'https://openrouter.ai/api/v1/videos/models');
    assert.equal(init?.method, 'GET');
    return Response.json({ data: [{ id: 'fixture/no-credentials', name: 'Controlled blocked fixture',
      supported_aspect_ratios: ['3:2'], generate_audio: true }] });
  });
  const bridge = createProviderBridge(pool, media, 'capability-test', () => undefined);
  await bridge.discover();
  const { editor } = await readCapabilities(bridge.provider);
  const model = editor.find(c => c.modelId === 'fixture/no-credentials')!;
  assert.deepEqual(model.aspectRatios, ['3:2']);
  assert.equal(model.generateAudioSupported, true);
  assert.equal(model.availability, 'blocked');
  assert.equal(model.blocker, 'No generation credentials are configured in this local session.');
  assert.equal(fetch.mock.callCount(), 1);
});
