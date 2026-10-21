import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {migrate} from '@flume/database';
import type {Pool} from 'pg';
import {generatedAssetId, type Asset, type MediaStore} from '@flume/media';
import {createProviderBridge, type ProviderBridgePrivacyPolicy} from '../src/provider-bridge.ts';
import type {Shot} from '../src/dto.ts';
import type {DispatchIntent, ProviderReceipt} from '@flume/worker';
import {sha256} from '../src/contracts.ts';
import {H3_RETENTION_HOLD_MESSAGE} from '../src/provider-bridge.ts';
import {createCommandService} from '../src/service.ts';
import {ownedPostgres} from '../../../packages/database/test/owned-postgres.ts';

const H3 = 'minimax/hailuo-3';
const scope = 'controlled-privacy-policy-fixture';
const contentBytes = Buffer.from('SYNTHETIC CONTENT HANDOFF ONLY: not a playable video');
const allowRetention = {h3RetentionDecision: 'allow-temporary-retention'} as const;
const shot:Shot = {
  id: '11111111-1111-4111-8111-111111111111', projectId: '22222222-2222-4222-8222-222222222222',
  title: 'Controlled policy fixture', prompt: 'SYNTHETIC FIXTURE ONLY', revision: 1,
  controls: {modelId: H3, durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false},
  bindings: {firstFrameAssetId: null, lastFrameAssetId: null}, selectedTakeId: null, selectionRevision: 0,
};
const noDatabase = {async query() {throw new Error('Unexpected database access');}} as unknown as Pool;
const noMedia = {} as MediaStore;
const prepare = (bridge:ReturnType<typeof createProviderBridge>, input = shot) =>
  bridge.provider.prepare({projectId: input.projectId, shot: input, assets: []});
