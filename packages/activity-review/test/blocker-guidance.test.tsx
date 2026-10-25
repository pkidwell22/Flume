import './setup.tsx';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { GenerationReview } from '../src/index.ts';
import { blockerGuidance } from '../src/presentation.ts';
import type { Asset, Review, ReviewBlocker } from '../src/index.ts';

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

test('an unverified account route is explained in plain words with a real next step', () => {
  render(<GenerationReview
    review={{ ...review, blockers: [{ code: 'ENTITLEMENT_UNKNOWN', message: 'Catalog presence does not establish entitlement. This route has not been verified.' }] }}
    assets={assets} {...callbacks} />);
  const decision = screen.getByRole('region', { name: 'Cost and readiness' });
  const blocked = within(decision).getByRole('region', { name: 'Generation blocked' });
  const reason = blocked.querySelector('.fl-review__blocker-reason')!.textContent ?? '';
  const next = blocked.querySelector('.fl-review__blocker-next')!.textContent ?? '';

  assert.match(reason, /this build/i, 'the user is told whether the limit belongs to the build');
  assert.match(reason, /provider account/i, 'the plain explanation names who can resolve it');
  assert.match(reason, /does not submit a generation request/, 'the scoped statement is what this blocked path actually knows');
  assert.doesNotMatch(reason, /charged|billing|invoice|refund/i, 'no billing history is asserted without a receipt');
  assert.match(next, /Choose a model whose route is verified/i, 'a concrete in-app next step is offered');
  assert.match(next, /Editing and saving still work/i);
  assert.doesNotMatch(`${reason} ${next}`, /Catalog presence does not establish entitlement/, 'internal vocabulary is not the primary explanation');
  assert.doesNotMatch(`${reason} ${next}`, /Settings/, 'no invented settings surface is promised');

  // Technical diagnostics stay available as secondary detail.
  const details = blocked.querySelector('details');
  assert.ok(details, 'diagnostics are kept as secondary detail');
  assert.match(details!.textContent ?? '', /ENTITLEMENT_UNKNOWN/);
  assert.match(details!.textContent ?? '', /Catalog presence does not establish entitlement/);

  const approve = within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve this generation' }) as HTMLButtonElement;
  assert.equal(approve.disabled, true, 'the block itself is never bypassed');
});

test('a provider privacy block keeps its own explanation and next step', () => {
  render(<GenerationReview
    review={{ ...review, blockers: [{ code: 'ZDR_VIOLATION_BY_ACCOUNT', message: 'raw server text' }] }}
    assets={assets} {...callbacks} />);
  const blocked = within(screen.getByRole('region', { name: 'Cost and readiness' })).getByRole('region', { name: 'Generation blocked' });
  const reason = blocked.querySelector('.fl-review__blocker-reason')!.textContent ?? '';
  const next = blocked.querySelector('.fl-review__blocker-next')!.textContent ?? '';
  assert.match(reason, /zero-data-retention privacy setting/);
  assert.match(next, /Ask whoever runs this Flume build/i);
  assert.doesNotMatch(`${reason} ${next}`, /raw server text/);
});

test('an unrecognised blocker is still quoted verbatim, with its next step', () => {
  render(<GenerationReview review={{ ...review, blockers: ['Seed is unsupported'] }} assets={assets} {...callbacks} />);
  const blocked = within(screen.getByRole('region', { name: 'Cost and readiness' })).getByRole('region', { name: 'Generation blocked' });
  assert.match(blocked.querySelector('.fl-review__blocker-reason')!.textContent ?? '', /can’t be generated as prepared/);
  assert.match(blocked.querySelector('.fl-review__blocker-next')!.textContent ?? '', /What you can do next/i);
  assert.match(blocked.querySelector('details')!.textContent ?? '', /Seed is unsupported/, 'the literal server wording is kept as diagnostics');
});

test('cost display is readable without masking meaningful sub-cent amounts', () => {
  render(<GenerationReview review={review} assets={assets} {...callbacks} />);
  const decision = screen.getByRole('region', { name: 'Cost and readiness' });
  assert.ok(within(decision).getByRole('heading', { name: 'Estimated cost: $0.73 USD' }));
  assert.doesNotMatch(decision.textContent ?? '', /\$0\.730000/);
  // The exact provider value still governs the spending limit field.
  assert.equal((within(decision).getByRole('textbox', { name: 'Spending limit (USD)' }) as HTMLInputElement).value, '0.730000');
  cleanup();

  render(<GenerationReview review={{ ...review, estimatedCostUsd: '0.007300' }} assets={assets} {...callbacks} />);
  assert.ok(screen.getByRole('heading', { name: 'Estimated cost: $0.0073 USD' }), 'sub-cent precision survives');
  cleanup();

  render(<GenerationReview review={{ ...review, estimatedCostUsd: '2' }} assets={assets} {...callbacks} />);
  assert.ok(screen.getByRole('heading', { name: 'Estimated cost: $2.00 USD' }));
});

test('the approval boundary copy is retained', () => {
  render(<GenerationReview review={review} assets={assets} {...callbacks} />);
  const dialog = screen.getByRole('dialog');
  assert.match(dialog.textContent ?? '', /Approving does not send this request/);
  assert.match(dialog.textContent ?? '', /Generate once/);
});

test('every generic blocker explanation states only what the blocked review knows', () => {
  // A blocked review is not a billing receipt: the copy may say no generation
  // request is submitted, and may not assert a charge history.
  const blockers: ReviewBlocker[] = [
    { code: 'ENTITLEMENT_UNKNOWN', message: 'Catalog presence does not establish entitlement.' },
    { code: 'ROUTE_UNAVAILABLE', message: 'No route is verified for this model.' },
    { code: 'SEED_UNSUPPORTED', message: 'Seed is unsupported' },
  ];
  for (const blocker of blockers) {
    const guidance = blockerGuidance(blocker);
    assert.match(guidance.explanation, /does not submit a generation request/, 'the scoped statement is present');
    assert.doesNotMatch(guidance.explanation, /charged|billing|invoice|refund/i, 'no billing outcome is asserted without a receipt');
    assert.doesNotMatch(guidance.explanation, /nothing was sent/i, 'no blanket send claim is made either');
    assert.ok(guidance.nextStep.length > 0, 'the next step survives the wording change');
  }
});
