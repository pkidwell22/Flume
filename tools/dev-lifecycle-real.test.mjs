import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchDevelopment } from './dev.mjs';
import { openLocalStore, resolvePgBin } from './dev-store.mjs';

const exec = promisify(execFile);
const exists = path => stat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
async function until(check, message) { for (let i = 0; i < 400; i++) { if (await check()) return; await delay(20); } throw new Error(message); }
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function sql(store, statement, pgBin) {
  const url = new URL(store.databaseUrl);
  const result = await exec(join(pgBin, 'psql'), ['--no-psqlrc', '--no-align', '--tuples-only', '--set', 'ON_ERROR_STOP=1', '--command', statement], {
    env: { PATH: process.env.PATH, LC_ALL: 'C', PGHOST: url.hostname, PGPORT: url.port, PGUSER: url.username, PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: 'flume' }, timeout: 3000,
  });
  return result.stdout.trim();
}

// Real newly-owned PostgreSQL; HTTP/migration children are explicitly local fixtures.
test('real owned PG retains SQL/media through startup cancellation, failure, ready abort and reopen', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flume-lifecycle-real-'));
  const pgBin = await resolvePgBin(); const pids = []; const phases = [];
  const controllers = []; const starts = []; const owners = [];
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    for (const start of starts) { const app = await start.catch(() => null); if (app) await app.stop(); }
    for (const owner of owners.reverse()) await owner.stop();
    await until(() => pids.every(pid => !alive(pid)), 'all recorded owned PIDs stop');
    await rm(root, { recursive: true, force: true });
    assert.equal(await exists(root), false);
    t.diagnostic(JSON.stringify({ root, pgBin, pids, phases, allDead: pids.every(pid => !alive(pid)), rootRemoved: true }));
  });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'real-pg-launcher-fixture', private: true, workspaces: ['apps/*', 'packages/*'] }));
  for (const name of ['server', 'web']) {
    const directory = join(root, 'apps', name); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `@flume/${name}`, version: '0.1.0', scripts: { dev: 'node fixture.cjs' } }));
    await writeFile(join(directory, 'fixture.cjs'), `
      const fs = require('node:fs'); const root = ${JSON.stringify(root)}; const name = ${JSON.stringify(name)};
      if (name === 'web' && fs.existsSync(root + '/fail-web')) process.exit(7);
      fs.writeFileSync(root + '/' + name + '.json', JSON.stringify({ pid: process.pid }));
      const server = require('node:http').createServer((req, res) => res.end('local fixture'));
      server.listen(Number(process.env.PORT), '127.0.0.1');
      process.on('SIGTERM', () => server.close(() => process.exit(0)));
    `);
  }
  const db = join(root, 'packages/database'); await mkdir(db, { recursive: true });
  await writeFile(join(db, 'package.json'), JSON.stringify({ name: '@flume/database', version: '0.1.0', scripts: { migrate: 'node fixture.cjs' } }));
  await writeFile(join(db, 'fixture.cjs'), `
    const fs = require('node:fs'); const root = ${JSON.stringify(root)};
    if (fs.existsSync(root + '/hold-migration')) {
      fs.writeFileSync(root + '/migration.json', JSON.stringify({ pid: process.pid }));
      setTimeout(() => process.exit(99), 6000);
    }
  `);
  const seed = await openLocalStore({ root, pgBin }); owners.push(seed); pids.push(seed.pid);
  assert.equal(await sql(seed, 'SELECT current_database()', pgBin), 'flume');
  await sql(seed, "CREATE SCHEMA proof; CREATE TABLE proof.persisted(value text); INSERT INTO proof.persisted VALUES ('unchanged after cancellation and failure');", pgBin);
  const mediaPath = join(seed.mediaRoot, 'fixture-sentinel'); await writeFile(mediaPath, 'owned persistent fixture bytes');
  const markerHash = hash(await readFile(join(root, '.flume/store.json')));
  const mediaHash = hash(await readFile(mediaPath));
  await seed.stop(); assert.equal(alive(seed.pid), false);
  phases.push({ phase: 'seed-normal-stop', pid: seed.pid });

  async function capturePostgres() {
    const lines = (await readFile(join(root, '.flume/postgres/postmaster.pid'), 'utf8')).split('\n');
    assert.equal(lines[1], join(root, '.flume/postgres'));
    const pid = Number(lines[0]); assert.equal(alive(pid), true); pids.push(pid); return pid;
  }
  async function preservedAndStopped() {
    assert.equal(await exists(join(root, '.flume/store.lock')), false);
    assert.equal(await exists(join(root, '.flume/postgres/postmaster.pid')), false);
    assert.equal(hash(await readFile(join(root, '.flume/store.json'))), markerHash);
    assert.equal(hash(await readFile(mediaPath)), mediaHash);
    assert.equal(await exists(join(root, '.flume/postgres/PG_VERSION')), true);
    await until(() => pids.every(pid => !alive(pid)), 'owned PIDs must die before fallback cleanup');
  }
  function launch(controller) {
    controllers.push(controller);
    const start = launchDevelopment({ root, pgBin, apiPort: 0, webPort: 0, build: false, install: false, signal: controller.signal });
    starts.push(start); void start.catch(() => {}); return start;
  }
  await writeFile(join(root, 'hold-migration'), 'hold');
  const cancelled = new AbortController(); const pending = launch(cancelled);
  await until(() => exists(join(root, 'migration.json')), 'real PG startup reached held migration');
  const cancelledPg = await capturePostgres();
  const migration = JSON.parse(await readFile(join(root, 'migration.json'), 'utf8')).pid; pids.push(migration);
  cancelled.abort(); await assert.rejects(pending, /abort/i);
  await preservedAndStopped();
  phases.push({ phase: 'startup-cancel', pgPid: cancelledPg, migrationPid: migration });
  await rm(join(root, 'hold-migration'));

  await writeFile(join(root, 'fail-web'), 'fail');
  const failed = launch(new AbortController());
  await until(() => exists(join(root, 'server.json')), 'first HTTP fixture started');
  const failedPg = await capturePostgres();
  const failedServer = JSON.parse(await readFile(join(root, 'server.json'), 'utf8')).pid; pids.push(failedServer);
  await assert.rejects(failed, /web.*exited/);
  await preservedAndStopped();
  phases.push({ phase: 'second-service-failure', pgPid: failedPg, serverPid: failedServer });
  await rm(join(root, 'fail-web'));

  const ready = new AbortController(); const app = await launch(ready);
  pids.push(app.store.pid);
  for (const name of ['server', 'web']) pids.push(JSON.parse(await readFile(join(root, `${name}.json`), 'utf8')).pid);
  assert.equal((await fetch(app.apiUrl + '/api/health')).status, 200);
  assert.equal(await sql(app.store, 'SELECT value FROM proof.persisted', pgBin), 'unchanged after cancellation and failure');
  ready.abort(); await app.done; await app.stop();
  await preservedAndStopped();
  phases.push({ phase: 'ready-abort', pgPid: app.store.pid, apiUrl: app.apiUrl, webUrl: app.webUrl });

  const reopened = await openLocalStore({ root, pgBin }); owners.push(reopened); pids.push(reopened.pid);
  assert.equal(await sql(reopened, 'SELECT value FROM proof.persisted', pgBin), 'unchanged after cancellation and failure');
  await reopened.stop(); await preservedAndStopped();
  phases.push({ phase: 'reopen-readback-stop', pgPid: reopened.pid, markerHash, mediaHash, sqlPreserved: true });
});
