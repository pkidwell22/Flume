import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Source-level contracts only. jsdom performs no layout, so these assertions
// record the rules that must exist; real sticky/occlusion geometry is a
// browser check owned by the coordinator's acceptance pass.
const workspace = readFileSync(new URL('../src/workspace.css', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../../../packages/shot-editor/src/styles.css', import.meta.url), 'utf8');

function rule(source: string, selector: string) {
  const start = source.indexOf(`${selector} {`);
  assert.ok(start >= 0, `Missing rule ${selector}`);
  return source.slice(start, source.indexOf('}', start) + 1);
}

test('the slate action area stays inside the scrolling column instead of scrolling away', () => {
  const footer = rule(workspace, '.fl-workspace__slate .fl-shot-editor__footer');
  assert.match(footer, /position:\s*sticky/);
  assert.match(footer, /bottom:\s*0/);
  assert.doesNotMatch(footer, /position:\s*fixed/, 'a fixed bar would occlude the stage and the reel');
  assert.match(footer, /background:/, 'the bar must be opaque so content cannot bleed through it');
  // The slate is the scroll container on wide layouts.
  const slate = rule(workspace, '.fl-workspace__slate');
  assert.match(slate, /overflow:\s*auto/);
});

test('save and review stay ahead of the long prompt block on narrow layouts', () => {
  const narrow = workspace.slice(workspace.indexOf('@container fl (max-width: 600px)'));
  assert.match(narrow, /\.fl-workspace__slate \.fl-shot-editor \{[^}]*display:\s*flex/);
  const footer = rule(narrow, '.fl-workspace__slate .fl-shot-editor__footer');
  const intent = rule(narrow, '.fl-workspace__slate .fl-shot-editor__intent');
  const order = (body: string) => Number(/order:\s*(-?\d+)/.exec(body)![1]);
  assert.ok(order(footer) < order(intent), 'save/review come before the prompt and model block when stacked');
});

test('the featured-film Pause control never wraps mid-word', () => {
  assert.match(rule(workspace, '.fl-showreel__controls'), /flex-wrap:\s*nowrap/);
  const button = rule(workspace, '.fl-showreel__controls button');
  assert.match(button, /white-space:\s*nowrap/);
  assert.match(button, /flex:\s*0 0 auto/);
});

test('a disabled control never advertises a pointer cursor', () => {
  assert.match(rule(workspace, '.fl-workspace button:disabled'), /cursor:\s*not-allowed/);
});

test('project cards label the primary entry and de-emphasise quick actions', () => {
  assert.match(rule(workspace, '.fl-home-card__open-label'), /font-weight:\s*(6|7|8)\d{2}/);
  const subaction = rule(workspace, '.fl-home-card__subaction');
  assert.match(subaction, /font-size:\s*1[01](?:\.\d)?px/);
  assert.match(subaction, /color:\s*var\(--fl-muted\)/);
});

test('the sticky action bar is not achieved by hiding overflow', () => {
  assert.doesNotMatch(workspace, /overflow(?:-x)?:\s*hidden/);
});
