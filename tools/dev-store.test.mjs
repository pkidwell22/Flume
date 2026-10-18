import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as stores from './dev-store.mjs';
import { missingPostgresReason, resolveTestPgBin } from './dev-test-pg.mjs';

const exec = promisify(execFile);
// PG_BIN -> pg_config --bindir -> (darwin) /opt/homebrew/bin -> PATH; skip, never pass, without PostgreSQL.
const pgBin = await resolveTestPgBin();
const withoutPostgres = pgBin ? undefined : missingPostgresReason();
async function sql(store, statement) {
  const url = new URL(store.databaseUrl);
  const result = await exec(join(pgBin, 'psql'), ['--no-psqlrc', '--no-align', '--tuples-only', '--set', 'ON_ERROR_STOP=1', '--command', statement], { env: { PATH: process.env.PATH, LC_ALL: 'C', PGHOST: url.hostname, PGPORT: url.port, PGUSER: url.username, PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: 'flume' } });
  return result.stdout.trim();
}

test('owned PostgreSQL survives normal stop/restart and a competing start cannot remove its lock', { skip: withoutPostgres }, async (t) => {
  assert.equal(typeof stores.openLocalStore, 'function');
  const root = await mkdtemp(join(tmpdir(), 'flume-store-'));
  let first; let second;
  t.after(async () => { try { await second?.stop(); } finally { try { await first?.stop(); } finally { await rm(root, { recursive: true, force: true }); } } });
  first = await stores.openLocalStore({ root, pgBin });
  assert.equal(await sql(first, 'SELECT current_database()'), 'flume');
  await sql(first, "CREATE SCHEMA flume; CREATE TABLE flume.persisted(value text); INSERT INTO flume.persisted VALUES ('preserved');");
  const lock = await readFile(join(root, '.flume/store.lock'), 'utf8');
  await assert.rejects(stores.openLocalStore({ root, pgBin }), /already|locked|in use/i);
  assert.equal(await readFile(join(root, '.flume/store.lock'), 'utf8'), lock);
  assert.equal(await sql(first, 'SELECT value FROM flume.persisted'), 'preserved');
  const pid = first.pid;
  await first.stop();
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(stat(join(root, '.flume/store.lock')), { code: 'ENOENT' });
  assert.equal((await stat(join(root, '.flume/postgres/PG_VERSION'))).isFile(), true);
  second = await stores.openLocalStore({ root, pgBin });
  assert.equal(second.port, first.port);
  assert.equal(await sql(second, 'SELECT value FROM flume.persisted'), 'preserved');
  await second.stop();
  assert.throws(() => process.kill(second.pid, 0), { code: 'ESRCH' });
});
