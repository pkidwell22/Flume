// Mutate only ignored compiled output, never tracked source. Each probe owns
// a fresh cluster and must fail on the named assertion, not infrastructure.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createOwnedCluster, cleanEnvironment } from './disposable-postgres.mjs';

assert([undefined, 'recovery'].includes(process.argv[2]), 'unknown mutation suite');
const recovery = process.argv[2] === 'recovery';
const file = new URL(recovery ? '../dist/recovery/engine.js' : '../dist/src/accept.js', import.meta.url);
const original = await readFile(file, 'utf8');
const mutations = recovery ? [
  { name: 'skip-cancellation-gate', before: 'const reason = current.cancel_requested ?', after: 'const reason = false ?',
    pattern: '^cancel before authorization', evidence: /must not create work to obtain a cancel/ },
  { name: 'remove-epoch-fencing', before: 'AND owner=$2 AND epoch=$3', after: 'AND $2::uuid IS NOT NULL AND $3::integer IS NOT NULL', all: true,
    pattern: '^late valid acceptance', evidence: /stale delivery cannot write the checkpoint/ },
  { name: 'ignore-output-attribution', before: "return saved.remote_id === remote.id && saved.sha256 === output.sha256 && saved.size === output.size ? 'claimed' : 'OUTPUT_CONFLICT';",
    after: "return 'claimed';", pattern: '^stable output identity', evidence: /OUTPUT_CONFLICT/ },
] : [
  { name: 'ignore-missing-job', before: "if (jobId === null)", after: 'if (false)',
    alsoBefore: 'if (jobId !== attemptId)', alsoAfter: 'if (false)',
    pattern: 'duplicate-ID suppression', evidence: /Missing expected rejection/ },
  { name: 'enqueue-outside-transaction', before: 'client.query(text, values)', after: 'experiment.pool.query(text, values)',
    pattern: 'injected throw after real INSERT', evidence: /queue insertion is also uncommitted/ },
  { name: 'skip-replay-receipt', before: 'if (receipt) {', after: 'if (false) {',
    pattern: 'accepted command replay after later draft edits', evidence: /REVIEW_ALREADY_CONSUMED/ },
];

for (const mutation of mutations) {
  if (mutation.all) assert(original.includes(mutation.before));
  else assert.equal(original.split(mutation.before).length, 2, `mutation ${mutation.name} must match exactly once`);
  const cluster = await createOwnedCluster();
  try {
    let mutant = mutation.all ? original.replaceAll(mutation.before, mutation.after) : original.replace(mutation.before, mutation.after);
    if (mutation.alsoBefore) {
      assert.equal(mutant.split(mutation.alsoBefore).length, 2);
      mutant = mutant.replace(mutation.alsoBefore, mutation.alsoAfter);
    }
    await writeFile(file, mutant);
    const { code, output } = await new Promise((resolve, reject) => {
      let output = '';
      const child = spawn(process.execPath, ['--test', '--test-reporter=spec', `--test-name-pattern=${mutation.pattern}`,
        recovery ? 'dist/recovery/recovery.test.js' : 'dist/test/acceptance.test.js'], {
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
    try { await writeFile(file, original); }
    finally { await cluster.cleanup(); }
  }
}
console.log('All mutations rejected; original compiled code restored.');
