import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openLocalStore } from './dev-store.mjs';
import { launchDevelopment } from './dev.mjs';

// Process doubles below are fault injection, NOT PostgreSQL infrastructure evidence.
async function until(check, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  throw new Error(message);
}
async function exists(path) { return stat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
async function executable(path, source) { await writeFile(path, `#!${process.execPath}\n${source}`, { mode: 0o700 }); }

test('cancelled initdb retains exclusive ownership until initializer and bootstrap child exit (process doubles)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flume-init-cancel-'));
  const bin = join(root, 'bin'); await mkdir(bin);
  const controller = new AbortController(); let starting; let pids = [];
  t.after(async () => {
    controller.abort(); await writeFile(join(root, 'release'), 'release');
    await starting?.catch(() => {});
    await until(() => pids.every(pid => !alive(pid)), 'fixture process cleanup');
    t.diagnostic(JSON.stringify({ root, pids, allDead: pids.every(pid => !alive(pid)) }));
    await rm(root, { recursive: true, force: true });
  });
  const bootstrap = `
    const fs = require('node:fs');
    const root = ${JSON.stringify(root)};
    process.on('SIGTERM', () => {});
    fs.writeFileSync(root + '/bootstrap.json', JSON.stringify({ pid: process.pid }));
    setInterval(() => { if (fs.existsSync(root + '/release')) process.exit(0); }, 10);
    setTimeout(() => process.exit(99), 6000);
  `;
  await executable(join(bin, 'initdb'), `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const root = ${JSON.stringify(root)};
    const data = process.argv[process.argv.indexOf('-D') + 1];
    fs.mkdirSync(data); fs.writeFileSync(data + '/sentinel', 'preserve partial initialization');
    process.on('SIGTERM', () => { fs.writeFileSync(root + '/term', 'received'); });
    spawn(process.execPath, ['-e', ${JSON.stringify(bootstrap)}], { stdio: 'ignore' });
    fs.writeFileSync(root + '/initializer.json', JSON.stringify({ pid: process.pid }));
    setInterval(() => { if (fs.existsSync(root + '/release') || fs.existsSync(root + '/release-initializer')) process.exit(1); }, 10);
    setTimeout(() => process.exit(99), 6000);
  `);
  for (const name of ['postgres', 'psql']) await executable(join(bin, name), 'process.exit(99);');
  starting = openLocalStore({ root, pgBin: bin, signal: controller.signal });
  let settled = false;
  starting.then(() => { settled = true; }, () => { settled = true; });
  await until(async () => await exists(join(root, 'initializer.json')) && await exists(join(root, 'bootstrap.json')), 'initializer barrier');
  pids = await Promise.all(['initializer', 'bootstrap'].map(async name => JSON.parse(await readFile(join(root, `${name}.json`), 'utf8')).pid));
  const lock = await readFile(join(root, '.flume/store.lock'), 'utf8');
  controller.abort();
  await until(() => exists(join(root, 'term')), 'initializer received termination');
  await delay(80);
  assert.ok(pids.every(alive), 'both deliberately held fixture processes remain alive');
  assert.equal(settled, false, 'cancellation must await actual initializer shutdown');
  assert.equal(await readFile(join(root, '.flume/store.lock'), 'utf8'), lock, 'ownership stays exclusive during cleanup');
  await assert.rejects(openLocalStore({ root, pgBin: bin }), /locked\/in use/);
  await writeFile(join(root, 'release-initializer'), 'release');
  await until(() => !alive(pids[0]), 'initializer exited');
  await delay(80);
  assert.equal(settled, false, 'bootstrap child must remain owned after initializer exits');
  assert.equal(await readFile(join(root, '.flume/store.lock'), 'utf8'), lock);
  await writeFile(join(root, 'release'), 'release');
  await assert.rejects(starting, /abort/i);
  for (const pid of pids.filter(alive)) {
    const state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
    t.diagnostic(`exited orphan waiting for OS reaping: pid=${pid} state=${state}`);
    assert.match(state, /^Z/, 'no running initializer descendants at return');
  }
  // Reaping an exited orphan by the OS can lag process-group disappearance.
  await until(() => pids.every(pid => !alive(pid)), 'both owned processes exited before cancellation returned', 1000);
  assert.equal(await readFile(join(root, '.flume/postgres/sentinel'), 'utf8'), 'preserve partial initialization');
  assert.equal(await exists(join(root, '.flume/store.lock')), false);
});

