import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';

const cssUrl = new URL('../theme.css', import.meta.url);
const css = existsSync(cssUrl) ? readFileSync(cssUrl, 'utf8') : '';
const tokens = Object.fromEntries([...css.matchAll(/(--fl-[a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

function luminance(hex) {
  assert.match(hex, /^#[\da-f]{6}$/i);
  const rgb = hex.slice(1).match(/../g).map((channel) => parseInt(channel, 16) / 255);
  return rgb.reduce((sum, channel, index) => sum + [0.2126, 0.7152, 0.0722][index] *
    (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4), 0);
}
function contrast(first, second) {
  const [lo, hi] = [luminance(first), luminance(second)].sort((a, b) => a - b);
  return (hi + 0.05) / (lo + 0.05);
}

test('exports the shared product tokens with accessible source-grounded colors', () => {
  for (const name of ['bg', 'surface', 'ink', 'muted', 'border', 'accent', 'danger', 'radius', 'font']) {
    assert.ok(tokens[`--fl-${name}`], `Missing --fl-${name}`);
  }
  assert.equal(tokens['--fl-brand-accent'], '#a52a27', 'Preserve Flume oxide identity; interactive derivative must work on dark');
  assert.match(css, /color-scheme:\s*dark/);
  assert.ok(luminance(tokens['--fl-bg']) < 0.02, 'Cinema page is a dark work surface');
  assert.ok(luminance(tokens['--fl-surface']) > luminance(tokens['--fl-bg']), 'Composer separates from page');
  assert.ok(luminance(tokens['--fl-control']) > luminance(tokens['--fl-surface']), 'Context controls separate from composer');
  assert.ok(luminance(tokens['--fl-control']) < 0.08, 'Layering remains restrained');
  for (const foreground of ['ink', 'muted', 'accent', 'danger']) {
    for (const background of ['bg', 'surface', 'control', 'surface-pressed']) {
      assert.ok(contrast(tokens[`--fl-${foreground}`], tokens[`--fl-${background}`]) >= 4.5,
        `${foreground}/${background} must meet WCAG AA normal text`);
    }
  }
  for (const background of ['bg', 'surface', 'control']) {
    assert.ok(contrast(tokens['--fl-border'], tokens[`--fl-${background}`]) >= 3, 'Control boundary contrast');
    assert.ok(contrast(tokens['--fl-focus'], tokens[`--fl-${background}`]) >= 3, 'Visible focus on every work layer');
  }
  assert.ok(contrast(tokens['--fl-on-accent'], tokens['--fl-accent']) >= 4.5, 'Primary button text');
  assert.ok(contrast(tokens['--fl-on-accent'], tokens['--fl-accent-hover']) >= 4.5, 'Hovered primary text');
});

test('control primitives are opt-in, keyboard-visible, motion-safe, and have no remote assets', () => {
  assert.match(css, /\.fl-theme\s*\{/);
  assert.match(css, /\.fl-ui-button\s*\{/);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--fl-focus\)/s);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /\.fl-ui-input\[aria-invalid="true"\]/);
  assert.doesNotMatch(css, /@import|@font-face|url\(|@keyframes/);
  assert.doesNotMatch(css, /(?:^|\})\s*(?:body|button|input|a|h1)\s*\{/m, 'No unscoped component resets');
});
