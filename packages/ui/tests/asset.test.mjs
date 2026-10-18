import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

test('standalone owned SVG uses the same three paths as the rendered mark without external references', () => {
  const source = new URL('../assets/flume-mark.svg', import.meta.url);
  assert.ok(existsSync(source), 'Portable owned mark asset is required');
  const svg = readFileSync(source, 'utf8');
  const component = readFileSync(new URL('../Brand.tsx', import.meta.url), 'utf8');
  const paths = (text) => [...text.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(paths(svg).length, 3);
  assert.deepEqual(paths(svg), paths(component));
  assert.match(svg, /viewBox="0 0 96 80"/);
  assert.match(svg, /<title[^>]*>Flume<\/title>/);
  assert.doesNotMatch(svg, /<script|<image|<foreignObject|href=|url\(|onload=/i);
});
