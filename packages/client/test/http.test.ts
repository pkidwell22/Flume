import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { emptyWorkspace } from '@flume/domain';
import * as api from '../src/index.js';

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
}

test('typed client reads real HTTP DTOs, validates project UUIDs and submits the literal command exactly once', async () => {
  assert.ok('FlumeClient' in api, 'FlumeClient is exported');
  const requests: Array<{ method: string; path: string; body: string; headers: IncomingMessage['headers'] }> = [];
  const project = { id: '00000001-0000-4000-8000-000000000001', name: 'Film', brief: '', revision: 0 };
  const command = { type: 'shot.update', commandId: '42B3DC54-6022-473E-94F2-2417A5AE42E4', projectId: '00000001-0000-4000-8000-000000000001', shotId: '00000002-0000-4000-8000-000000000002', expectedRevision: 0, patch: { bindings: { lastFrameAssetId: null }, controls: { seed: 0, generateAudio: false } } };
  const receipt = { commandId: command.commandId, projectId: '00000001-0000-4000-8000-000000000001', resourceId: '00000002-0000-4000-8000-000000000002', revision: 1 };
  const server = await serve((req, res) => {
    let body = ''; req.setEncoding('utf8'); req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      requests.push({ method: req.method!, path: req.url!, body, headers: req.headers });
      json(res, req.url === '/api/projects' ? [project] : req.url?.startsWith('/api/workspace') ? emptyWorkspace() : receipt);
    });
  });
  try {
    const client = new (api as any).FlumeClient({ baseUrl: server.url });
    assert.deepEqual(await client.listProjects(), [project]);
    assert.throws(() => client.getWorkspace('p /&?'), /uuid/i);
    assert.equal(requests.length, 1, 'Malformed project ID must not dispatch');
    assert.deepEqual(await client.getWorkspace('AABBCCDD-0000-4000-8000-000000000001'), emptyWorkspace());
    assert.deepEqual(await client.command(command), receipt);
    assert.equal(requests.length, 3);
    assert.equal(requests[1]!.path, '/api/workspace?projectId=AABBCCDD-0000-4000-8000-000000000001');
    assert.deepEqual(JSON.parse(requests[2]!.body), command);
    assert.equal(requests[2]!.headers.authorization, undefined);
    assert.equal(requests[2]!.headers.cookie, undefined);
    assert.equal(requests[2]!.headers['content-type'], 'application/json');
  } finally { await server.close(); }
});

test('structured revision conflicts survive HTTP without a retry', async () => {
  let posts = 0;
  const server = await serve((_req, res) => { posts++; json(res, { code: 'revision_conflict', message: 'Reload', currentRevision: 4, details: { field: 'shot' } }, 409); });
  try {
    const client = new (api as any).FlumeClient({ baseUrl: server.url });
    await assert.rejects(client.command({ type: 'generation.prepare', commandId: '42B3DC54-6022-473E-94F2-2417A5AE42E4', projectId: '00000001-0000-4000-8000-000000000001', shotId: '00000002-0000-4000-8000-000000000002', expectedRevision: 0 }), (error: any) => {
      assert.equal(error.code, 'revision_conflict'); assert.equal(error.status, 409);
      assert.equal(error.currentRevision, 4); assert.deepEqual(error.details, { field: 'shot' });
      assert.equal(error.outcomeUnknown, false); return true;
    });
    assert.equal(posts, 1);
  } finally { await server.close(); }
});

test('invalid DTOs, oversized replies and lost POST responses fail closed without leaking payloads or retrying', async () => {
  let calls = 0;
  const server = await serve((req, res) => {
    calls++;
    if (req.method === 'POST') { req.resume(); req.on('end', () => req.socket.destroy()); return; }
    if (req.url === '/api/projects') { json(res, [{ privateToken: 'must-not-appear' }]); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(' '.repeat(3000));
  });
  try {
    const client = new (api as any).FlumeClient({ baseUrl: server.url, maxResponseBytes: 1024 });
    await assert.rejects(client.listProjects(), (e: any) => e.code === 'invalid_response' && !e.message.includes('must-not-appear'));
    await assert.rejects(client.getWorkspace(), (e: any) => e.code === 'response_too_large');
    await assert.rejects(client.command({ type: 'generation.submit', commandId: '42B3DC54-6022-473E-94F2-2417A5AE42E4', projectId: '00000001-0000-4000-8000-000000000001', reviewId: '00000003-0000-4000-8000-000000000003' }), (e: any) => e.code === 'network_error' && e.outcomeUnknown === true);
    assert.equal(calls, 3);
  } finally { await server.close(); }
});

test('timeouts and cancellation are bounded; pre-aborted writes never reach the server', async () => {
  let calls = 0;
  const server = await serve((_req, res) => { calls++; setTimeout(() => json(res, []), 150).unref(); });
  try {
    const client = new (api as any).FlumeClient({ baseUrl: server.url, timeoutMs: 30 });
    await assert.rejects(client.listProjects(), (e: any) => e.code === 'timeout' && !e.outcomeUnknown);
    const before = calls;
    await assert.rejects(client.command({ type: 'generation.submit', commandId: '42B3DC54-6022-473E-94F2-2417A5AE42E4', projectId: '00000001-0000-4000-8000-000000000001', reviewId: '00000003-0000-4000-8000-000000000003' }, { signal: AbortSignal.abort() }), (e: any) => e.code === 'aborted' && !e.outcomeUnknown);
    assert.equal(calls, before);
  } finally { await server.close(); }
});

test('agent commands reject approval/body claims before network and unsafe base URLs are rejected', async () => {
  let calls = 0;
  const client = new (api as any).FlumeClient({ fetch: async () => { calls++; throw new Error('unexpected network'); } });
  const input = { type: 'generation.approve', commandId: '42B3DC54-6022-473E-94F2-2417A5AE42E4', projectId: '00000001-0000-4000-8000-000000000001', reviewId: '00000003-0000-4000-8000-000000000003', maxAttempts: 1, maxCostUsd: '10' };
  await assert.rejects(async () => client.command(input), (e: any) => e.code === 'approval_requires_operator');
  await assert.rejects(async () => client.command({ ...input, type: 'generation.submit', actor: 'human' }), (e: any) => e.code === 'invalid_command');
  assert.equal(calls, 0);
  for (const baseUrl of ['https://user:secret@example.com', 'https://example.com/?key=secret', 'file:///etc/passwd', 'http://example.com', 'http://127.0.0.1:4311/api']) {
    assert.throws(() => new (api as any).FlumeClient({ baseUrl }), /origin|HTTPS/);
  }
});
