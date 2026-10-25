import './setup.tsx';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { GenerationReview } from '../src/index.ts';
import type { Asset, Review } from '../src/index.ts';

afterEach(cleanup);
const review: Review = {
  id: 'exact-review', projectId: 'project', shotId: 'shot', shotRevision: 3,
  requestHash: 'literal-request-hash', prompt: '  A cup turns.\n\nKeep <the handle> visible.  ',
  controls: { modelId: 'fixture/model', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false, seed: 0 },
  bindings: { firstFrameAssetId: 'first', lastFrameAssetId: 'last' },
  estimatedCostUsd: '0.087500', blockers: [], approved: false,
};
const assets: Asset[] = ['first', 'last'].map(id => ({
  id, projectId: 'project', kind: 'image', origin: 'sample', filename: `${id}.png`,
  sha256: `hash-${id}`, mediaUrl: `/api/media/${id}`, width: 1600, height: 900,
}));
const callbacks = { onApprove: () => {}, onSubmit: () => {}, onDismiss: () => {} };

test('image-first review groups exact intent separately from cost and readiness', () => {
  render(<GenerationReview review={review} assets={assets} {...callbacks} />);
  const intent = screen.getByRole('region', { name: 'Exact request' });
  const decision = screen.getByRole('region', { name: 'Cost and readiness' });
  const first = screen.getByRole('figure', { name: 'Start frame' });
  const end = screen.getByRole('figure', { name: 'End frame' });
  // Logical order remains first → end → literal intent → decision at every width.
  assert.ok(first.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(end.compareDocumentPosition(intent) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(intent.compareDocumentPosition(decision) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(within(first).getByRole('img').getAttribute('src'), '/api/media/first');
  assert.equal(within(end).getByRole('img').getAttribute('src'), '/api/media/last');
  assert.ok(within(intent).getByRole('heading', { name: 'Exact prompt' }));
  assert.ok(within(intent).getByRole('heading', { name: 'Generation settings' }));
  assert.equal(within(intent).getByTestId('fl-review-prompt').textContent, review.prompt);
  const controls = intent.querySelector('dl')!;
  assert.deepEqual([...controls.querySelectorAll('dt')].map(term => [term.textContent, term.nextElementSibling?.textContent]), [
    ['Model', 'fixture/model'], ['Length', '5 seconds'], ['Resolution', '2K'],
    ['Frame shape', '16:9'], ['Audio', 'Off'], ['Seed', '0'],
  ]);
  assert.ok(within(decision).getByText('Estimated cost: $0.0875 USD'));
  assert.equal((within(decision).getByRole('textbox', { name: 'Spending limit (USD)' }) as HTMLInputElement).value, '0.087500');
  assert.match(decision.textContent ?? '', /not a provider-enforced billing cap/);
  assert.doesNotMatch(screen.getByRole('dialog').querySelector('header')?.textContent ?? '', /will be sent/);
});

test('blocked review gives an explicit editing exit alongside the unknown-cost hold', () => {
  let calls = 0;
  render(<GenerationReview review={{ ...review, approved: true, estimatedCostUsd: null, blockers: ['Seed is unsupported'] }}
    assets={assets} onApprove={() => { calls++; }} onSubmit={() => { calls++; }} onDismiss={() => { calls++; }} />);
  const decision = screen.getByRole('region', { name: 'Cost and readiness' });
  const blockers = within(decision).getByRole('region', { name: 'Generation blocked' });
  assert.ok(within(blockers).getByText('Seed is unsupported'));
  assert.match(blockers.textContent ?? '', /Close this review to keep editing\. Address the listed blockers, then prepare a new review\./);
  assert.doesNotMatch(blockers.textContent ?? '', /Choose a compatible available model/);
  assert.ok(within(decision).getByRole('heading', { name: 'Cost not available' }));
  assert.match(decision.textContent ?? '', /Unknown does not mean free\./);
  assert.match(decision.textContent ?? '', /Approval is on hold/);
  assert.equal(within(decision).queryAllByRole('textbox').length, 0);
  assert.equal((screen.getByRole('button', { name: 'Approve this generation' }) as HTMLButtonElement).disabled, true);
  assert.equal((screen.getByRole('button', { name: 'Generate once' }) as HTMLButtonElement).disabled, true);
  assert.equal((screen.getByRole('button', { name: 'Close review' }) as HTMLButtonElement).disabled, false);
  assert.equal(calls, 0, 'opening a review does not approve, submit, or dismiss it');
});
