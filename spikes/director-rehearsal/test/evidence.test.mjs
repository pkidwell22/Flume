// Post-run integrity checks only; no inference and no post-hoc oracle edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { score } from '../scorer.mjs';
const read = name => readFileSync(new URL(`../${name}`, import.meta.url));
const json = name => JSON.parse(read(name));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const models = ['kimi-k3', 'glm-5.3-flash'];

test('frozen protocol stays live; only dependency hashes resolve to inert pre-inference snapshots', () => {
  // Exact, closed mapping: never redirect prompt/oracle/scorer/runner/test checks.
  // Original dependency bytes come from 1945a40; pre-run-lock.json is not rewritten.
  const historicalDependencies = new Map([
    ['package.json', 'evidence/pre-inference-environment/package.json.txt'],
    ['package-lock.json', 'evidence/pre-inference-environment/package-lock.json.txt'],
  ]);
  const lock = json('evidence/pre-run-lock.json');
  for (const item of lock.files) {
    const path = historicalDependencies.get(item.path) ?? item.path;
    assert.equal(hash(read(path)), item.sha256, `${item.path} -> ${path}`);
  }
});

test('both retained real outputs reproduce frozen scores and match exact-session prompt hashes', () => {
  for (const model of models) {
    const session = json(`evidence/${model}.session.json`);
    const response = read(`evidence/${model}.response.txt`);
    assert.equal(session.session.model, model);
    assert.equal(session.session.billing_provider, 'ollama-cloud');
    assert.equal(session.targetAttribution, 'session_verified');
    assert.equal(session.actualUserPromptSha256, hash(read('prompt.txt')));
    assert.equal(session.noToolsObserved, true);
    assert.equal(session.session.api_call_count, 1);
    assert.equal(session.responseSha256, hash(response));
    const recorded = json(`evidence/${model}.score.json`);
    assert.equal(recorded.responseSha256, hash(response));
    delete recorded.responseSha256;
    assert.deepEqual(score(response.toString(), json('fixtures.json'), json('oracle.json')), recorded);
  }
});

test('post-run descriptive diagnostics equal retained bytes, not a replacement oracle', () => {
  const diagnostics = json('evidence/diagnostics.json');
  for (const model of models) {
    const decisions = json(`evidence/${model}.response.txt`).decisions;
    const expected = json('oracle.json').cases.map(c => c.expected);
    const rows = diagnostics.models[model].cases;
    assert.equal(rows.length, decisions.length);
    rows.forEach((r, i) => {
      assert.deepEqual(r.actualActions, decisions[i].actions);
      assert.deepEqual(r.expectedActions, expected[i].actions);
      assert.equal(r.basisExactlyPreserved, JSON.stringify(decisions[i].basis) === JSON.stringify(expected[i].basis));
      assert.equal(r.stateExactlyPreserved, JSON.stringify(decisions[i].state) === JSON.stringify(expected[i].state));
    });
  }
});
