import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat, symlink } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import path from 'node:path';
import test from 'node:test';
import { createOwnedCluster, cleanEnvironment, resolveTempParent } from './disposable-postgres.mjs';

test('fresh owned cluster is socket-only and removed after verified stop', async () => {
  const cluster = await createOwnedCluster();
  try {
    assert.equal(cluster.identity.database, cluster.database);
    assert.equal(cluster.identity.dataDirectory, cluster.dataDirectory);
    assert.equal(cluster.identity.listenAddresses, '');
    assert.equal(cluster.identity.socketDirectory, cluster.socketDirectory);
    assert.equal(cluster.identity.ownerMode, 0o700);
  } finally {
    await cluster.cleanup();
  }
  assert.equal(cluster.stopped, true);
  await assert.rejects(() => import('node:fs/promises').then(fs => fs.stat(cluster.root)), { code: 'ENOENT' });
});

test('refuses an unsafe temp parent before starting PostgreSQL', async () => {
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'unsafe-'));
  try {
    const long = path.join(root, 'x'.repeat(100));
    await assert.rejects(() => createOwnedCluster({ tempParent: long }), /socket path too long/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('canonical temp-parent validation cannot be bypassed by a short safe symlink', async () => {
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'path-'));
  try {
    for (const [name, error] of [["quote'", /unsafe characters/], ['x'.repeat(100), /socket path too long/]]) {
      const target = path.join(root, name);
      const link = path.join(root, 'safe');
      await mkdir(target, { mode: 0o700 });
      await symlink(target, link);
      await assert.rejects(() => resolveTempParent(link), error);
      await rm(link);
    }
  } finally { await rm(root, { recursive: true }); }
});

test('connection environment cannot select a shared server', () => {
  const keys = ['PGHOST', 'PGSERVICE', 'DATABASE_URL'];
  const previous = keys.map(key => process.env[key]);
  try {
    process.env.PGHOST = 'unsafe.example';
    process.env.PGSERVICE = 'shared';
    process.env.DATABASE_URL = 'not-a-real-url';
    const env = cleanEnvironment();
    for (const key of keys) assert.equal(env[key], undefined);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test('tampered ownership marker refuses cleanup, and stopping one owned cluster leaves the other running', async () => {
  const one = await createOwnedCluster();
  const two = await createOwnedCluster();
  const markerPath = path.join(one.root, '.owner');
  const marker = await readFile(markerPath, 'utf8');
  try {
    await writeFile(markerPath, '{}', { mode: 0o600 });
    await assert.rejects(() => one.cleanup(), /ownership marker changed/);
    await writeFile(markerPath, marker, { mode: 0o600 });
    await one.cleanup();
    const client = new pg.Client(two.config);
    try {
      await client.connect();
      const { rows: [identity] } = await client.query("SELECT current_database() as db, current_setting('data_directory') as directory");
      assert.equal(identity.db, two.database);
      assert.equal(identity.directory, two.dataDirectory);
    } finally { await client.end(); }
  } finally {
    if (!one.stopped) { await writeFile(markerPath, marker, { mode: 0o600 }); await one.cleanup(); }
    await two.cleanup();
  }
});

test('a wrong expected data directory is rejected before application or pg-boss schema mutation', async () => {
  const cluster = await createOwnedCluster();
  const markerPath = path.join(cluster.root, '.owner');
  const original = await readFile(markerPath, 'utf8');
  const wrong = path.join(cluster.root, 'wrong');
  try {
    await mkdir(wrong, { mode: 0o700 });
    await writeFile(markerPath, JSON.stringify({ ...JSON.parse(original), dataDirectory: wrong }), { mode: 0o600 });
    const exec = promisify(execFile);
    await assert.rejects(() => exec(process.execPath, ['--input-type=module', '-e',
      "import { openExperiment } from './dist/src/database.js'; await openExperiment();"], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 15_000,
      env: { ...cleanEnvironment(), SPIKE_DATABASE: cluster.database, SPIKE_SOCKET: cluster.socketDirectory, SPIKE_DATA_DIRECTORY: wrong },
    }), error => error.code === 1 && error.stderr.includes(cluster.dataDirectory) && error.stderr.includes(wrong));
    const client = new pg.Client(cluster.config);
    try {
      await client.connect();
      const { rows } = await client.query("SELECT nspname FROM pg_namespace WHERE nspname IN ('spike', 'pgboss')");
      assert.deepEqual(rows, []);
    } finally { await client.end(); }
  } finally {
    await writeFile(markerPath, original, { mode: 0o600 });
    await cluster.cleanup();
  }
});

test('SIGTERM at the first verified identity still stops the owned postmaster', { timeout: 40_000 }, async () => {
  const runner = fileURLToPath(new URL('./disposable-postgres.mjs', import.meta.url));
  const child = spawn(process.execPath, [runner], { env: { ...cleanEnvironment(), PG_BIN: process.env.PG_BIN || '/opt/homebrew/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let identity;
  child.stdout.on('data', chunk => {
    output += chunk;
    const match = output.match(/IDENTITY verified: (\{[^\n]+\})/);
    if (match && !identity) { identity = JSON.parse(match[1]); child.kill('SIGTERM'); }
  });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code)); });
    assert.ok(identity, output);
    assert.notEqual(exit, 0);
    assert.match(output, /CLEANUP verified/);
    await assert.rejects(() => stat(path.dirname(identity.dataDirectory)), { code: 'ENOENT' });
  } finally {
    // RED-safety fallback: only the exact cluster this child just reported.
    // Never adopt an arbitrary database or signal a PID outside that data dir.
    if (identity) {
      const root = path.dirname(identity.dataDirectory);
      const exists = await stat(root).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
      if (exists) {
        const marker = JSON.parse(await readFile(path.join(root, '.owner'), 'utf8'));
        assert.equal(marker.dataDirectory, identity.dataDirectory);
        assert.equal(marker.root, root);
        assert.equal(marker.uid, process.getuid());
        assert.equal(path.dirname(root), process.env.TMPDIR);
        const lines = (await readFile(path.join(identity.dataDirectory, 'postmaster.pid'), 'utf8')).split('\n');
        assert.equal(lines[1], identity.dataDirectory);
        const exec = promisify(execFile);
        const bin = path.join(process.env.PG_BIN || '/opt/homebrew/bin', 'pg_ctl');
        await exec(bin, ['-D', identity.dataDirectory, '-m', 'fast', '-w', 'stop']);
        await assert.rejects(() => exec(bin, ['-D', identity.dataDirectory, 'status']), error => error.code === 3);
        assert.throws(() => process.kill(Number(lines[0]), 0), error => error.code === 'ESRCH');
        await rm(root, { recursive: true });
        console.log('RED fallback verified: child-owned cluster stopped and removed');
      }
    }
  }
});
