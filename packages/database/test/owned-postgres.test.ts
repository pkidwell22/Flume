import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, realpath, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ownedPostgres } from './owned-postgres.ts';

test('owned PostgreSQL rejects empty, mismatched and noncanonical scratch approvals', async () => {
  const scratch = await realpath(process.env.TMPDIR ?? tmpdir());
  const before = await readdir(scratch);
  const previous = process.env.FLUME_TEST_SCRATCH_ALLOWED;
  try {
    for (const approval of ['', path.dirname(scratch), path.join(scratch, 'not-approved'), `${scratch}/.`]) {
      let unexpected: Awaited<ReturnType<typeof ownedPostgres>> | undefined;
      try {
        process.env.FLUME_TEST_SCRATCH_ALLOWED = approval;
        await assert.rejects(async () => { unexpected = await ownedPostgres(); }, /explicitly owned test scratch/);
        assert.deepEqual(await readdir(scratch), before);
      } finally { await unexpected?.close(); }
    }
  } finally {
    if (previous === undefined) delete process.env.FLUME_TEST_SCRATCH_ALLOWED;
    else process.env.FLUME_TEST_SCRATCH_ALLOWED = previous;
  }
});

test('canonical approval creates exclusive socket-only clusters and removes only its owned roots', async (t) => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'sc-')));
  const alias = path.join(base, 'alias'), sentinel = path.join(base, 'keep');
  const overrides = { TMPDIR: alias, FLUME_TEST_SCRATCH_ALLOWED: base,
    DATABASE_URL: 'postgresql://synthetic.invalid/never-connect', PGHOST: 'synthetic.invalid',
    PGPORT: '1', PGDATABASE: 'never-connect', PGUSER: 'not-the-owner', PGDATA: path.join(base, 'never-open') };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  let first: Awaited<ReturnType<typeof ownedPostgres>> | undefined;
  let second: typeof first;
  const clusters: { root: string; pid: number }[] = [];
  await symlink(base, alias);
  await writeFile(sentinel, 'untouched', { flag: 'wx', mode: 0o600 });
  try {
    Object.assign(process.env, overrides);
    first = await ownedPostgres();
    second = await ownedPostgres();
    assert.notEqual(first.root, second.root);
    const owners = [];
    for (const db of [first, second]) {
      assert.equal(path.dirname(db.root), base);
      assert.equal((await stat(db.root)).mode & 0o777, 0o700);
      const markerPath = path.join(db.root, 'owner.json');
      const marker = JSON.parse(await readFile(markerPath, 'utf8'));
      assert.match(marker.owner, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(marker.uid, process.getuid!());
      assert.equal((await stat(markerPath)).mode & 0o777, 0o600);
      owners.push(marker.owner);
      const pidLines = (await readFile(path.join(db.root, 'd/postmaster.pid'), 'utf8')).split('\n');
      assert.equal(pidLines[1], path.join(db.root, 'd'));
      clusters.push({ root: db.root, pid: Number(pidLines[0]) });
      assert.equal(db.config.connectionString, undefined);
      assert.equal(db.config.host, path.join(db.root, 's'));
      const identity = (await db.pool.query(`SELECT current_database() AS name,
        current_setting('data_directory') AS data, current_setting('listen_addresses') AS listen,
        current_setting('unix_socket_directories') AS socket, inet_server_addr() AS address`)).rows[0];
      assert.deepEqual(identity, { name: 'flume_test', data: path.join(db.root, 'd'), listen: '', socket: path.join(db.root, 's'), address: null });
    }
    assert.notEqual(owners[0], owners[1]);
    await assert.rejects(stat(overrides.PGDATA), { code: 'ENOENT' });
  } finally {
    try { try { await second?.close(); } finally { await first?.close(); } }
    finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    // Never recursively remove a parent if cluster cleanup failed.
    await first?.close(); await second?.close();
    for (const { root, pid } of clusters) {
      await assert.rejects(stat(root), { code: 'ENOENT' });
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
    assert.equal(await readFile(sentinel, 'utf8'), 'untouched');
    assert.deepEqual((await readdir(base)).sort(), ['alias', 'keep']);
    await unlink(alias); await unlink(sentinel); await rmdir(base);
  }
  t.diagnostic(`verified stopped PIDs and removed roots: ${JSON.stringify(clusters)}`);
});

test('owned PostgreSQL requires explicit scratch approval before acquisition', async () => {
  const scratch = await realpath(process.env.TMPDIR ?? tmpdir());
  const before = await readdir(scratch);
  const previous = process.env.FLUME_TEST_SCRATCH_ALLOWED;
  let unexpected: Awaited<ReturnType<typeof ownedPostgres>> | undefined;
  try {
    delete process.env.FLUME_TEST_SCRATCH_ALLOWED;
    await assert.rejects(async () => { unexpected = await ownedPostgres(); }, /explicitly owned test scratch/);
    assert.deepEqual(await readdir(scratch), before, 'rejection must not acquire a temporary directory');
  } finally {
    try { await unexpected?.close(); }
    finally {
      if (previous === undefined) delete process.env.FLUME_TEST_SCRATCH_ALLOWED;
      else process.env.FLUME_TEST_SCRATCH_ALLOWED = previous;
    }
  }
});
