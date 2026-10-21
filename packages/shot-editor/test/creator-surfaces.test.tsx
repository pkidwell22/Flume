import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = (name: string) => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
// Static ownership guard only. Browser cascade/geometry are exercised by
// native/creator-surfaces.mjs with the actual App and actual entry CSS order.
function rule(source: string, selector: string) {
  const start = source.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `Missing owned rule: ${selector}`);
  return source.slice(start, source.indexOf('}', start) + 1);
}

test('creator surface roles use existing skin tokens, without global overrides', async () => {
  const [prompt, settings, model, assembly] = await Promise.all([
    css('prompt-composer.css'), css('generation-settings.css'), css('model-picker.css'), css('creator-controls.css'),
  ]);
  const writing = rule(prompt, '.fl-prompt-composer textarea');
  assert.match(writing, /background: var\(--fl-well,/);
  assert.match(writing, /border: 0;/);
  assert.match(writing, /border-bottom: 1px solid var\(--fl-border,/);
  for (const block of [rule(prompt, '.fl-prompt-composer button'), rule(model, '.fl-model-picker .fl-model-picker__trigger'), rule(settings, '.fl-generation-settings .fl-generation-settings__audio')]) {
    assert.match(block, /background: var\(--fl-control,/);
    assert.match(block, /border: 1px solid var\(--fl-rule,/);
  }
  for (const source of [prompt, settings, model, assembly]) {
    assert.doesNotMatch(source, /!important|(?:^|\n)\s*(?:body|:root|\.fl-workspace)\b/);
    assert.doesNotMatch(source, /--fl-[\w-]+\s*:/, 'Component files consume, not redefine, the shared palette');
  }
  assert.match(rule(model, '.fl-model-picker .fl-model-picker__panel'), /border: 1px solid var\(--fl-border,/);
  assert.match(rule(prompt, '.fl-prompt-composer .fl-prompt-composer__directions'), /border: 1px solid var\(--fl-border,/);
});

test('creator import order is explicit and popup geometry stays in its owner', async () => {
  const main = await readFile(new URL('../../../apps/web/src/main.tsx', import.meta.url), 'utf8');
  const imports = [...main.matchAll(/^import ['"]([^'"]+\.css)['"];$/gm)].map(match => match[1]);
  assert.deepEqual(imports, ['@flume/ui/theme.css', '@flume/shot-editor/styles.css', '../../../packages/shot-editor/src/creator-controls.css', '@flume/take-review/styles.css', '@flume/activity-review/styles.css', './workspace.css']);
  const assembly = await css('creator-controls.css');
  assert.deepEqual([...assembly.matchAll(/@import '([^']+)';/g)].map(match => match[1]), ['./model-picker.css', './generation-settings.css', './prompt-composer.css']);
  for (const source of [await css('model-picker.css'), await css('prompt-composer.css')]) {
    assert.match(source, /^@import '\.\/anchored-popup\.css';/);
    assert.doesNotMatch(source, /(?:position:\s*fixed|inset:|z-index:)/, 'Do not relocate positioner ownership to surface rules');
  }
});
