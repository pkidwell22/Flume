import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, get } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, sha } from './support.ts';
import { DEFAULT_LIMITS } from '../src/index.ts';
import * as download from '../src/download.ts';

test('download policy rejects local, mapped, metadata and redirect targets before any network IO', async () => {
  const d = await import('../src/download.ts').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return null; throw e; });
  assert.equal(typeof d?.validateRemoteUrl, 'function', 'explicit SSRF guard required');
  const policy = { allowedHosts: ['media.example.com'] };
  for (const url of ['http://media.example.com/file', 'https://user:password@media.example.com/file', 'https://media.example.com:8443/file', 'https://127.0.0.1/file', 'https://[::1]/file', 'https://media.example.com.evil.test/file', 'file:///etc/passwd']) assert.throws(() => d!.validateRemoteUrl(url, policy), /REMOTE_URL_REJECTED/);
  for (const ip of ['0.0.0.0','10.1.2.3','100.64.1.1','127.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','192.0.2.1','198.18.0.1','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001::1','2001:100::1','3fff::1','2001:db8::1','2002:7f00:1::']) assert.equal(d!.isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888']) assert.equal(d!.isPublicAddress(ip), true, ip);
});

test('bounded download follows only validated redirects, pins DNS and sends no provider credentials', async t => {
  const f = await fixture(t); const bytes = await readFile(f.video);
  const received: any[] = []; const pins: any[] = [];
  const server = createServer((req, res) => {
    received.push(req.headers);
    if (req.url === '/redirect') { res.writeHead(302, { location: 'https://media.example.com/file' }); res.end(); }
    else if (req.url === '/escape') { res.writeHead(302, { location: 'https://169.254.169.254/private' }); res.end(); }
    else if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); }
    else if (req.url === '/big') { res.writeHead(200, { 'content-length': '9999999999' }); res.end(); }
    else { res.writeHead(200, { 'content-type': 'video/x-matroska', 'content-length': bytes.length }); res.end(bytes); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as any).port;
  // Only this internal test transport maps public-named requests to an owned loopback fixture.
  // The package entry point cannot inject transport or disable TLS/DNS policy.
  const transport = {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    async get(url: URL, pin: any, headers: Record<string,string>, signal: AbortSignal) {
      pins.push(pin);
      return new Promise<any>((resolve, reject) => {
        const req = get({ host: '127.0.0.1', port, path: url.pathname, headers, signal }, res => resolve({ statusCode: res.statusCode, headers: res.headers, body: res, close: () => res.destroy() })); req.on('error', reject);
      });
    },
  };
  const policy = { allowedHosts: ['media.example.com'], maxRedirects: 2 };
  assert.equal(typeof download.downloadToFile, 'function', 'bounded redirect-safe retrieval required');
  const output = join(f.dir, 'downloaded');
  await download.downloadToFile('https://media.example.com/redirect', policy, output, DEFAULT_LIMITS, transport);
  assert.equal(sha(await readFile(output)), sha(bytes)); assert.equal(received.length, 2);
  assert.ok(received.every(h => !h.authorization && !h.cookie && !h.referer)); assert.ok(pins.every(p => p.address === '8.8.8.8'));
  await assert.rejects(download.downloadToFile('https://media.example.com/escape', policy, join(f.dir, 'escape'), DEFAULT_LIMITS, transport), /REMOTE_URL_REJECTED/);
  await assert.rejects(download.downloadToFile('https://media.example.com/loop', policy, join(f.dir, 'loop'), DEFAULT_LIMITS, transport), /REDIRECT_LIMIT/);
  await assert.rejects(download.downloadToFile('https://media.example.com/big', policy, join(f.dir, 'big'), DEFAULT_LIMITS, transport), /BYTE_LIMIT/);
  const count = received.length;
  await assert.rejects(download.downloadToFile('https://media.example.com/file', policy, join(f.dir, 'private'), DEFAULT_LIMITS, { ...transport, resolve: async () => [{ address: '127.0.0.1', family: 4 }] }), /PRIVATE_ADDRESS/);
  assert.equal(received.length, count, 'unsafe DNS never reaches HTTP');
});

test('download timeout waits for its file writer cleanup before returning failure', async t => {
  const f = await fixture(t); let returned = false, closed = false, next = 0;
  // Fix wall-clock reads so the outer deadline is observably earlier than the writer's timer.
  t.mock.method(Date, 'now', () => 0);
  const body = { [Symbol.asyncIterator]() { return {
    next: (): Promise<IteratorResult<Uint8Array>> => next++ === 0 ? Promise.resolve({ value: Buffer.from([1]), done: false }) : new Promise<IteratorResult<Uint8Array>>(() => {}),
    return: async (): Promise<IteratorResult<Uint8Array>> => { returned = true; return { value: undefined, done: true }; },
  }; } };
  await assert.rejects(download.downloadToFile('https://media.example.com/file', { allowedHosts: ['media.example.com'] }, join(f.dir, 'partial'),
    { ...DEFAULT_LIMITS, ingestTimeoutMs: 50 }, {
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      get: async () => ({ statusCode: 200, headers: {}, body, close: () => { closed = true; } }),
    }), /DOWNLOAD_TIMEOUT|INGEST_TIMEOUT/);
  assert.equal(returned, true, 'writer cleanup completes before caller may remove its staging directory');
  assert.equal(closed, true);
});
