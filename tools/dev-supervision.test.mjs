import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchDevelopment } from './dev.mjs';
import { runWorkspaceTask } from './dev-workspaces.mjs';
import { missingPostgresReason, resolveTestPgBin } from './dev-test-pg.mjs';

const exists = path => stat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
async function until(check, message, milliseconds = 5000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  throw new Error(message);
}

// Resolved once per module: PG_BIN -> pg_config --bindir -> (darwin) /opt/homebrew/bin -> PATH.
// Absent PostgreSQL makes the real-store tests below SKIP (never silently pass) on any platform.
const pgBin = await resolveTestPgBin();
const withoutPostgres = pgBin ? undefined : missingPostgresReason();

// Newly created real PG; HTTP and npm wrappers are process doubles, never providers.
async function fixture(t, stdio, injectRefusal = false) {
  const root = await mkdtemp(join(tmpdir(), 'review-launcher-'));
  const bin = join(root, 'bin'); await mkdir(bin);
  const oldPath = process.env.PATH; let app; const pids = [];
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    await writeFile(join(root, 'release-all'), 'release');
    try { await app?.stop(); } catch { /* Preserve the actual failed stop as evidence. */ }
    await app?.store.stop();
    process.env.PATH = oldPath;
    await until(() => pids.every(pid => !alive(pid)), 'review fixture processes exit');
    await rm(root, { recursive: true, force: true });
    t.diagnostic(JSON.stringify({ root, pids, allDead: pids.every(pid => !alive(pid)), rootRemoved: !(await exists(root)) }));
  });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'review-owned-fixture', private: true }));
  for (const name of ['server', 'web']) {
    const dir = join(root, 'apps', name); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@flume/' + name, scripts: { dev: 'fixture-only' } }));
    await writeFile(join(dir, 'child.cjs'), `
      const fs = require('node:fs'), root = ${JSON.stringify(root)}, name = ${JSON.stringify(name)};
      const server = require('node:http').createServer((req,res) => res.end('owned fixture'));
      server.listen(Number(process.env.PORT), '127.0.0.1');
      fs.writeFileSync(root + '/child-' + name + '.json', JSON.stringify({pid:process.pid}));
      process.on('SIGTERM', () => server.close(() => process.exit(0)));
      setInterval(() => { if (fs.existsSync(root+'/release-all')) process.exit(0); }, 10);
      setTimeout(() => process.exit(99), 15000);
    `);
  }
  await writeFile(join(bin, 'npm'), `#!${process.execPath}\n
    const fs=require('node:fs'), root=${JSON.stringify(root)}, name=require('node:path').basename(process.cwd());
    if (!['server','web'].includes(name)) process.exit(96);
    require('node:child_process').spawn(process.execPath,['child.cjs'],{stdio:${JSON.stringify(stdio)}});
    fs.writeFileSync(root+'/wrapper-'+name+'.json',JSON.stringify({pid:process.pid}));
    process.on('SIGTERM',()=>process.exit(0));
    setInterval(()=>{if(fs.existsSync(root+'/wrapper-exit-'+name))process.exit(7);if(fs.existsSync(root+'/release-all'))process.exit(0);},10);
    setTimeout(()=>process.exit(99),15000);
  `, { mode: 0o700 });
  process.env.PATH = `${bin}:${oldPath}`;
  if (injectRefusal) {
    const spawn = childProcess.spawn;
    t.mock.method(childProcess, 'spawn', (command, args, options) => {
      // Test-only source instrumentation: the actual self-group SIGTERM moved
      // into the pin. Deny it only in this fixture's server pin, not PostgreSQL,
      // other groups, membership probes or later native calls. Oracles unchanged.
      if (options?.cwd === join(root, 'apps/server') && args?.[1]?.includes('groupAnchor')) {
        const needle = "process.kill(0, 'SIGTERM')";
        assert.equal(args[1].split(needle).length, 2);
        args = [...args];
        args[1] = args[1].replace(needle, "(() => { throw Object.assign(new Error('review-owned signal refusal'), { code: 'EPERM' }); })()");
      }
      const child = spawn(command, args, options);
      if (args?.[1]?.includes('groupAnchor') && child.pid) pids.push(child.pid);
      return child;
    });
    syncBuiltinESMExports();
  }
  app = await launchDevelopment({ root, pgBin, apiPort: 0, webPort: 0, install: false, build: false });
  const ids = {};
  for (const name of ['server', 'web']) for (const kind of ['wrapper', 'child']) {
    ids[kind + '-' + name] = JSON.parse(await readFile(join(root, `${kind}-${name}.json`), 'utf8')).pid;
    pids.push(ids[kind + '-' + name]);
  }
  pids.push(app.store.pid);
  await writeFile(join(app.store.mediaRoot, 'sentinel'), 'preserve these owned bytes');
  return { root, app, ids };
}

