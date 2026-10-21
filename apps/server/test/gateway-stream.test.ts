import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, get, type ClientRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { createGateway } from '../src/gateway.ts';

const listen = async (server: Server) => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); return address.port;
};
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

test('gateway propagates downstream stream cancellation to the upstream socket', { timeout: 5000 }, async t => {
  let closed!: () => void; const upstreamClosed = new Promise<void>(resolve => { closed = resolve; });
  const api = createServer((request, response) => {
    request.resume(); response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: delta\ndata: {"text":"fixture"}\n\n');
    response.once('close', closed);
  });
  let downstream: ClientRequest | undefined;
  const apiPort = await listen(api);
  const gateway = createGateway({ staticRoot: process.cwd(), apiPort, allowedHosts: ['gateway.test'] });
  t.after(async () => { downstream?.destroy(); await Promise.all([close(gateway), close(api)]); });
  const port = await listen(gateway);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    downstream = get({ hostname: '127.0.0.1', port, path: '/api/stream-fixture', headers: { Host: 'gateway.test' } }, response => {
      response.once('data', () => { resolve(response.statusCode); downstream!.destroy(); });
      response.on('error', () => {}); // Expected when this test deliberately closes the client.
    });
    downstream.once('error', reject);
  });
  assert.equal(status, 200);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([upstreamClosed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Upstream remained open after client cancellation')), 1500); })]); }
  finally { clearTimeout(timer); }
});
