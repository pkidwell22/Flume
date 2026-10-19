import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { missingPostgresReason, pgBinCandidates, resolveTestPgBin } from './dev-test-pg.mjs';
import { resolvePgBin } from './dev-store.mjs';

// Fake installations only: these tests prove resolution order and skip behavior, never that
// PostgreSQL itself works. A "Linux-shaped" host here is injected platform + env + pg_config.
const binaries = ['initdb', 'postgres', 'psql'];
async function fakeInstall(root, label) {
  const directory = join(root, label);
  await mkdir(directory, { recursive: true });
  for (const name of binaries) await writeFile(join(directory, name), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
  return directory;
}
const noConfig = async () => { throw Object.assign(new Error('pg_config: not found'), { code: 'ENOENT' }); };

test('linux: PG_BIN wins and pg_config / macOS paths are never consulted', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flume-pgbin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const explicit = await fakeInstall(root, 'explicit');
  const configured = await fakeInstall(root, 'configured');
  const calls = [];
  const result = await resolveTestPgBin({
    env: { PG_BIN: explicit, PATH: '/nonexistent-for-review' },
    platform: 'linux',
    pgConfig: async env => { calls.push(env); return configured; },
  });
  assert.equal(result, resolve(explicit));
  assert.deepEqual(calls, [], 'an explicit PG_BIN must short-circuit discovery');
  const candidates = await pgBinCandidates({ env: { PG_BIN: explicit, PATH: '' }, platform: 'linux', pgConfig: noConfig });
  assert.deepEqual(candidates, [resolve(explicit)], 'no /opt/homebrew/bin candidate on linux');
});

test('linux: pg_config --bindir resolves when PG_BIN is unset', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flume-pgbin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configured = await fakeInstall(root, 'postgresql-16');
  const result = await resolveTestPgBin({ env: { PATH: '/nonexistent-for-review' }, platform: 'linux', pgConfig: async () => `${configured}\n` });
  assert.equal(result, resolve(configured), 'pg_config output must be trimmed and honored');
});

test('linux: PATH is the last resort after pg_config is unavailable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flume-pgbin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const onPath = await fakeInstall(root, 'usr-bin');
  const result = await resolveTestPgBin({ env: { PATH: `/nonexistent-for-review:${onPath}` }, platform: 'linux', pgConfig: noConfig });
  assert.equal(result, resolve(onPath));
});

test('linux: an incomplete PG_BIN falls through to the next candidate instead of failing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flume-pgbin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const incomplete = join(root, 'client-only'); await mkdir(incomplete);
  await writeFile(join(incomplete, 'psql'), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
  const configured = await fakeInstall(root, 'postgresql-16');
  const result = await resolveTestPgBin({ env: { PG_BIN: incomplete, PATH: '/nonexistent-for-review' }, platform: 'linux', pgConfig: async () => configured });
  assert.equal(result, resolve(configured), 'PG_BIN is a preference, not an assertion that the install is complete');
});

test('linux: no PostgreSQL anywhere yields undefined and an explicit skip reason, not a macOS fallback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flume-pgbin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await resolveTestPgBin({ env: { PATH: '/nonexistent-for-review' }, platform: 'linux', pgConfig: noConfig }), undefined);
  // This host may well have Homebrew PostgreSQL at /opt/homebrew/bin; a Linux run must not see it.
  assert.deepEqual(await pgBinCandidates({ env: { PATH: '' }, platform: 'linux', pgConfig: noConfig }), []);
  const reason = missingPostgresReason('linux');
  assert.match(reason, /linux/);
  assert.match(reason, /skipping \(not passing\)/);
  assert.match(reason, /PG_BIN/);
});

test('win32 resolves nothing so the suite skips instead of failing on an unsupported platform', async () => {
  assert.deepEqual(await pgBinCandidates({ env: { PG_BIN: '/synthetic/pg', PATH: '/synthetic' }, platform: 'win32' }), []);
  assert.equal(await resolveTestPgBin({ env: { PG_BIN: '/synthetic/pg', PATH: '/synthetic' }, platform: 'win32' }), undefined);
});

test('darwin keeps the /opt/homebrew/bin fallback after PG_BIN and pg_config', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flume-pgbin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidates = await pgBinCandidates({ env: { PATH: '' }, platform: 'darwin', pgConfig: noConfig });
  assert.deepEqual(candidates, ['/opt/homebrew/bin']);
});

test('resolvePgBin documents exclusivity: an explicit directory is never backfilled from PATH', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flume-pgbin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const empty = join(root, 'empty'); await mkdir(empty);
  // The host has PostgreSQL installed (via PG_BIN, pg_config or PATH); the explicit probe still fails.
  await assert.rejects(resolvePgBin(empty), /PostgreSQL binaries are missing/);
});