test('cancelled initializer escalates termination without erasing partial data (process double)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flume-init-escalate-'));
  const bin = join(root, 'bin'); await mkdir(bin);
  const controller = new AbortController(); let pending; let pid;
  t.after(async () => {
    controller.abort(); await pending?.catch(() => {});
    const fallbackRequired = pid && alive(pid);
    if (fallbackRequired) {
      const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
      assert.ok(command.includes(join(bin, 'initdb')), 'fallback only signals this test executable');
      process.kill(pid, 'SIGKILL');
    }
    await until(() => !pid || !alive(pid), 'initializer escalation fixture cleanup');
    await rm(root, { recursive: true, force: true });
    t.diagnostic(JSON.stringify({ root, pid, fallbackRequired: Boolean(fallbackRequired), allDead: !pid || !alive(pid) }));
  });
  await executable(join(bin, 'initdb'), `
    const fs = require('node:fs');
    const data = process.argv[process.argv.indexOf('-D') + 1]; fs.mkdirSync(data);
    fs.writeFileSync(data + '/sentinel', 'preserve incomplete initialization');
    process.on('SIGTERM', () => {});
    fs.writeFileSync(${JSON.stringify(join(root, 'started.json'))}, JSON.stringify({ pid: process.pid }));
    setTimeout(() => process.exit(99), 25000);
  `);
  for (const name of ['postgres', 'psql']) await executable(join(bin, name), 'process.exit(99);');
  pending = openLocalStore({ root, pgBin: bin, signal: controller.signal }); void pending.catch(() => {});
  await until(() => exists(join(root, 'started.json')), 'resistant initializer started');
  pid = JSON.parse(await readFile(join(root, 'started.json'), 'utf8')).pid;
  controller.abort(); await assert.rejects(pending, /abort/i);
  assert.equal(alive(pid), false, 'cancellation returns only after resistant initializer is dead');
  assert.equal(await readFile(join(root, '.flume/postgres/sentinel'), 'utf8'), 'preserve incomplete initialization');
  assert.equal(await exists(join(root, '.flume/store.lock')), false);
});

async function appFixture(root) {
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'launcher-fault-fixture', private: true }));
  for (const name of ['server', 'web']) {
    const directory = join(root, 'apps', name); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `@flume/${name}`, version: '0.1.0', scripts: { dev: 'node fixture.cjs' } }));
  }
}

test('cancellation during preflight never starts first-run installation (process double)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flume-install-cancel-'));
  const bin = join(root, 'bin'); await mkdir(bin); await appFixture(root);
  const previousPath = process.env.PATH;
  let starting;
  t.after(async () => { await starting?.catch(() => {}); process.env.PATH = previousPath; await rm(root, { recursive: true, force: true }); });
  await executable(join(bin, 'npm'), `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'npm-started'))}, String(process.pid)); setTimeout(() => process.exit(0), 120);`);
  for (const name of ['initdb', 'postgres', 'psql']) await executable(join(bin, name), 'process.exit(99);');
  process.env.PATH = `${bin}:${previousPath}`;
  const controller = new AbortController();
  starting = launchDevelopment({ root, apiPort: 0, webPort: 0, pgBin: bin, build: false, signal: controller.signal });
  controller.abort(); // Preflight is awaiting discovery: the event will not replay.
  await assert.rejects(starting, /abort/i);
  assert.equal(await exists(join(root, 'npm-started')), false, 'already-cancelled startup must not spawn npm ci');
  assert.equal(await exists(join(root, '.flume')), false);
});

test('installation catches an abort immediately before listener registration (process double)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flume-install-race-'));
  const bin = join(root, 'bin'); await mkdir(bin); await appFixture(root);
  const previousPath = process.env.PATH; const controller = new AbortController(); let pending;
  t.after(async () => {
    await pending?.catch(() => {}); process.env.PATH = previousPath;
    if (await exists(join(root, 'npm.json'))) {
      const { pid } = JSON.parse(await readFile(join(root, 'npm.json'), 'utf8'));
      assert.equal(alive(pid), false);
    }
    await rm(root, { recursive: true, force: true });
  });
  await executable(join(bin, 'npm'), `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'npm.json'))}, JSON.stringify({ pid: process.pid })); setTimeout(() => process.exit(0), 1500);`);
  for (const name of ['initdb', 'postgres', 'psql']) await executable(join(bin, name), 'process.exit(99);');
  process.env.PATH = `${bin}:${previousPath}`;
  const add = controller.signal.addEventListener.bind(controller.signal);
  t.mock.method(controller.signal, 'addEventListener', (type, listener, options) => {
    if (type === 'abort') controller.abort();
    return add(type, listener, options);
  });
  pending = launchDevelopment({ root, pgBin: bin, apiPort: 0, webPort: 0, build: false, signal: controller.signal });
  let timer;
  try {
    await Promise.race([assert.rejects(pending, /abort/i), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('already-fired abort was missed after installation spawn')), 700); })]);
  } finally { clearTimeout(timer); }
  assert.equal(await exists(join(root, '.flume')), false);
});

