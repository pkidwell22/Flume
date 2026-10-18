// Negative controls against ignored compiled output only. Never modify source or shared DBs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const cases = [
  { name: 'transaction-binding', file: 'pg-boss-queue', from: 'db: tx, startAfter:', to: 'startAfter:',
    test: 'enqueue uses the callers transaction', expected: /1 !== 0/ },
  { name: 'activation-fence', file: 'pg-boss-queue', from: "row.retry_count === activation.retryCount &&", to: '',
    test: 'obsolete fetched activation', expected: /running.*stale/s },
  { name: 'publication-owner', file: 'coordinator', from: 'if (!s || s.owner !== lease.owner || s.epoch !== lease.epoch)', to: 'if (!s)',
    test: 'stale media owner', expected: /uniqueness alone must not hide stale publication/ },
  { name: 'single-dispatch', file: 'coordinator', from: 'if (!s.dispatch)', to: 'if (true)',
    test: 'lost response stays unknown', expected: /2 !== 1/ },
];
await mkdir(new URL('../dist/mutations/', import.meta.url), { recursive: true });
for (const mutation of cases) {
  const file = new URL(`../dist/src/${mutation.file}.js`, import.meta.url);
  const original = await readFile(file, 'utf8');
  assert.equal(original.split(mutation.from).length, 2, 'mutation anchor must be unique');
  try {
    await writeFile(file, original.replace(mutation.from, mutation.to));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/test.mjs', `--test-name-pattern=${mutation.test}`], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
      child.once('error', reject); child.once('close', code => resolve({ code, output }));
    });
    await writeFile(new URL(`../dist/mutations/${mutation.name}.log`, import.meta.url), result.output);
    assert.notEqual(result.code, 0, `${mutation.name} survived`);
    assert.match(result.output, mutation.expected, result.output);
    assert.match(result.output, /CLEANUP verified: owned postmaster stopped; owned directory removed/);
    console.log(`KILLED ${mutation.name}: intended assertion failed; owned PG cleanup verified`);
  } finally { await writeFile(file, original); }
}
