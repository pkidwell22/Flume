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

async function checkIndependentClusters(createCluster = createOwnedCluster, readMarker = readFile) {
  const one = await createCluster();
  let two;
  try {
    two = await createCluster();
    const markerPath = path.join(one.root, '.owner');
    const marker = await readMarker(markerPath, 'utf8');
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
      if (!one.stopped) await writeFile(markerPath, marker, { mode: 0o600 });
    }
  } finally {
    try { await one.cleanup(); }
    finally { await two?.cleanup(); }
  }
}

test('tampered ownership marker refuses cleanup, and stopping one owned cluster leaves the other running', () => checkIndependentClusters());

test('second cluster acquisition failure stops and removes the first owned cluster', async () => {
  const failure = new Error('injected second acquisition failure');
  let one;
  let pid;
  try {
    await assert.rejects(() => checkIndependentClusters(async () => {
      if (one) throw failure;
      one = await createOwnedCluster();
      pid = Number((await readFile(path.join(one.dataDirectory, 'postmaster.pid'), 'utf8')).split('\n')[0]);
      return one;
    }), error => error === failure);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'first owned postmaster must be gone before fallback');
    await assert.rejects(() => stat(one.root), { code: 'ENOENT' });
    console.log(`REGRESSION verified: second acquisition failed; PID ${pid} gone; ${one.root} removed`);
  } finally {
    // RED-safety fallback retains the exact acquired cluster's ownership guards.
    await one?.cleanup();
  }
});

test('a cleanup failure still stops and removes the other owned cluster', async () => {
  const failure = new Error('injected first cluster cleanup failure');
  let one;
  let two;
  let cleanupOne;
  let pid;
  try {
    await assert.rejects(() => checkIndependentClusters(async () => {
      const cluster = await createOwnedCluster();
      if (!one) {
        one = cluster;
        cleanupOne = one.cleanup;
        let calls = 0;
        one.cleanup = async () => {
          // Exercise the real marker refusal, then fail subsequent cleanup.
          if (++calls === 1) return cleanupOne();
          throw failure;
        };
      } else {
        two = cluster;
        pid = Number((await readFile(path.join(two.dataDirectory, 'postmaster.pid'), 'utf8')).split('\n')[0]);
      }
      return cluster;
    }), error => error === failure);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'second owned postmaster must be gone before fallback');
    await assert.rejects(() => stat(two.root), { code: 'ENOENT' });
    console.log(`REGRESSION verified: cleanup error propagated; PID ${pid} gone; ${two.root} removed`);
  } finally {
    try { await cleanupOne?.(); }
    finally { await two?.cleanup(); }
  }
});

async function checkWrongDataDirectory(createCluster = createOwnedCluster, readMarker = readFile) {
  const cluster = await createCluster();
  try {
    const markerPath = path.join(cluster.root, '.owner');
    const original = await readMarker(markerPath, 'utf8');
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
    }
  } finally {
    await cluster.cleanup();
  }
}

test('a wrong expected data directory is rejected before application or pg-boss schema mutation', () => checkWrongDataDirectory());

for (const [name, check, count] of [
  ['independent clusters', checkIndependentClusters, 2],
  ['wrong data directory', checkWrongDataDirectory, 1],
]) {
  test(`marker read failure cleans all acquired clusters: ${name}`, async () => {
    const failure = new Error('injected marker read failure');
    const acquired = [];
    try {
      await assert.rejects(() => check(async () => {
        const cluster = await createOwnedCluster();
        const entry = { cluster };
        acquired.push(entry);
        entry.pid = Number((await readFile(path.join(cluster.dataDirectory, 'postmaster.pid'), 'utf8')).split('\n')[0]);
        return cluster;
      }, async () => { throw failure; }), error => error === failure);
      assert.equal(acquired.length, count);
      for (const { cluster, pid } of acquired) {
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'owned postmaster must be gone before fallback');
        await assert.rejects(() => stat(cluster.root), { code: 'ENOENT' });
        console.log(`REGRESSION verified: marker read failed; PID ${pid} gone; ${cluster.root} removed`);
      }
    } finally {
      const results = await Promise.allSettled(acquired.map(({ cluster }) => cluster.cleanup()));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    }
  });
}

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
