import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as development from './dev.mjs';

async function fixture(root, failingWeb = false) {
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'isolated-launcher-test', private: true, type: 'module', workspaces: ['apps/*'] }));
  for (const name of ['server', 'web']) {
    const directory = join(root, 'apps', name); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `@flume/${name}`, version: '0.1.0', type: 'module', scripts: { dev: 'node fixture.mjs' } }));
    await writeFile(join(directory, 'fixture.mjs'), failingWeb && name === 'web' ? 'process.exit(7);' : `
      import { createServer } from 'node:http';
      import { writeFileSync } from 'node:fs';
      const name = ${JSON.stringify(name)};
      writeFileSync('started.json', JSON.stringify({ pid: process.pid, host: process.env.HOST, port: process.env.PORT, databaseConfigured: !!process.env.DATABASE_URL, localOperator: process.env.FLUME_LOCAL_OPERATOR, origin: process.env.FLUME_ALLOWED_ORIGIN, target: process.env.FLUME_API_URL }));
      const server = createServer((req, res) => { res.setHeader('content-type', name === 'server' ? 'application/json' : 'text/html'); res.end(name === 'server' ? '{"ok":true}' : '<main>isolated launcher double</main>'); });
      server.listen(Number(process.env.PORT), process.env.HOST);
      process.on('SIGTERM', () => server.close(() => process.exit(0)));
    `);
  }
}

test('launcher verifies real loopback child readiness and stops only owned processes without erasing its store', async (t) => {
  assert.equal(typeof development.launchDevelopment, 'function');
  const root = await mkdtemp(join(tmpdir(), 'flume-dev-'));
  let app;
  t.after(async () => { try { await app?.stop(); } finally { await rm(root, { recursive: true, force: true }); } });
  await fixture(root);
  app = await development.launchDevelopment({ root, apiPort: 0, webPort: 0, build: false, install: false });
  assert.equal((await fetch(`${app.apiUrl}/api/health`)).status, 200);
  assert.match(await (await fetch(app.webUrl)).text(), /isolated launcher double/);
  const server = JSON.parse(await readFile(join(root, 'apps/server/started.json'), 'utf8'));
  const web = JSON.parse(await readFile(join(root, 'apps/web/started.json'), 'utf8'));
  assert.equal(server.host, '127.0.0.1'); assert.equal(web.host, '127.0.0.1');
  assert.equal(server.databaseConfigured, true); assert.equal(web.databaseConfigured, false);
  assert.equal(server.localOperator, '1'); assert.equal(server.origin, app.webUrl); assert.equal(web.target, app.apiUrl);
  await app.stop();
  for (const pid of [server.pid, web.pid, app.store.pid]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal((await stat(join(root, '.flume/postgres/PG_VERSION'))).isFile(), true);
  await assert.rejects(stat(join(root, '.flume/store.lock')), { code: 'ENOENT' });
});

test('failed second service cleans the first service and database while preserving initialized data', async (t) => {
  assert.equal(typeof development.launchDevelopment, 'function');
  const root = await mkdtemp(join(tmpdir(), 'flume-dev-fail-')); t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root, true);
  await assert.rejects(development.launchDevelopment({ root, apiPort: 0, webPort: 0, build: false, install: false }), /web.*exit|web.*failed/i);
  const server = JSON.parse(await readFile(join(root, 'apps/server/started.json'), 'utf8'));
  assert.throws(() => process.kill(server.pid, 0), { code: 'ESRCH' });
  await assert.rejects(stat(join(root, '.flume/postgres/postmaster.pid')), { code: 'ENOENT' });
  await assert.rejects(stat(join(root, '.flume/store.lock')), { code: 'ENOENT' });
  assert.equal((await stat(join(root, '.flume/postgres/PG_VERSION'))).isFile(), true);
});

test('missing integrated app packages fail preflight before creating a user store', async (t) => {
  assert.equal(typeof development.launchDevelopment, 'function');
  const root = await mkdtemp(join(tmpdir(), 'flume-dev-preflight-')); t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(development.launchDevelopment({ root, build: false, install: false }), /Missing.*@flume/);
  await assert.rejects(stat(join(root, '.flume')), { code: 'ENOENT' });
});

test('unexpected service death is reported as failure and tears down the remaining owned services', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'flume-dev-death-')); let app;
  t.after(async () => { try { await app?.stop(); } finally { await rm(root, { recursive: true, force: true }); } });
  await fixture(root);
  app = await development.launchDevelopment({ root, apiPort: 0, webPort: 0, build: false, install: false });
  const server = JSON.parse(await readFile(join(root, 'apps/server/started.json'), 'utf8'));
  const web = JSON.parse(await readFile(join(root, 'apps/web/started.json'), 'utf8'));
  const failed = assert.rejects(app.done, /server.*exit|server.*stopped/i);
  process.kill(server.pid, 'SIGTERM');
  await failed;
  assert.throws(() => process.kill(web.pid, 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(app.store.pid, 0), { code: 'ESRCH' });
});

test('startup cancellation stops a still-running migration before any application service is launched', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'flume-dev-cancel-')); let starting; const controller = new AbortController();
  t.after(async () => { controller.abort(); await starting?.then(app => app.stop(), () => {}); await rm(root, { recursive: true, force: true }); });
  await fixture(root);
  const db = join(root, 'packages/database'); await mkdir(db, { recursive: true });
  await writeFile(join(db, 'package.json'), JSON.stringify({ name: '@flume/database', version: '0.1.0', scripts: { migrate: 'node fixture.cjs' } }));
  await writeFile(join(db, 'fixture.cjs'), `require('node:fs').writeFileSync('started.json', JSON.stringify({ pid: process.pid })); setTimeout(() => process.exit(0), 1500);`);
  starting = development.launchDevelopment({ root, apiPort: 0, webPort: 0, build: false, install: false, signal: controller.signal });
  const failure = assert.rejects(starting, /abort|cancel/i);
  let child;
  for (let i = 0; i < 200; i++) {
    try { child = JSON.parse(await readFile(join(db, 'started.json'), 'utf8')); break; } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  assert.ok(child, 'the actual migration process started');
  controller.abort();
  // A held migration proves abort stops startup immediately rather than waiting for natural exit.
  await Promise.race([failure, new Promise((_, reject) => setTimeout(() => reject(new Error('Cancellation did not stop the owned migration promptly')), 700).unref())]);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  await assert.rejects(stat(join(root, '.flume/postgres/postmaster.pid')), { code: 'ENOENT' });
  await assert.rejects(stat(join(root, 'apps/server/started.json')), { code: 'ENOENT' });
});
