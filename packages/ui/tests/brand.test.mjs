import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { transform } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

async function loadBrand() {
  const source = new URL('../Brand.tsx', import.meta.url);
  assert.ok(existsSync(source), 'Brand.tsx must render the portfolio identity');
  const { code } = await transform(readFileSync(source, 'utf8'), { loader: 'tsx', jsx: 'automatic', format: 'esm' });
  const output = new URL('../.evidence/tests/Brand.mjs', import.meta.url);
  mkdirSync(new URL('.', output), { recursive: true });
  writeFileSync(output, code);
  return import(output.href);
}

test('default Brand is a quiet text lockup with decorative geometry, not a link or account state', async () => {
  const { Brand } = await loadBrand();
  const html = renderToStaticMarkup(createElement(Brand));
  assert.match(html, /Flume/);
  assert.match(html, /<svg[^>]*aria-hidden="true"/);
  assert.doesNotMatch(html, /<a|connected|online|<button|<img/i);
  assert.equal((html.match(/<path/g) ?? []).length, 3, 'Three portfolio rails');
});

test('compact Brand retains its accessible name and uses an explicit native navigation link', async () => {
  const { Brand } = await loadBrand();
  const html = renderToStaticMarkup(createElement(Brand, { href: '#workspace', compact: true, className: 'example' }));
  assert.match(html, /^<a[^>]*href="#workspace"/);
  assert.match(html, /aria-label="Flume"/);
  assert.match(html, /class="fl-brand example"/);
  assert.doesNotMatch(html, /fl-brand__wordmark|tabindex|role="button"/);
  const unlinked = renderToStaticMarkup(createElement(Brand, { compact: true }));
  assert.match(unlinked, /^<span[^>]*role="img"[^>]*aria-label="Flume"/);
});
