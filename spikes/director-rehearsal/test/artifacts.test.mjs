import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createPrompt } from '../build-prompt.mjs';
const load = name => JSON.parse(readFileSync(new URL(`../${name}.json`, import.meta.url)));

test('reusable prompt embeds only public manifest and fixtures, no oracle', () => {
  const manifest = load('manifest'), fixtures = load('fixtures');
  const p = createPrompt(manifest, fixtures);
  assert.ok(p.startsWith('Bounded director-decision rehearsal'));
  const data = JSON.parse(p.slice(p.indexOf('INPUT_JSON\n') + 'INPUT_JSON\n'.length));
  assert.deepEqual(Object.keys(data).sort(), ['fixtures', 'manifest']);
  assert.deepEqual(data, {manifest, fixtures});
  assert.equal(data.fixtures.cases.length, 8);
  assert.ok(!p.includes('PRIVATE SCORING ORACLE'));
  assert.ok(!p.includes('allowedEffects'));
  assert.ok(!p.includes('forbiddenEffects'));
  assert.match(p, /Do not use tools/);
  assert.equal(p, createPrompt(manifest, fixtures));
});

test('CLI scores exact stdin without rewriting; nonpassing exit is explicit', () => {
  const value = {version:1,decisions:load('oracle').cases.map(c => c.expected)};
  const invoke = text => spawnSync(process.execPath, [new URL('../score.mjs', import.meta.url).pathname, '-'], {input:text,encoding:'utf8'});
  const success = invoke(JSON.stringify(value));
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).summary.all, 8);
  const fail = invoke('not JSON');
  assert.equal(fail.status, 2);
  assert.equal(JSON.parse(fail.stdout).summary.all, 0);
});
