import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const editor = readFileSync(new URL('../../../packages/shot-editor/src/styles.css', import.meta.url), 'utf8');
const workspace = readFileSync(new URL('../src/workspace.css', import.meta.url), 'utf8');
const theme = readFileSync(new URL('../../../packages/ui/theme.css', import.meta.url), 'utf8');
// Source-level contracts supplement the private native witness; they do not
// claim that a CSS text match proves browser geometry or keyboard behavior.
function rule(source: string, selector: string) {
  const start = source.indexOf(`${selector} {`);
  assert.ok(start >= 0, `Missing rule ${selector}`);
  return source.slice(start, source.indexOf('}', start) + 1);
}

test('conditioning images keep full content and have bounded grid minima', () => {
  for (const [source, selector] of [
    [editor, '.fl-shot-editor__image img'],
    [workspace, '.fl-workspace__shot-image img'],
    [workspace, '.fl-workspace__screen img, .fl-workspace__screen video'],
  ]) {
    const body = rule(source, selector!);
    assert.match(body, /object-fit:\s*contain/);
    assert.match(body, /min-height:\s*0/);
    assert.match(body, /max-height:\s*100%/);
  }
  assert.doesNotMatch(workspace, /overflow(?:-x)?:\s*hidden/, 'Do not hide viewport overflow to mask clipping');
});

test('base editor yields control shapes to completed contextual components', () => {
  assert.match(editor, /\.fl-shot-editor :where\(input:not\(\[type='checkbox'\]\), select, textarea\)/);
  assert.match(editor, /\.fl-shot-editor :where\(button\),/);
  assert.doesNotMatch(editor, /\.fl-shot-editor button\s*[,\{]/);
  const prompt = rule(editor, '.fl-shot-editor :where(textarea)');
  assert.match(prompt, /resize:\s*vertical/);
  assert.match(prompt, /background:\s*var\(--fl-well/);
  assert.match(editor, /border-bottom:\s*1px solid var\(--fl-border/);
  assert.match(editor, /@container shot-editor \(max-width: 520px\)/);
});

test('dark work surfaces retain independent focus, errors and reduced motion', () => {
  for (const source of [editor, workspace]) {
    assert.match(source, /outline:\s*3px solid var\(--fl-focus/);
    assert.match(source, /prefers-reduced-motion:\s*reduce/);
    assert.match(source, /forced-colors:\s*active/);
    assert.doesNotMatch(source, /@import|@font-face|url\(/);
  }
  assert.match(rule(editor, '.fl-shot-editor .fl-shot-editor__field-error'), /var\(--fl-danger/);
  assert.match(rule(workspace, '.fl-workspace__issue strong'), /var\(--fl-danger/);
  assert.match(theme, /--fl-radius-surface:\s*18px/);
  assert.match(theme, /--fl-radius-panel:\s*14px/);
  assert.match(theme, /--fl-radius:\s*10px/);
});