const signal = () => new AbortController().signal;
const intent = (modelId = H3):DispatchIntent => {
  const body = JSON.stringify({model: modelId, prompt: shot.prompt, duration: 5, resolution: '2K', aspect_ratio: '16:9', generate_audio: false});
  return {key: 'controlled-dispatch', request: {provider: 'openrouter', scope, modelId, body, bodySha256: sha256(body)}};
};
const catalogModel = (id:string) => ({
  id, name: 'Controlled catalog fixture', supported_durations: [5], supported_resolutions: ['2K'],
  supported_aspect_ratios: ['16:9'], supported_frame_images: ['first_frame', 'last_frame'], seed: false, generate_audio: false,
});
async function fixture(t:TestContext) {
  const requests:{method:string|undefined;url:string|undefined;auth:string|undefined;body:string}[] = [];
  let models = [catalogModel(H3), catalogModel('fixture/other')];
  let baseUrl = '';
  const server = createServer(async (q, r) => {
    const chunks:Buffer[] = [];
    for await (const chunk of q) chunks.push(Buffer.from(chunk));
    requests.push({method: q.method, url: q.url, auth: q.headers.authorization, body: Buffer.concat(chunks).toString('utf8')});
    r.setHeader('content-type', 'application/json');
    if (q.method === 'GET' && q.url === '/api/v1/videos/models') {r.end(JSON.stringify({data: models})); return;}
    if (q.method === 'POST' && q.url === '/api/v1/videos') {
      r.statusCode = 202; r.end(JSON.stringify({id: 'fixture-h3-job', model: JSON.parse(Buffer.concat(chunks).toString('utf8')).model})); return;
    }
    if (q.method === 'GET' && q.url === '/api/v1/videos/fixture-h3-job') {
      r.end(JSON.stringify({id: 'fixture-h3-job', model: H3, status: 'completed', unsigned_urls: [`${baseUrl}/videos/fixture-h3-job/content?index=0`]})); return;
    }
    if (q.method === 'GET' && q.url === '/api/v1/videos/fixture-h3-job/content?index=0') {
      r.setHeader('content-type', 'video/mp4'); r.end(contentBytes); return;
    }
    r.statusCode = 404; r.end(JSON.stringify({error: {message: 'Unexpected fixture path'}}));
  });
  t.after(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections(); await closed;
    assert.equal(server.listening, false);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as {port:number}).port}/api/v1`;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input:Parameters<typeof fetch>[0], init?:RequestInit) => {
    assert.equal(typeof input, 'string');
    assert.ok(String(input).startsWith(`${baseUrl}/`), 'No transport may leave the owned loopback fixture');
    return realFetch(input, init);
  });
  return {requests, transport: {baseUrl, allowLoopbackHttpForTests: true as const}, setModels: (ids:string[]) => {models = ids.map(catalogModel);}};
}

test('explicit H3 retention decision removes only the fallback privacy blocker, not unknown entitlement or cost', async () => {
  const bridge = createProviderBridge(noDatabase, noMedia, scope, () => 'SYNTHETIC-FIXTURE-KEY', undefined, allowRetention);
  const [capability] = await bridge.provider.capabilities();
  assert.equal(capability.availability, 'unknown');
  assert.equal(capability.blocker, null);
  const prepared = await prepare(bridge);
  assert.ok(prepared.envelope);
  assert.equal(prepared.estimatedCostUsd, null);
  assert.deepEqual(prepared.blockers, [{code: 'ENTITLEMENT_UNKNOWN', message: 'Catalog presence does not establish entitlement. This route has not been verified.'}]);
});

test('explicit opt-in permits only a controlled low-level H3 POST and leaves discovered entitlement unknown', async t => {
  const f = await fixture(t);
  const bridge = createProviderBridge(noDatabase, noMedia, scope, () => 'SYNTHETIC-FIXTURE-KEY', f.transport, allowRetention);
  const dispatch = intent();
  const result = await bridge.workerProvider.submit(dispatch, signal());
  assert.deepEqual(result, {kind: 'accepted', receipt: {provider: 'openrouter', scope, modelId: H3, providerJobId: 'fixture-h3-job'}});
  assert.deepEqual(f.requests, [{method: 'POST', url: '/api/v1/videos', auth: 'Bearer SYNTHETIC-FIXTURE-KEY', body: dispatch.request.body}]);
  await bridge.discover();
  const [capability] = await bridge.provider.capabilities();
  assert.equal(capability.availability, 'unknown');
  assert.equal(capability.blocker, null);
  assert.deepEqual((await prepare(bridge)).blockers.map(b => typeof b === 'string' ? b : b.code), ['ENTITLEMENT_UNKNOWN']);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});

test('opt-in without credentials remains unavailable, never mislabeled as privacy consent or sent', async t => {
  const f = await fixture(t);
  const bridge = createProviderBridge(noDatabase, noMedia, scope, undefined, f.transport, allowRetention);
  const [capability] = await bridge.provider.capabilities();
  assert.equal(capability.availability, 'blocked');
  assert.match(capability.blocker!, /No generation credentials/);
  const prepared = await prepare(bridge);
  assert.equal(prepared.estimatedCostUsd, null);
  assert.deepEqual(prepared.blockers.map(b => typeof b === 'string' ? b : b.code), ['PROVIDER_UNAVAILABLE']);
  const result = await bridge.workerProvider.submit(intent(), signal());
  assert.equal(result.kind, 'blocked');
  assert.ok('issue' in result);
  assert.equal(result.issue.code, 'provider_authentication_required');
  assert.deepEqual(f.requests, []);
});

test('default, key-only and non-affirmative policies keep H3 blocked with zero POSTs before and after discovery', async t => {
  const f = await fixture(t);
  const cases = [
    {key: undefined, policy: undefined},
    {key: 'SYNTHETIC-FIXTURE-KEY', policy: undefined},
    {key: 'SYNTHETIC-FIXTURE-KEY', policy: {h3RetentionDecision: 'keep-blocked'}},
    // Untyped callers must not turn truthiness, an empty object or a misspelled token into consent.
    {key: 'SYNTHETIC-FIXTURE-KEY', policy: {}},
    {key: 'SYNTHETIC-FIXTURE-KEY', policy: {h3RetentionDecision: true}},
    {key: 'SYNTHETIC-FIXTURE-KEY', policy: {h3RetentionDecision: 'allow-temporary-retention '}},
  ];
  for (const {key, policy} of cases) {
    const bridge = createProviderBridge(noDatabase, noMedia, scope, () => key, f.transport, policy as ProviderBridgePrivacyPolicy|undefined);
    for (const discover of [false, true]) {
      if (discover) await bridge.discover();
      const capability = (await bridge.provider.capabilities()).find(c => c.modelId === H3)!;
      assert.equal(capability.availability, 'blocked');
      const message=key ? H3_RETENTION_HOLD_MESSAGE : 'No generation credentials are configured in this local session.';
      assert.equal(capability.blocker, message);
      assert.deepEqual((await prepare(bridge)).blockers, [{code: key ? 'provider_privacy_blocked' : 'PROVIDER_UNAVAILABLE', message}]);
      assert.deepEqual(await bridge.workerProvider.submit(intent(), signal()), {kind: 'blocked', issue: {code: 'provider_privacy_blocked', message: H3_RETENTION_HOLD_MESSAGE}});
    }
  }
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
  assert.equal(f.requests.length, cases.length);
  assert.ok(f.requests.every(r => r.method === 'GET' && r.url === '/api/v1/videos/models' && r.auth === undefined));
});

test('controlled transport configuration cannot implicitly override the explicit retention decision', async t => {
  const f = await fixture(t);
  const transport = {...f.transport, privacyBlockedModelIds: []};
  const bridge = createProviderBridge(noDatabase, noMedia, scope, () => 'SYNTHETIC-FIXTURE-KEY', transport);
  assert.deepEqual(await bridge.workerProvider.submit(intent(), signal()), {kind: 'blocked', issue: {code: 'provider_privacy_blocked', message: H3_RETENTION_HOLD_MESSAGE}});
  assert.deepEqual(f.requests, []);
});

test('policy is captured per bridge and cannot be changed by mutating the caller object', async t => {
  const f = await fixture(t);
  const policy:{h3RetentionDecision:ProviderBridgePrivacyPolicy['h3RetentionDecision']} = {h3RetentionDecision: 'keep-blocked'};
  const held = createProviderBridge(noDatabase, noMedia, scope, () => 'SYNTHETIC-FIXTURE-KEY', f.transport, policy);
  policy.h3RetentionDecision = 'allow-temporary-retention';
  assert.equal((await held.workerProvider.submit(intent(), signal())).kind, 'blocked');
  await held.discover();
  assert.equal((await held.provider.capabilities())[0].availability, 'blocked');
  const opted = createProviderBridge(noDatabase, noMedia, scope, () => 'SYNTHETIC-FIXTURE-KEY', f.transport, policy);
  policy.h3RetentionDecision = 'keep-blocked';
  await opted.discover();
  assert.equal((await opted.provider.capabilities())[0].availability, 'unknown');
  assert.equal((await opted.workerProvider.submit(intent(), signal())).kind, 'accepted');
  assert.equal((await held.workerProvider.submit(intent(), signal())).kind, 'blocked');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});

test('the H3-only decision does not change other models or manufacture capability, controls or cost', async t => {
  const f = await fixture(t);
  f.setModels(['fixture/other']);
  for (const policy of [undefined, allowRetention]) {
    const bridge = createProviderBridge(noDatabase, noMedia, scope, () => 'SYNTHETIC-FIXTURE-KEY', f.transport, policy);
    await bridge.discover();
    const capabilities = await bridge.provider.capabilities();
    assert.equal(capabilities.find(c => c.modelId === H3)!.availability, policy ? 'unknown' : 'blocked');
    assert.equal(capabilities.find(c => c.modelId === 'fixture/other')!.availability, 'unknown');
    const other = await prepare(bridge, {...shot, controls: {...shot.controls, modelId: 'fixture/other'}});
    assert.ok(other.envelope);
    assert.equal(other.estimatedCostUsd, null);
    assert.deepEqual(other.blockers.map(b => typeof b === 'string' ? b : b.code), ['ENTITLEMENT_UNKNOWN']);
    assert.equal((await bridge.workerProvider.submit(intent('fixture/other'), signal())).kind, 'accepted');
    const absent = await prepare(bridge, {...shot, controls: {...shot.controls, modelId: 'fixture/absent'}});
    assert.equal(absent.envelope, null);
    assert.match(String(absent.blockers[0]), /absent from the verified catalog/);
    const invalid = await prepare(bridge, {...shot, controls: {...shot.controls, durationSeconds: 6}});
    assert.equal(invalid.envelope, null);
    assert.ok(invalid.blockers.some(b => typeof b === 'string' && /catalog-supported positive duration/.test(b)));
  }
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 2);
  assert.ok(f.requests.filter(r => r.method === 'POST').every(r => JSON.parse(r.body).model === 'fixture/other'));
});

test('opt-in retains submit scope, credential, integrity, body-model and cancellation checks without dispatch', async t => {
  const f = await fixture(t);
  const bridge = createProviderBridge(noDatabase, noMedia, scope, () => 'SYNTHETIC-FIXTURE-KEY', f.transport, allowRetention);
  const wrongScope = intent(); wrongScope.request.scope = 'other-scope';
  await assert.rejects(bridge.workerProvider.submit(wrongScope, signal()), /REQUEST_SCOPE/);
  const wrongProvider = intent(); wrongProvider.request.provider = 'other-provider';
  await assert.rejects(bridge.workerProvider.submit(wrongProvider, signal()), /REQUEST_SCOPE/);
  const wrongHash = intent(); wrongHash.request.bodySha256 = '0'.repeat(64);
  const wrongModel = intent(); wrongModel.request.modelId = 'fixture/other';
  for (const dispatch of [wrongHash, wrongModel]) {
    const result = await bridge.workerProvider.submit(dispatch, signal());
    assert.equal(result.kind, 'rejected'); assert.ok('issue' in result);
    assert.equal(result.issue.code, 'request_integrity_mismatch');
  }
  const invalidBody = intent(); invalidBody.request.body = JSON.stringify({model: H3});
  invalidBody.request.bodySha256 = sha256(invalidBody.request.body);
  await assert.rejects(bridge.workerProvider.submit(invalidBody, signal()));
  const cancelled = new AbortController(); cancelled.abort();
  const result = await bridge.workerProvider.submit(intent(), cancelled.signal);
  assert.equal(result.kind, 'rejected'); assert.ok('issue' in result);
  assert.equal(result.issue.code, 'provider_aborted');
  for (const key of ['', 'not a valid key']) {
    const invalidKey = createProviderBridge(noDatabase, noMedia, scope, () => key, f.transport, allowRetention);
    const denied = await invalidKey.workerProvider.submit(intent(), signal());
    assert.equal(denied.kind, 'blocked'); assert.ok('issue' in denied);
    assert.equal(denied.issue.code, 'provider_authentication_required');
  }
  assert.deepEqual(f.requests, []);
});

test('accepted H3 receipts retain scoped status and content handoff under default hold and explicit opt-in', async t => {
  const f = await fixture(t);
  const receipt:ProviderReceipt = {provider: 'openrouter', scope, modelId: H3, providerJobId: 'fixture-h3-job'};
  // This is a checkpoint fixture, not acceptance evidence from a real account.
  const pool = {async query(sql:string, values:unknown[]) {
    assert.match(sql, /flume\.worker_checkpoints/);
    assert.equal(values[1], scope);
    return {rows: values[0] === receipt.providerJobId ? [{state: {request: intent().request}}] : []};
  }} as unknown as Pool;
  let consumed = 0;
  const media:Pick<MediaStore, 'openAsset'|'importGeneratedOutput'> = {
    async openAsset() {throw Object.assign(new Error('Fixture cache miss'), {code: 'ENOENT'});},
    async importGeneratedOutput(input, body) {
      const chunks:Buffer[] = []; for await (const chunk of body) chunks.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(chunks), contentBytes); consumed++;
      assert.equal(input.claimedMime, 'video/mp4');
      assert.deepEqual(input.remoteIdentity, {provider: 'openrouter', jobId: `${sha256(scope)}:${receipt.providerJobId}`, outputId: '0'});
      const asset:Asset = {id: generatedAssetId(input.projectId, input.remoteIdentity), projectId: input.projectId,
        filename: input.filename, kind: 'video', origin: 'generated', sha256: sha256(contentBytes), mediaUrl: '',
        width: 16, height: 16, mimeType: 'video/mp4', size: contentBytes.length};
      return asset; // The media port is a byte-handoff fixture; no native-decode claim.
    },
  };
  for (const policy of [undefined, allowRetention]) {
    const bridge = createProviderBridge(pool, media as MediaStore, scope, () => 'SYNTHETIC-FIXTURE-KEY', f.transport, policy);
    assert.deepEqual(await bridge.workerProvider.status(receipt, signal()), {kind: 'succeeded', receipt});
    const outputs = await bridge.workerProvider.outputs(receipt, signal());
    assert.equal(outputs.kind, 'outputs'); assert.ok('outputs' in outputs);
    assert.deepEqual(outputs.outputs, [{outputId: '0', url: `${f.transport.baseUrl}/videos/fixture-h3-job/content?index=0`}]);
    const input = {projectId: shot.projectId, attemptId: shot.id, receipt, output: outputs.outputs[0], importKey: 'controlled-import'};
    const owned = await bridge.workerMedia.ownOutput(input, signal());
    assert.equal(owned.sha256, sha256(contentBytes));
    assert.equal(owned.byteLength, contentBytes.length);
    const readCount = f.requests.length;
    for (const bad of [
      {...receipt, scope: 'another-account-scope'}, {...receipt, provider: 'other-provider'},
      {...receipt, modelId: 'fixture/other'}, {...receipt, providerJobId: 'missing-job'},
    ]) {
      await assert.rejects(bridge.workerProvider.status(bad, signal()), /RECEIPT_(SCOPE|IDENTITY)/);
      await assert.rejects(bridge.workerProvider.outputs(bad, signal()), /RECEIPT_(SCOPE|IDENTITY)/);
      await assert.rejects(bridge.workerMedia.ownOutput({...input, receipt: bad}, signal()), /RECEIPT_(SCOPE|IDENTITY)/);
    }
    for (const output of [
      {...input.output, outputId: '00'}, {...input.output, outputId: '8'},
      {...input.output, url: `${f.transport.baseUrl}/videos/another-job/content?index=0`},
    ]) await assert.rejects(bridge.workerMedia.ownOutput({...input, output}, signal()), /CONTENT_IDENTITY/);
    assert.equal(f.requests.length, readCount, 'Identity failures must stop before network I/O');
    const unkeyed = createProviderBridge(pool, media as MediaStore, scope, undefined, f.transport, policy);
    assert.equal((await unkeyed.workerProvider.status(receipt, signal())).kind, 'unavailable');
    assert.equal((await unkeyed.workerProvider.outputs(receipt, signal())).kind, 'unavailable');
    await assert.rejects(unkeyed.workerMedia.ownOutput(input, signal()), /PROVIDER_NOT_CONFIGURED/);
    assert.equal(f.requests.length, readCount);
  }
  assert.equal(consumed, 2);
  assert.equal(f.requests.length, 6);
  assert.ok(f.requests.every(r => r.method === 'GET' && r.auth === 'Bearer SYNTHETIC-FIXTURE-KEY'));
});

test('ordinary service approval and submission remain blocked for default hold or opted-in unknown entitlement', async t => {
  const f = await fixture(t);
  const db = await ownedPostgres();
  try {
    await migrate(db.pool);
    const actor = {id: randomUUID(), kind: 'operator' as const, projectIds: '*' as const};
    for (const policy of [undefined, allowRetention]) {
      const bridge = createProviderBridge(db.pool, noMedia, scope, () => 'SYNTHETIC-FIXTURE-KEY', f.transport, policy);
      await bridge.discover();
      const service = createCommandService({pool: db.pool, provider: bridge.provider, workerAvailable: true});
      const send = (command:object) => service.command(actor, {commandId: randomUUID(), ...command});
      const {projectId} = await send({type: 'project.create', name: 'Controlled privacy fixture', brief: 'No real provider calls'});
      const {resourceId:shotId} = await send({type: 'shot.create', projectId, title: 'Fixture', prompt: shot.prompt});
      const {reviewId} = await send({type: 'generation.prepare', projectId, shotId, expectedRevision: 1});
      const review = (await service.getWorkspace(actor, projectId)).reviews[0];
      assert.equal(review.estimatedCostUsd, null);
      assert.equal(review.approved, false);
      assert.deepEqual(review.blockers.map(b => b.code), [policy ? 'ENTITLEMENT_UNKNOWN' : 'provider_privacy_blocked']);
      await assert.rejects(send({type: 'generation.approve', projectId, reviewId, maxAttempts: 1, maxCostUsd: null}), {code: 'GENERATION_BLOCKED'});
      await assert.rejects(send({type: 'generation.submit', projectId, reviewId}), {code: 'GENERATION_BLOCKED'});
    }
    for (const table of ['approvals', 'attempts', 'outbox', 'worker_receipts']) {
      assert.equal((await db.pool.query(`SELECT count(*)::int n FROM flume.${table}`)).rows[0].n, 0);
    }
    assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
  } finally {await db.close();}
});
