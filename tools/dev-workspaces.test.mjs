import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as tasks from './dev-workspaces.mjs';

test('workspace tasks run dependency-first, serially, without descending into preserved spikes', async () => {
  assert.equal(typeof tasks.runWorkspaceTask, 'function');
  const root = await mkdtemp(join(tmpdir(), 'flume-workspaces-'));
  const trace = join(root, 'trace.txt');
  try {
    for (const [directory, name, dependencies] of [['apps/cli', '@flume/cli', { '@flume/client': '0.1.0' }], ['packages/client', '@flume/client', { '@flume/domain': '0.1.0' }], ['packages/domain', '@flume/domain', {}]]) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, directory, 'package.json'), JSON.stringify({ name, version: '0.1.0', dependencies, scripts: { build: 'node task.cjs', test: 'node task.cjs test' } }));
      await writeFile(join(root, directory, 'task.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(trace)}, ${JSON.stringify(name)} + ':' + (process.argv[2] || 'build') + String.fromCharCode(10))`);
    }
    await mkdir(join(root, 'spikes/untouched'), { recursive: true });
    await writeFile(join(root, 'spikes/untouched/package.json'), JSON.stringify({ name: 'do-not-run', scripts: { build: 'exit 9' } }));
    await tasks.runWorkspaceTask(root, 'test', { quiet: true });
    assert.deepEqual((await readFile(trace, 'utf8')).trim().split('\n'), ['@flume/domain:build', '@flume/client:build', '@flume/cli:build', '@flume/domain:test', '@flume/client:test', '@flume/cli:test']);
    await assert.rejects(tasks.runWorkspaceTask(root, 'unknown'), /Unsupported/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workspace graph rejects missing local dependencies and cycles instead of silently passing a partial build', () => {
  assert.equal(typeof tasks.orderWorkspaces, 'function');
  assert.throws(() => tasks.orderWorkspaces([{ name: '@flume/a', dependencies: { '@flume/missing': '0.1.0' } }]), /Missing/);
  assert.throws(() => tasks.orderWorkspaces([{ name: '@flume/a', dependencies: { '@flume/b': '0.1.0' } }, { name: '@flume/b', dependencies: { '@flume/a': '0.1.0' } }]), /cycle/);
});

test('workspace startup builds honor cancellation and stop their owned process group', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'flume-build-cancel-')); const controller = new AbortController(); let running;
  t.after(async () => { controller.abort(); await running?.catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const workspace = join(root, 'packages/a'); await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: '@flume/a', scripts: { build: 'node build.cjs' } }));
  await writeFile(join(workspace, 'build.cjs'), `require('node:fs').writeFileSync('pid.json', JSON.stringify(process.pid)); setTimeout(() => process.exit(0), 1500);`);
  running = tasks.runWorkspaceTask(root, 'build', { quiet: true, signal: controller.signal });
  const rejected = assert.rejects(running, /cancel|abort/i); let pid;
  for (let i = 0; i < 100; i++) { try { pid = JSON.parse(await readFile(join(workspace, 'pid.json'), 'utf8')); break; } catch {} await new Promise(resolveWait => setTimeout(resolveWait, 20)); }
  assert.ok(pid); controller.abort();
  await Promise.race([rejected, new Promise((_, reject) => setTimeout(() => reject(new Error('Build cancellation was ignored')), 700).unref())]);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('test tasks forward only the explicit scratch approval through build and test children', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flume-scratch-env-'));
  try {
    const scratch = await realpath(root);
    const workspace = join(root, 'packages/a');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: '@flume/a', scripts: { build: 'node assert-env.cjs build', test: 'node assert-env.cjs test' } }));
    await writeFile(join(workspace, 'assert-env.cjs'), `
      const assert = require('node:assert/strict');
      assert.equal(process.env.FLUME_TEST_SCRATCH_ALLOWED, ${JSON.stringify(scratch)});
      assert.equal(process.env.TMPDIR, ${JSON.stringify(scratch)});
      assert.equal(process.env.PG_BIN, '/synthetic/pg-bin');
      assert.equal(process.env.LC_ALL, 'C');
      assert.equal(process.env.NODE_ENV, 'test');
      for (const key of ['DATABASE_URL', 'PGHOST', 'PGDATA', 'PGSERVICE', 'OPENROUTER_API_KEY', 'FLUME_TEST_UNRELATED']) assert.equal(process.env[key], undefined, key);
      require('node:fs').appendFileSync('trace.txt', process.argv[2] + '\\n');
    `);
    const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `const tools = await import(${JSON.stringify(new URL('./dev-workspaces.mjs', import.meta.url).href)}); await tools.runWorkspaceTask(${JSON.stringify(root)}, 'test', { quiet: true });`], { env: { PATH: process.env.PATH, HOME: root, TMPDIR: scratch, FLUME_TEST_SCRATCH_ALLOWED: scratch, PG_BIN: '/synthetic/pg-bin', LC_ALL: 'C', DATABASE_URL: 'postgresql://synthetic.invalid/never-connect', PGHOST: 'synthetic.invalid', PGDATA: '/synthetic/never-open', PGSERVICE: 'synthetic', OPENROUTER_API_KEY: 'synthetic-not-live', FLUME_TEST_UNRELATED: 'not-allowlisted' } });
    assert.equal(await readFile(join(workspace, 'trace.txt'), 'utf8'), 'build\ntest\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('test tasks do not invent scratch approval or inherit persistent targets and provider credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flume-test-env-'));
  try {
    await mkdir(join(root, 'packages/a'), { recursive: true });
    await writeFile(join(root, 'packages/a/package.json'), JSON.stringify({ name: '@flume/a', scripts: { test: 'node assert-env.cjs' } }));
    await writeFile(join(root, 'packages/a/assert-env.cjs'), `if (process.env.FLUME_TEST_SCRATCH_ALLOWED !== undefined || process.env.DATABASE_URL || process.env.PGHOST || process.env.OPENROUTER_API_KEY) process.exit(8);`);
    const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `const tools = await import(${JSON.stringify(new URL('./dev-workspaces.mjs', import.meta.url).href)}); await tools.runWorkspaceTask(${JSON.stringify(root)}, 'test', { quiet: true });`], { env: { PATH: process.env.PATH, HOME: root, TMPDIR: process.env.TMPDIR, LC_ALL: 'C', DATABASE_URL: 'postgresql://synthetic.invalid/never-connect', PGHOST: 'synthetic.invalid', OPENROUTER_API_KEY: 'synthetic-not-live' } });
  } finally { await rm(root, { recursive: true, force: true }); }
});
