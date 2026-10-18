// Synthetic loopback fixture. Never a real provider, credential, or generated-product claim.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
export async function fixture(t) {
  let root, server;
  t.after(async () => {
    try { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
    finally { if (root) await rm(root, { recursive: true, force: true }); }
  });
  root = await mkdtemp(path.join(path.dirname(process.env.FLUME_WORKER_TEST_DIRECTORY), 'fm-')); await chmod(root, 0o700);
  const bytes = Buffer.concat([Buffer.from('P6\n2 2\n255\n'), Buffer.from([255,0,0, 0,255,0, 0,0,255, 255,255,255])]);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const f = { root, posts: [], reads: [], imports: 0, jobs: new Map(), running: false, drop: false, blocked: false,
    beforeSubmit: async () => {}, beforeReply: async () => {}, beforeImport: async () => {}, failImport: false };
  server = createServer(async (req, res) => {
    try {
      if (req.url === '/submit') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const intent = JSON.parse(Buffer.concat(chunks).toString());
        f.posts.push(intent); await f.beforeSubmit(intent);
        if (f.blocked) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ kind: 'blocked', issue: { code: 'zdr-violation-by-account', message: 'Account privacy settings exclude this endpoint.' } })); return; }
        const receipt = { provider: intent.request.provider, scope: intent.request.scope, modelId: intent.request.modelId, providerJobId: randomUUID() };
        f.jobs.set(intent.key, receipt); await f.beforeReply(receipt);
        if (f.drop) { req.socket.destroy(); return; }
        res.end(JSON.stringify({ kind: 'accepted', receipt })); return;
      }
      f.reads.push(req.url);
      if (req.url.startsWith('/lookup/')) { res.end(JSON.stringify(f.jobs.get(req.url.slice(8)) ?? null)); return; }
      if (req.url === '/bytes') { res.end(bytes); return; }
      const receipt = [...f.jobs.values()].find(r => req.url.endsWith(r.providerJobId));
      if (!receipt) { res.statusCode = 404; res.end('{}'); return; }
      if (req.url.startsWith('/status/')) res.end(JSON.stringify({ kind: f.running ? 'running' : 'succeeded', receipt }));
      else res.end(JSON.stringify({ kind: 'outputs', receipt, outputs: [{ outputId: 'output-0', url: f.origin + '/bytes', sha256: digest }] }));
    } catch (e) { f.serverError = e; res.destroy(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); f.origin = `http://127.0.0.1:${server.address().port}`;
  const json = async (url, signal, body) => (await fetch(f.origin + url, { signal, redirect: 'error', method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}) })).json();
  f.provider = {
    submit: (intent, signal) => json('/submit', signal, intent),
    status: (receipt, signal) => json('/status/' + receipt.providerJobId, signal),
    outputs: (receipt, signal) => json('/outputs/' + receipt.providerJobId, signal),
  };
  f.lookup = (intent, signal) => json('/lookup/' + intent.key, signal);
  f.media = { async ownOutput(input, signal) {
    f.imports++; if (f.failImport) throw new Error('injected owned-media failure');
    assert.equal(new URL(input.output.url).origin, f.origin);
    const target = path.join(root, input.importKey + '.ppm'); let owned;
    try { owned = await readFile(target); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      owned = Buffer.from(await (await fetch(input.output.url, { signal, redirect: 'error' })).arrayBuffer());
      assert.equal(createHash('sha256').update(owned).digest('hex'), digest);
      await writeFile(target, owned, { mode: 0o600, flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    }
    assert.equal(createHash('sha256').update(owned).digest('hex'), digest);
    await f.beforeImport(input);
    return { assetId: input.importKey, storageKey: path.basename(target), filename: 'synthetic-fixture.ppm', kind: 'image', sha256: digest, byteLength: owned.length, width: 2, height: 2 };
  } };
  return f;
}
export function barrier() {
  let reached, release; const hit = new Promise(resolve => { reached = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  return { hit, release, async pause() { reached(); await wait; } };
}
