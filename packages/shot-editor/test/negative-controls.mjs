import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Mutate only throwaway copies, never authored source or another lane's store.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(process.env.TMPDIR, 'Set TMPDIR to an owned scratch directory');
const scratch = mkdtempSync(join(realpathSync(process.env.TMPDIR), 'flume-shot-negative-'));
const evidence = join(root, 'evidence', 'negative-controls');
mkdirSync(evidence, { recursive: true });
const cases = [
  {
    name: 'post-overwrite', file: 'editor-state.ts', test: '^keeps B during held POST', expected: 'POST success must not restore A',
    from: 'base: { ...state.base, ...state.saving.submitted.patch, revision: result.revision },',
    to: 'base: { ...state.base, ...state.saving.submitted.patch, revision: result.revision }, draft: draftFromShot({ ...state.base, ...state.saving.submitted.patch }),',
  },
  {
    name: 'get-overwrite', file: 'editor-state.ts', test: '^keeps B during held POST', expected: 'GET completion must not restore A',
    from: 'if (state.saving || isDirty(state) || hasConflict(state)) return { ...state, latest: shot };',
    to: 'if (state.saving || hasConflict(state)) return { ...state, latest: shot };',
  },
  {
    name: 'swapped-roles', file: 'ShotEditor.tsx', test: '^file selection imports', expected: 'AssertionError',
    from: "const key = role === 'first_frame' ? 'firstFrameAssetId' : 'lastFrameAssetId';",
    to: "const key = role === 'first_frame' ? 'lastFrameAssetId' : 'firstFrameAssetId';",
  },
  {
    name: 'stale-role-upload', file: 'ShotEditor.tsx', test: '^clearing an uploading reference', expected: 'AssertionError',
    from: 'roleEpoch.current[role] !== epoch ||', to: 'false ||',
  },
  {
    name: 'stale-model-upload', file: 'ShotEditor.tsx', test: '^model changes during an import', expected: 'AssertionError',
    from: 'modelEpoch.current !== model ||', to: 'false ||',
  },
  {
    name: 'stale-save-base', file: 'editor-state.ts', test: '^passive newer revisions', expected: 'Unable to find an accessible element with the role "alert"',
    from: 'return { ...state, latest: shot };', to: 'return { ...state, latest: shot, base: shot };',
  },
];
try {
  const results = [];
  for (const probe of cases) {
    const target = join(scratch, probe.name);
    mkdirSync(target);
    for (const name of ['src', 'test', 'package.json', 'tsconfig.json']) cpSync(join(root, name), join(target, name), { recursive: true });
    symlinkSync(realpathSync(join(root, 'node_modules')), join(target, 'node_modules'), 'dir');
    const file = join(target, 'src', probe.file);
    const source = readFileSync(file, 'utf8');
    assert.equal(source.split(probe.from).length, 2, `Unique mutation anchor: ${probe.name}`);
    writeFileSync(file, source.replace(probe.from, probe.to));
    const result = spawnSync(process.execPath, [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--test', '--test-concurrency=1', `--test-name-pattern=${probe.test}`, 'test/ShotEditor.test.tsx'], { cwd: target, encoding: 'utf8', timeout: 30000, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', DEBUG_PRINT_LIMIT: '100' } });
    const output = result.stdout + result.stderr;
    writeFileSync(join(evidence, `${probe.name}.log`), output);
    assert.equal(result.status, 1, `${probe.name} must fail, not pass or time out`);
    assert.ok(output.includes(probe.expected), `${probe.name} must fail its intended oracle`);
    results.push({ name: probe.name, rejected: true, expectedAssertion: probe.expected });
    console.log(`Rejected ${probe.name}: ${probe.expected}`);
  }
  writeFileSync(join(evidence, 'results.json'), JSON.stringify(results, null, 2));
} finally { rmSync(scratch, { recursive: true, force: true }); }
