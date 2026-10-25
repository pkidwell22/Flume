import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUsd } from '../src/presentation.ts';

// Presentation only: the exact provider string still governs the request and
// the spending limit. Nothing here rounds, re-scales or changes arithmetic.
test('formatUsd trims padding zeros and keeps meaningful sub-cent precision', () => {
  assert.equal(formatUsd('0.730000'), '0.73');
  assert.equal(formatUsd('0.7'), '0.70');
  assert.equal(formatUsd('2'), '2.00');
  assert.equal(formatUsd('0.087500'), '0.0875');
  assert.equal(formatUsd('0.007300'), '0.0073');
  assert.equal(formatUsd('0.000100'), '0.0001');
  assert.equal(formatUsd('12.345600'), '12.3456');
  assert.equal(formatUsd('0.100000'), '0.10');
});

test('formatUsd leaves unusable or already-short values alone', () => {
  assert.equal(formatUsd(''), '');
  assert.equal(formatUsd('not-a-number'), 'not-a-number');
  assert.equal(formatUsd('0'), '0.00');
});
