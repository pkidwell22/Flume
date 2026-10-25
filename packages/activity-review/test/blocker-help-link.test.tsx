import './setup.tsx';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { GenerationReview } from '../src/index.ts';
import type { Asset, Review } from '../src/index.ts';

afterEach(cleanup);

const review: Review = {
  id: 'ux-review', projectId: 'project', shotId: 'shot', shotRevision: 3,
  requestHash: 'literal-request-hash', prompt: 'A ridge at dawn.',
  controls: { modelId: 'fixture/model', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false, seed: 0 },
  bindings: { firstFrameAssetId: 'first', lastFrameAssetId: 'last' },
  estimatedCostUsd: '0.730000', blockers: [], approved: false,
};
const assets: Asset[] = ['first', 'last'].map(id => ({
  id, projectId: 'project', kind: 'image', origin: 'sample', filename: `${id}.png`,
  sha256: `hash-${id}`, mediaUrl: `/api/media/${id}`, width: 1600, height: 900,
}));
const callbacks = { onApprove: () => {}, onSubmit: () => {}, onDismiss: () => {} };
const DOC = 'https://github.com/pkidwell22/Flume/blob/main/docs/DOCKER.md';

function blockedSection() {
  return within(screen.getByRole('region', { name: 'Cost and readiness' })).getByRole('region', { name: 'Generation blocked' });
}

test('an unverified access route offers a real, labelled setup guide next to the block', () => {
  render(<GenerationReview
    review={{ ...review, blockers: [{ code: 'ENTITLEMENT_UNKNOWN', message: 'Catalog presence does not establish entitlement.' }] }}
    assets={assets} {...callbacks} />);
  const blocked = blockedSection();
  const link = within(blocked).getByRole('link', { name: 'Read the setup guide for provider access' });
  assert.equal(link.getAttribute('href'), DOC, 'the documentation URL is the coordinator-verified one');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.match(link.getAttribute('rel') ?? '', /noopener/);
  assert.match(blocked.textContent ?? '', /opens in a new tab/);
  // The entitlement safeguards are unchanged by adding a link.
  assert.match(blocked.textContent ?? '', /does not submit a generation request/);
  assert.doesNotMatch(blocked.textContent ?? '', /charged|billing|invoice|refund/i, 'no billing history is asserted without a receipt');
  assert.doesNotMatch(blocked.textContent ?? '', /Settings/, 'no invented settings surface is promised');
  const approve = within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve this generation' }) as HTMLButtonElement;
  assert.equal(approve.disabled, true, 'the block itself is never bypassed by following the guide');
});

test('an unreachable provider route offers the same labelled setup guide', () => {
  render(<GenerationReview
    review={{ ...review, blockers: [{ code: 'ROUTE_UNAVAILABLE', message: 'No route is verified for this model.' }] }}
    assets={assets} {...callbacks} />);
  const link = within(blockedSection()).getByRole('link', { name: 'Read the setup guide for provider access' });
  assert.equal(link.getAttribute('href'), DOC);
  const approve = within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve this generation' }) as HTMLButtonElement;
  assert.equal(approve.disabled, true, 'a route block still holds approval');
});

test('a request-shaped blocker keeps its in-app next step without a provider guide', () => {
  render(<GenerationReview review={{ ...review, blockers: ['Seed is unsupported'] }} assets={assets} {...callbacks} />);
  const blocked = blockedSection();
  assert.match(blocked.querySelector('.fl-review__blocker-next')!.textContent ?? '', /Change the settings or frames named here in the shot editor/);
  assert.equal(within(blocked).queryByRole('link', { name: 'Read the setup guide for provider access' }), null, 'a provider guide would not explain a request-shaped block');
});