for (const stdio of ['ignore', 'inherit']) test(`natural wrapper exit is supervised with ${stdio} descendant stdio`, { skip: withoutPostgres }, async t => {
  const { root, app, ids } = await fixture(t, stdio);
  const outcome = app.done.then(() => ({ settled: true, error: null }), error => ({ settled: true, error: error.message }));
  await writeFile(join(root, 'wrapper-exit-server'), 'exit naturally without signalling');
  await until(() => !alive(ids['wrapper-server']), 'server wrapper has actually exited');
  const result = await Promise.race([outcome, delay(1000).then(() => ({ settled: false }))]);
  t.diagnostic(JSON.stringify({ scenario: 'natural-wrapper-exit', stdio, ...result, descendantAlive: alive(ids['child-server']), postgresAlive: alive(app.store.pid), lockExists: await exists(join(root, '.flume/store.lock')) }));
  assert.equal(result.settled, true, 'wrapper exit must trigger supervision even while descendants retain its pipes');
  assert.match(result.error, /server exited unexpectedly/);
  assert.equal(alive(ids['child-server']), false);
  assert.equal(await readFile(join(app.store.mediaRoot, 'sentinel'), 'utf8'), 'preserve these owned bytes');
});

test('service termination uncertainty retains store lock rather than merely claiming retention', { skip: withoutPostgres }, async t => {
  const { root, app, ids } = await fixture(t, 'ignore', true);
  const lockPath = join(root, '.flume/store.lock'); const lock = await readFile(lockPath, 'utf8');
  const kill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid, signal) => {
    // Deny only a signal to this new fixture's known server process group.
    if (pid === -ids['wrapper-server'] && signal === 'SIGTERM') throw Object.assign(new Error('review-owned signal refusal'), { code: 'EPERM' });
    return kill(pid, signal);
  });
  let failure;
  try { await app.stop(); } catch (error) { failure = error; }
  assert.equal(failure?.name, 'AggregateError');
  assert.match(failure.message, /retained/);
  assert.equal(alive(ids['child-server']), true, 'fixture proves a service is still alive');
  assert.equal(await readFile(join(app.store.mediaRoot, 'sentinel'), 'utf8'), 'preserve these owned bytes');
  const lockExists = await exists(lockPath);
  t.diagnostic(JSON.stringify({ scenario: 'service-stop-refusal', error: failure.message, causes: failure.errors.map(error => error.message), lockExists, postgresAlive: alive(app.store.pid), descendantAlive: alive(ids['child-server']) }));
  assert.equal(lockExists, true, 'uncertain owned service shutdown must not unlock the store');
  assert.equal(await readFile(lockPath, 'utf8'), lock);
});

test('successful natural build wrapper exit waits for its held descendant', async t => {
  const root = await mkdtemp(join(tmpdir(), 'review-build-natural-'));
  const bin = join(root, 'bin'); const dir = join(root, 'packages/fixture');
  await mkdir(bin); await mkdir(dir, { recursive: true });
  const oldPath = process.env.PATH; let pending; const pids = [];
  t.after(async () => {
    await writeFile(join(root, 'release'), 'release'); await pending?.catch(() => {}); process.env.PATH = oldPath;
    await until(() => pids.every(pid => !alive(pid)), 'natural build cleanup');
    await rm(root, { recursive: true, force: true });
    t.diagnostic(JSON.stringify({ root, pids, allDead: pids.every(pid => !alive(pid)), rootRemoved: !(await exists(root)) }));
  });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@flume/fixture', scripts: { build: 'fixture-only' } }));
  const child = `const fs=require('node:fs'),root=${JSON.stringify(root)};process.on('SIGTERM',()=>{});fs.writeFileSync(root+'/child.json',JSON.stringify({pid:process.pid}));setInterval(()=>{if(fs.existsSync(root+'/release'))process.exit(0);},10);setTimeout(()=>process.exit(99),6000);`;
  await writeFile(join(bin, 'npm'), `#!${process.execPath}\nconst fs=require('node:fs'),root=${JSON.stringify(root)};require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});fs.writeFileSync(root+'/wrapper.json',JSON.stringify({pid:process.pid}));setInterval(()=>{if(fs.existsSync(root+'/close-wrapper'))process.exit(0);},10);setTimeout(()=>process.exit(99),6000);`, { mode: 0o700 });
  process.env.PATH = `${bin}:${oldPath}`;
  pending = runWorkspaceTask(root, 'build'); let settled = false; pending.then(() => { settled = true; }, () => { settled = true; });
  await until(() => exists(join(root, 'child.json')), 'natural build child started');
  for (const name of ['wrapper', 'child']) pids.push(JSON.parse(await readFile(join(root, name + '.json'), 'utf8')).pid);
  await writeFile(join(root, 'close-wrapper'), 'success'); await until(() => !alive(pids[0]), 'wrapper exited successfully');
  await delay(100); assert.equal(alive(pids[1]), true); assert.equal(settled, false, 'successful wrapper close must not release its held group');
  await writeFile(join(root, 'release'), 'release'); await pending;
  await until(() => pids.every(pid => !alive(pid)), 'successful build descendants exited');
});