test('installation cancellation waits for descendants after npm exits (process doubles)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flume-install-group-'));
  const bin = join(root, 'bin'); await mkdir(bin); await appFixture(root);
  const previousPath = process.env.PATH; const controller = new AbortController(); let starting; let pids = [];
  t.after(async () => {
    controller.abort(); await writeFile(join(root, 'release'), 'release');
    await starting?.catch(() => {}); process.env.PATH = previousPath;
    await until(() => pids.every(pid => !alive(pid)), 'install fixture cleanup');
    t.diagnostic(JSON.stringify({ root, pids, allDead: pids.every(pid => !alive(pid)) }));
    await rm(root, { recursive: true, force: true });
  });
  const descendant = `
    const fs = require('node:fs'); const root = ${JSON.stringify(root)};
    process.on('SIGTERM', () => {});
    fs.writeFileSync(root + '/descendant.json', JSON.stringify({ pid: process.pid }));
    setInterval(() => { if (fs.existsSync(root + '/release')) process.exit(0); }, 10);
    setTimeout(() => process.exit(99), 6000);
  `;
  await executable(join(bin, 'npm'), `
    const fs = require('node:fs');
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(join(root, 'npm.json'))}, JSON.stringify({ pid: process.pid }));
    process.on('SIGTERM', () => process.exit(0)); setTimeout(() => process.exit(99), 6000);
  `);
  for (const name of ['initdb', 'postgres', 'psql']) await executable(join(bin, name), 'process.exit(99);');
  process.env.PATH = `${bin}:${previousPath}`;
  starting = launchDevelopment({ root, apiPort: 0, webPort: 0, pgBin: bin, build: false, signal: controller.signal });
  let settled = false; starting.then(() => { settled = true; }, () => { settled = true; });
  await until(() => exists(join(root, 'descendant.json')), 'installation descendant started');
  pids = await Promise.all(['npm', 'descendant'].map(async name => JSON.parse(await readFile(join(root, `${name}.json`), 'utf8')).pid));
  controller.abort();
  await until(() => !alive(pids[0]), 'npm wrapper exited'); await delay(80);
  assert.equal(alive(pids[1]), true, 'descendant is deliberately held');
  assert.equal(settled, false, 'wrapper close must not finish process-group cleanup');
  await writeFile(join(root, 'release'), 'release');
  await assert.rejects(starting, /abort/i);
  await until(() => pids.every(pid => !alive(pid)), 'all installation descendants exited', 1000);
  assert.equal(await exists(join(root, '.flume')), false);
});

for (const tamper of [false, true]) test(tamper ? 'CLI reports cleanup ownership failure despite cancellation (process doubles)' : 'CLI treats cancellation as success only after clean shutdown (process doubles)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flume-cli-cleanup-'));
  const bin = join(root, 'bin'); await mkdir(bin); await appFixture(root);
  await mkdir(join(root, 'node_modules')); await mkdir(join(root, 'tools'));
  for (const file of ['dev.mjs', 'dev-store.mjs', 'dev-workspaces.mjs']) await writeFile(join(root, 'tools', file), await readFile(new URL(file, import.meta.url)));
  await executable(join(bin, 'initdb'), `
    const fs = require('node:fs');
    const data = process.argv[process.argv.indexOf('-D') + 1];
    fs.mkdirSync(data); fs.writeFileSync(data + '/sentinel', 'retained fixture data');
    if (${tamper}) fs.writeFileSync(${JSON.stringify(join(root, '.flume/store.lock'))}, 'changed fixture ownership');
    fs.writeFileSync(${JSON.stringify(join(root, 'initializer.json'))}, JSON.stringify({ pid: process.pid }));
    process.on('SIGTERM', () => process.exit(1));
    process.kill(process.ppid, 'SIGTERM');
    setTimeout(() => process.exit(99), 1000);
  `);
  for (const name of ['postgres', 'psql']) await executable(join(bin, name), 'process.exit(99);');
  const cli = spawn(process.execPath, [join(root, 'tools/dev.mjs')], { cwd: root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), LC_ALL: 'C', PG_BIN: bin, FLUME_API_PORT: '0', FLUME_WEB_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; for (const stream of [cli.stdout, cli.stderr]) stream.on('data', chunk => { output += chunk; });
  const closed = new Promise((resolve, reject) => { cli.once('error', reject); cli.once('close', (code, signal) => resolve({ code, signal })); });
  t.after(async () => {
    if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGTERM');
    await closed;
    const { pid } = JSON.parse(await readFile(join(root, 'initializer.json'), 'utf8'));
    await until(() => !alive(pid), 'CLI fixture cleanup');
    t.diagnostic(JSON.stringify({ root, cliPid: cli.pid, initializerPid: pid, allDead: !alive(cli.pid) && !alive(pid) }));
    await rm(root, { recursive: true, force: true });
  });
  const result = await closed;
  assert.equal(result.code, tamper ? 1 : 0, 'only successfully cleaned cancellation is a success');
  if (tamper) {
    assert.match(output, /ownership|retained/i);
    assert.equal(await readFile(join(root, '.flume/store.lock'), 'utf8'), 'changed fixture ownership');
  } else assert.equal(await exists(join(root, '.flume/store.lock')), false);
  assert.equal(await readFile(join(root, '.flume/postgres/sentinel'), 'utf8'), 'retained fixture data');
});
