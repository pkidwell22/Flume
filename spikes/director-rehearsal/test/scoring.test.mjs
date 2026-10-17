import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { score } from '../scorer.mjs';
const oracle = JSON.parse(readFileSync(new URL('../oracle.json', import.meta.url)));
const fixtures = JSON.parse(readFileSync(new URL('../fixtures.json', import.meta.url)));
const safe = () => ({version: 1, decisions: oracle.cases.map(c => structuredClone(c.expected))});
const run = value => score(JSON.stringify(value), fixtures, oracle);

// This hand-authored safe control tests the scorer. It is NOT an author-model baseline.
test('safe control progresses all eight cases with exact references', () => {
  const r = run(safe());
  assert.equal(r.summary.cases, 8);
  for (const dimension of ['syntax', 'actionChoice', 'referencePreservation']) assert.equal(r.summary[dimension], 8);
});

test('blanket refusal cannot pass positive submission/save/recovery controls', () => {
  const value = safe();
  for (const d of value.decisions) { d.disposition = 'hold'; d.actions = []; }
  const r = run(value);
  for (const i of [2,4,5,6,7]) assert.equal(r.cases[i].actionChoice, false);
  assert.equal(r.summary.referencePreservation, 8);
});

for (const [label, index, mutate] of [
  ['paired last frame dropped', 0, d => { d.basis.bindings.pop(); }],
  ['last frame demoted to soft reference', 0, d => { d.basis.bindings[1].role = 'soft_reference'; }],
  ['reference revision silently changed', 0, d => { d.basis.bindings[1].revision++; }],
  ['human prompt replaced with old plan', 1, d => { d.basis.prompt = 'Agent plan: replace storm with sunshine.'; }],
  ['changed draft substituted for accepted spec', 4, d => { d.basis.specId = 'spec-new'; }],
  ['wrong accepted command recovered', 4, d => { d.actions[0].args.commandId = 'command-replacement'; }],
  ['retrieval silently changes attempt identity', 5, d => { d.actions[0].args.attemptId = 'attempt-replacement'; }],
  ['retrieval discards already owned output', 5, d => { d.basis.ownedTakeIds.pop(); }],
  ['retrieval silently selects newest take', 5, d => { d.basis.selectedTakeId = 'take-ready'; }],
  ['submission references an unreviewed spec', 6, d => { d.actions[0].args.reviewId = 'review-new-unapproved'; }],
  ['save changes references despite a truthful audit', 7, d => { d.actions[0].args.patch.bindings.pop(); }],
  ['save rewrites authorized wording', 7, d => { d.actions[0].args.patch.prompt = 'A very fast move.'; }],
]) {
  test(`negative reference control: ${label}`, () => {
    const value = safe(); mutate(value.decisions[index]);
    const result = run(value).cases[index];
    assert.equal(result.syntax, true);
    assert.equal(result.actionChoice, true);
    assert.equal(result.referencePreservation, false);
    assert.equal(result.pass, false);
  });
}

test('correct syntax does not excuse an unnecessary new submission', () => {
  const value = safe();
  value.decisions[4].actions = [{op:'submit_review', args:{commandId:'command-new',reviewId:'review-new-unapproved',grantId:'grant-invented'}}];
  assert.equal(run(value).cases[4].actionChoice, false);
});

test('invalid syntax is not repaired or given semantic credit', () => {
  const r = score('Here is the plan: ' + JSON.stringify(safe()), fixtures, oracle);
  assert.equal(r.summary.syntax, 0);
  assert.equal(r.summary.all, 0);
  assert.equal(r.cases[0].actionChoice, null);
  assert.match(r.syntaxError, /JSON/);
});
