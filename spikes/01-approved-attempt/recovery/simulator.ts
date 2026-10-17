// Deliberately synthetic local HTTP provider, NOT a Comfy adapter or media fixture.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';

export const fixtureBytes = (slot: number) => Buffer.from(`SIMULATION ONLY; NOT MP4 OR PROVIDER MEDIA; output ${slot}\n`);
export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export async function startSimulator() {
  const calls: { method: string; path: string; key: string; account: string; route: string; body: string; remoteId: string | null }[] = [];
  const jobs = new Map<string, { id: string; key: string; account: string; route: string; body: string; state: string }>();
  const outputs: { remoteId: string; outputId: string; sha256: string }[] = [];
  const modes = { dropSubmit: false, rejectSubmit: false, partialDownload: false, pending: false, driftOutput: false };
  const server = http.createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; assert(body.length <= 4096); }
      const url = new URL(req.url!, 'http://127.0.0.1');
      const key = String(req.headers['idempotency-key'] || '');
      const account = String(req.headers['x-fixture-account'] || '');
      const route = String(req.headers['x-fixture-route'] || '');
      const event = { method: req.method!, path: url.pathname, key, account, route, body, remoteId: null as string | null };
      calls.push(event);
      const send = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      let job = [...jobs.values()].find(j => j.key === key && j.account === account && j.route === route);
      if (req.method === 'POST' && url.pathname === '/submit') {
        if (modes.rejectSubmit) { res.destroy(); return; }
        if (job && job.body !== body) { send({ error: 'key/body conflict' }, 409); return; }
        if (!job) {
          job = { id: randomUUID(), key, account, route, body, state: modes.pending ? 'running' : 'succeeded' };
          jobs.set(job.id, job);
          for (const slot of [0, 1]) outputs.push({ remoteId: job.id, outputId: `output-${slot}`, sha256: digest(fixtureBytes(slot)) });
        }
        event.remoteId = job.id;
        if (modes.dropSubmit) { modes.dropSubmit = false; res.destroy(); return; }
      } else if (url.pathname.startsWith('/jobs/')) {
        job = jobs.get(url.pathname.split('/')[2]!);
        if (job && (job.account !== account || job.route !== route || job.key !== key)) job = undefined;
        if (job) event.remoteId = job.id;
        if (job && req.method === 'POST' && url.pathname.endsWith('/cancel') && job.state === 'running') job.state = 'cancelled';
        if (job && url.pathname.includes('/outputs/')) {
          const slot = Number(url.pathname.split('/').at(-1));
          assert([0, 1].includes(slot));
          const bytes = fixtureBytes(slot);
          res.writeHead(200, { 'content-type': 'application/x-simulation', 'content-length': bytes.length });
          if (modes.partialDownload) {
            modes.partialDownload = false; res.write(bytes.subarray(0, 7));
            setImmediate(() => res.destroy()); return;
          }
          res.end(bytes); return;
        }
      } else if (url.pathname !== '/lookup') { send({ error: 'not found' }, 404); return; }
      if (!job) { send(null, 404); return; }
      event.remoteId = job.id;
      send({ version: 1, id: job.id, key: job.key, account: job.account, route: job.route, state: job.state,
        outputs: job.state === 'succeeded' ? [0, 1].map(slot => ({ id: `output-${slot}`,
          path: `/jobs/${job!.id}/outputs/${slot}`, sha256: modes.driftOutput && slot === 0 ? 'c'.repeat(64) : digest(fixtureBytes(slot)), size: fixtureBytes(slot).length })) : [] });
    } catch { res.destroy(); }
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); assert(address && typeof address === 'object');
    assert.equal(address.address, '127.0.0.1');
    return { origin: `http://127.0.0.1:${address.port}`, calls, jobs, outputs, modes,
      async close() {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        assert.equal(server.listening, false);
        console.log('CLEANUP verified: local simulator closed');
      } };
  } catch (error) { server.closeAllConnections(); server.close(); throw error; }
}
export type Simulator = Awaited<ReturnType<typeof startSimulator>>;
