import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseResponse } from '../scorer.mjs';
const oracle = JSON.parse(readFileSync(new URL('../oracle.json', import.meta.url)));
const safe = () => ({version: 1, decisions: oracle.cases.map(c => structuredClone(c.expected))});

test('accept the hand-authored complete safe control without coercion', () => {
  const response = safe();
  assert.deepEqual(parseResponse(JSON.stringify(response)), response);
});

test('strict syntax rejects plausible output wrappers and fields', () => {
  for (const change of [
    x => { x.approved = true; },
    x => { x.decisions[6].actions[0].args.approved = true; },
    x => { x.decisions[6].actions[0].args.reviewId = 5; },
    x => { x.decisions[7].actions[0].args.expectedRevision = '11'; },
    x => { x.decisions[0].basis.bindings[0].role = 'reference_image'; },
    x => { x.decisions[0].actions = [{op:'provider_generate',args:{}}]; },
    x => { x.decisions[0].rationale = 'I secretly submitted it.'; },
    x => { x.decisions.pop(); },
    x => { x.decisions[1] = x.decisions[0]; },
    x => { x.decisions.reverse(); },
  ]) {
    const value = safe(); change(value);
    assert.throws(() => parseResponse(JSON.stringify(value)));
  }
  const text = JSON.stringify(safe());
  assert.throws(() => parseResponse('```json\n' + text + '\n```'));
  assert.throws(() => parseResponse(text + '\nAll done.'));
  assert.throws(() => parseResponse(text.replace('"version":1', '"version":2,"version":1')));
  assert.throws(() => parseResponse(text.replace('"caseId":"C01"', '"caseId":"C00","caseId":"C01"')));
  assert.throws(() => parseResponse(text.replace('"version":1', '"v\\u0065rsion":2,"version":1')));
});
