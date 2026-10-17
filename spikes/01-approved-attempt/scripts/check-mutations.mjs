// Mutate only ignored compiled output, never tracked source. Each probe owns
// a fresh cluster and must fail on the named assertion, not infrastructure.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createOwnedCluster, cleanEnvironment } from './disposable-postgres.mjs';

const file = new URL('../dist/src/accept.js', import.meta.url);
const original = await readFile(file, 'utf8');
const mutations = [
  { name: 'ignore-missing-job', before: "if (jobId === null)", after: 'if (false)',
    alsoBefore: 'if (jobId !== attemptId)', alsoAfter: 'if (false)',
    pattern: 'duplicate-ID suppression', evidence: /Missing expected rejection/ },
  { name: 'enqueue-outside-transaction', before: 'client.query(text, values)', after: 'experiment.pool.query(text, values)',
    pattern: 'injected throw after real INSERT', evidence: /queue insertion is also uncommitted/ },
  { name: 'skip-replay-receipt', before: 'if (receipt) {', after: 'if (false) {',
    pattern: 'accepted command replay after later draft edits', evidence: /REVIEW_ALREADY_CONSUMED/ },
];

for (const mutation of mutations) {
  assert.equal(original.split(mutation.before).length, 2, `mutation ${mutation.name} must match exactly once`);
  const cluster = await createOwnedCluster();
  try {
    let mutant = original.replace(mutation.before, mutation.after);
    if (mutation.alsoBefore) {
      assert.equal(mutant.split(mutation.alsoBefore).length, 2);
      mutant = mutant.replace(mutation.alsoBefore, mutation.alsoAfter);
    }
    await writeFile(file, mutant);
    const { code, output } = await new Promise((resolve, reject) => {
      let output = '';
      const child = spawn(process.execPath, ['--test', '--test-reporter=spec', `--test-name-pattern=${mutation.pattern}`, 'dist/test/acceptance.test.js'], {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        env: { ...cleanEnvironment(), SPIKE_DATABASE: cluster.database, SPIKE_DATA_DIRECTORY: cluster.dataDirectory, SPIKE_SOCKET: cluster.socketDirectory },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, output }));
    });
    assert.equal(code, 1, `mutant ${mutation.name} was not rejected:\n${output}`);
    assert.match(output, mutation.evidence);
    assert.match(output, /fail 1/);
    console.log(`MUTATION KILLED: ${mutation.name}; test exit=1; expected assertion observed`);
    console.log(output);
  } finally {
    await writeFile(file, original);
    await cluster.cleanup();
  }
}
console.log('All mutations rejected; original compiled acceptance code restored.');
