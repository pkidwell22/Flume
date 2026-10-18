import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import * as api from '../src/index.js';

const command = { type: 'generation.approve', commandId: '42B3DC54-6022-473E-94F2-2417A5AE42E4', projectId: '00000001-0000-4000-8000-000000000001', reviewId: '00000003-0000-4000-8000-000000000003', maxAttempts: 1, maxCostUsd: '10.00' };
const receipt = { commandId: command.commandId, projectId: '00000001-0000-4000-8000-000000000001', reviewId: '00000003-0000-4000-8000-000000000003' };
const asset = { id: '00000004-0000-4000-8000-000000000004', projectId: '00000001-0000-4000-8000-000000000001', filename: 'start.png', kind: 'image', origin: 'imported', sha256: 'a'.repeat(64), mediaUrl: '/api/media/a', width: 2, height: 2 };

test('upload sends multipart file/projectId over the same API and rejects unsafe local metadata', async () => {
  let calls = 0; let received: FormData | undefined;
  const server = createServer(async (req, res) => {
    calls++;
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received = await new Request('http://127.0.0.1/api/assets', { method: 'POST', headers: { 'content-type': req.headers['content-type']! }, body: Buffer.concat(chunks) }).formData();
    assert.equal(req.url, '/api/assets');
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(asset));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const client = new (api as any).FlumeClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    assert.equal(typeof client.uploadAsset, 'function', 'bounded local upload is available');
    assert.deepEqual(await client.uploadAsset('00000001-0000-4000-8000-000000000001', new Blob(['owned source'], { type: 'image/png' }), 'start.png'), asset);
    assert.equal(received?.get('projectId'), '00000001-0000-4000-8000-000000000001');
    const file = received?.get('file'); assert.ok(file instanceof File);
    assert.equal(file.name, 'start.png'); assert.equal(await file.text(), 'owned source');
    for (const filename of ['../start.png', 'dir/start.png', 'dir\\start.png', '']) {
      await assert.rejects(client.uploadAsset('00000001-0000-4000-8000-000000000001', new Blob(['x']), filename), (e: any) => e.code === 'invalid_upload');
    }
    await assert.rejects(client.uploadAsset('00000001-0000-4000-8000-000000000001', new Blob([]), 'empty.png'), (e: any) => e.code === 'invalid_upload');
    await assert.rejects(client.uploadAsset('00000001-0000-4000-8000-000000000001', 'https://external.invalid/media', 'not-local.png'), (e: any) => e.code === 'invalid_upload');
    assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('browser factory uses only the current origin/session and never adds an actor or approval credential', async () => {
  assert.ok('createBrowserClient' in api, 'same-origin browser factory is exported');
  assert.throws(() => (api as any).createBrowserClient(), /browser/i);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'http://127.0.0.1:4310' } } });
  try {
    let calls = 0;
    const client = (api as any).createBrowserClient({ fetch: async (input: URL, init: RequestInit) => {
      calls++; assert.equal(input.origin, 'http://127.0.0.1:4310'); assert.equal(input.pathname, '/api/commands');
      assert.equal(init.credentials, 'same-origin'); assert.equal(init.redirect, 'error');
      assert.deepEqual(JSON.parse(init.body as string), command);
      assert.equal(new Headers(init.headers).has('authorization'), false);
      return Response.json(receipt);
    } });
    assert.deepEqual(await client.command(command), receipt);
    assert.equal(calls, 1);
  } finally { if (descriptor) Object.defineProperty(globalThis, 'window', descriptor); else Reflect.deleteProperty(globalThis, 'window'); }
});

test('a mismatched command receipt is not accepted as success', async () => {
  const client = new (api as any).FlumeClient({ fetch: async () => Response.json({ ...receipt, commandId: 'a9bdc7cf-58d4-450f-8d6e-4d794ae53821' }) });
  await assert.rejects(client.command({ type: 'generation.submit', commandId: command.commandId, projectId: '00000001-0000-4000-8000-000000000001', reviewId: '00000003-0000-4000-8000-000000000003' }), (e: any) => e.code === 'receipt_mismatch' && e.outcomeUnknown);
});

test('upload cannot publish an asset returned for a different project', async () => {
  const client = new api.FlumeClient({ fetch: async () => Response.json({ ...asset, projectId: '11111111-1111-4111-8111-111111111111' }) });
  await assert.rejects(client.uploadAsset('00000001-0000-4000-8000-000000000001', new Blob(['local']), 'start.png'), (e: any) => e.code === 'asset_project_mismatch' && e.outcomeUnknown);
});
