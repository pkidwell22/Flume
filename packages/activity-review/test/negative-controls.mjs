import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

// Prove the added coverage detects broken guards, without mutating authored source.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'evidence'), { recursive: true });
const output = mkdtempSync(join(root, 'evidence', 'negative-'));
const cases = [
  { name: 'server-approval-required', file: 'GenerationReview.tsx', from: ' || !review.approved;', to: ';', test: 'known cost needs', suite: 'review' },
  { name: 'provider-block-required', file: 'GenerationReview.tsx', from: 'review.blockers.length > 0 || ', to: '', test: 'privacy blocks', suite: 'review' },
  { name: 'no-paid-resubmit-after-ambiguity', file: 'GenerationReview.tsx', from: 'const submitDisabled = blocked || busy || pending || submitted || !review.approved;', to: 'const submitDisabled = blocked || busy || pending || !review.approved;', test: 'ambiguous submission remains held', suite: 'interaction' },
  { name: 'busy-blocks-submission', file: 'GenerationReview.tsx', from: 'const submitDisabled = blocked || busy || pending || submitted || !review.approved;', to: 'const submitDisabled = blocked || pending || submitted || !review.approved;', test: 'busy prevents both', suite: 'interaction' },
  { name: 'unknown-needs-receipt', file: 'ActivityPanel.tsx', from: "const canResume = attempt.status === 'queued' || (hasReceipt && !['blocked', 'ready'].includes(attempt.status));", to: 'const canResume = true;', test: 'recovery availability for acceptance_unknown', suite: 'interaction' },
  { name: 'unknown-cost-hold', file: 'GenerationReview.tsx', from: ' || review.estimatedCostUsd === null;', to: ';', test: 'UI-01 unknown cost holds both actions, including approved=true', suite: 'correction-cost-receipt' },
  { name: 'six-fractional-digits', file: 'GenerationReview.tsx', from: String.raw`\d{1,6}`, to: String.raw`\d+`, test: 'UI-01 rejects money outside the server format', suite: 'correction-cost-receipt' },
  { name: 'literal-dollar-cap', file: 'GenerationReview.tsx', from: 'maxCostUsd: limit', to: 'maxCostUsd: null', test: 'UI-01 preserves accepted money exactly', suite: 'correction-cost-receipt' },
  { name: 'receipt-required-for-acceptance-wording', file: 'ActivityPanel.tsx', from: "attempt.status === 'running' && hasReceipt ?", to: "attempt.status === 'running' ?", test: 'UI-02 running without a usable receipt', suite: 'correction-cost-receipt' },
];
const results = [];
for (const probe of cases) {
  const target = join(output, probe.name);
  mkdirSync(target);
  for (const name of ['src', 'test', 'package.json', 'tsconfig.json']) cpSync(join(root, name), join(target, name), { recursive: true });
  symlinkSync(realpathSync(join(root, 'node_modules')), join(target, 'node_modules'), 'dir');
  const filename = join(target, 'src', probe.file);
  const source = readFileSync(filename, 'utf8');
  assert.equal(source.split(probe.from).length, 2, `${probe.name}: mutation must match exactly once`);
  writeFileSync(filename, source.replace(probe.from, probe.to));
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', `--test-name-pattern=${probe.test}`, `test/${probe.suite}.test.tsx`], { cwd: target, encoding: 'utf8', timeout: 15000 });
  writeFileSync(join(output, `${probe.name}.log`), (run.stdout ?? '') + (run.stderr ?? ''));
  assert.equal(run.error, undefined, `${probe.name}: probe must finish`);
  assert.notEqual(run.status, 0, `${probe.name}: broken guard must be rejected`);
  assert.match(run.stdout, /AssertionError|TestingLibraryElementError/, `${probe.name}: fail on a behavioral assertion, not setup`);
  results.push({ name: probe.name, rejected: true, exitCode: run.status });
}
writeFileSync(join(output, 'negative-controls.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ rejected: results.length, output }));
