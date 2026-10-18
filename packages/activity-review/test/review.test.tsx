import './setup.tsx';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { cleanup, fireEvent, render, screen, within, act } from '@testing-library/react';
import type { Asset } from '../src/types.ts';
import * as moduleUnderTest from '../src/index.ts';

afterEach(cleanup);
const review = {
  id: 'review-1', projectId: 'project-1', shotId: 'shot-1', shotRevision: 0,
  requestHash: 'exact-request-hash', prompt: '  A red cup turns.\n\nKeep the handle visible. <script>no</script>  ',
  controls: { modelId: 'minimax/hailuo-3', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false, seed: 0 },
  bindings: { firstFrameAssetId: null, lastFrameAssetId: null }, estimatedCostUsd: '0.80', blockers: [], approved: false,
};
const callbacks = { onApprove: () => {}, onSubmit: () => {}, onDismiss: () => {} };
const assets: Asset[] = [
  { id: 'first', projectId: 'project-1', filename: 'cup-start.png', kind: 'image', origin: 'sample', sha256: 'first-hash', mediaUrl: '/api/media/first', width: 1600, height: 900 },
  { id: 'last', projectId: 'project-1', filename: 'cup-end.png', kind: 'image', origin: 'imported', sha256: 'last-hash', mediaUrl: '/api/media/last', width: 1600, height: 900 },
];

test('start and end previews preserve exact bindings and origins', () => {
  render(<moduleUnderTest.GenerationReview review={{ ...review, bindings: { firstFrameAssetId: 'first', lastFrameAssetId: 'last' } }} assets={assets} {...callbacks} />);
  const start = screen.getByRole('figure', { name: 'Start frame' });
  const end = screen.getByRole('figure', { name: 'End frame' });
  assert.equal(within(start).getByRole('img').getAttribute('src'), '/api/media/first');
  assert.equal(within(end).getByRole('img').getAttribute('src'), '/api/media/last');
  assert.ok(within(start).getByText('Sample'));
  assert.ok(within(end).getByText('Imported'));
  assert.ok(within(start).getByText('cup-start.png'));
});

test('end-only intent is not silently moved to the start role', () => {
  render(<moduleUnderTest.GenerationReview review={{ ...review, controls: { ...review.controls, generateAudio: true }, bindings: { firstFrameAssetId: null, lastFrameAssetId: 'last' } }} assets={assets} {...callbacks} />);
  assert.ok(within(screen.getByRole('figure', { name: 'Start frame' })).queryByRole('img') === null);
  assert.equal(within(screen.getByRole('figure', { name: 'End frame' })).getByRole('img').getAttribute('src'), '/api/media/last');
  assert.ok(screen.getByText('On'));
});

test('image failure blocks even a server-approved snapshot from submission', () => {
  render(<moduleUnderTest.GenerationReview review={{ ...review, approved: true, bindings: { firstFrameAssetId: 'first', lastFrameAssetId: 'last' } }} assets={assets} {...callbacks} />);
  for (const image of screen.getAllByRole('img')) fireEvent.load(image);
  assert.equal((screen.getByRole('button', { name: 'Generate once' }) as HTMLButtonElement).disabled, false);
  fireEvent.error(screen.getAllByRole('img')[1]!);
  assert.equal((screen.getByRole('button', { name: 'Generate once' }) as HTMLButtonElement).disabled, true);
});

test('known cost needs an explicit allowance; approval never submits or becomes local authority', async () => {
  const calls: unknown[] = [];
  const props = { assets: [], busy: false, onApprove: (...args: unknown[]) => { calls.push(['approve', ...args]); }, onSubmit: (...args: unknown[]) => { calls.push(['submit', ...args]); }, onDismiss: () => {} };
  const view = render(<moduleUnderTest.GenerationReview review={review} {...props} />);
  assert.ok(screen.getByText('Estimated cost: $0.80 USD'));
  const limit = screen.getByRole('textbox', { name: 'Spending limit (USD)' });
  fireEvent.change(limit, { target: { value: '2.50' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Approve this generation' })); });
  assert.deepEqual(calls, [['approve', 'review-1', { maxAttempts: 1, maxCostUsd: '2.50' }]]);
  assert.equal((screen.getByRole('button', { name: 'Generate once' }) as HTMLButtonElement).disabled, true);
  assert.equal(screen.queryByRole('checkbox'), null);
  view.rerender(<moduleUnderTest.GenerationReview review={{ ...review, approved: true }} {...props} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Generate once' })); });
  assert.deepEqual(calls[1], ['submit', 'review-1']);
  assert.equal((screen.getByRole('button', { name: 'Generate once' }) as HTMLButtonElement).disabled, true);
});

test('privacy blocks stop approval and submission without suggesting a privacy downgrade', async () => {
  let calls = 0;
  render(<moduleUnderTest.GenerationReview review={{ ...review, approved: true, estimatedCostUsd: '0.80', blockers: [{ code: 'zdr-violation-by-account', message: 'Endpoint excluded' }] }} assets={[]} onApprove={() => { calls++; }} onSubmit={() => { calls++; }} onDismiss={() => {}} />);
  assert.ok(screen.getByText(/zero-data-retention privacy setting/i));
  assert.ok(screen.getByText(/requires providers not to retain your data/i));
  assert.ok(screen.getByText(/keep editing/i));
  for (const name of ['Approve this generation', 'Generate once']) {
    const button = screen.getByRole('button', { name }) as HTMLButtonElement;
    assert.equal(button.disabled, true);
    fireEvent.click(button);
  }
  assert.equal(calls, 0);
});

test('a bound frame must be available locally and loaded before approval', () => {
  const bound = { ...review, estimatedCostUsd: '0.80', bindings: { firstFrameAssetId: 'first', lastFrameAssetId: null } };
  const view = render(<moduleUnderTest.GenerationReview review={bound} assets={[]} {...callbacks} />);
  const approval = () => screen.getByRole('button', { name: 'Approve this generation' }) as HTMLButtonElement;
  assert.equal(approval().disabled, true, 'missing metadata must not hide a required frame');
  view.rerender(<moduleUnderTest.GenerationReview review={bound} assets={assets} {...callbacks} />);
  assert.equal(approval().disabled, true, 'wait until the actual image loads');
  fireEvent.load(screen.getByRole('img'));
  assert.equal(approval().disabled, false);
  fireEvent.error(screen.getByRole('img'));
  assert.equal(approval().disabled, true);
  assert.ok(screen.getByText(/image could not be loaded/i));
});

test('external, foreign-project and non-image assets are not loaded or approved', () => {
  for (const candidate of [
    { ...assets[0]!, mediaUrl: 'https://third-party.example/image.png' },
    { ...assets[0]!, mediaUrl: '//third-party.example/image.png' },
    { ...assets[0]!, projectId: 'another-project' },
    { ...assets[0]!, kind: 'video' as const },
  ]) {
    const view = render(<moduleUnderTest.GenerationReview review={{ ...review, estimatedCostUsd: '0', bindings: { firstFrameAssetId: 'first', lastFrameAssetId: null } }} assets={[candidate]} {...callbacks} />);
    assert.ok(screen.queryByRole('img') === null, 'unsafe or unavailable frame must not create an image');
    assert.equal((screen.getByRole('button', { name: 'Approve this generation' }) as HTMLButtonElement).disabled, true);
    view.unmount();
  }
});

test('drawer focuses its title, dismisses by button or Escape, and restores opener focus', () => {
  const opener = document.createElement('button');
  opener.textContent = 'Open review'; document.body.append(opener); opener.focus();
  let dismissed = 0;
  const view = render(<moduleUnderTest.GenerationReview review={review} assets={[]} {...callbacks} onDismiss={() => { dismissed++; }} />);
  assert.ok(document.activeElement === screen.getByRole('heading', { name: 'Review generation' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close review' }));
  assert.equal(dismissed, 1);
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true, cancelable: true }));
  assert.equal(dismissed, 2);
  view.unmount();
  assert.ok(document.activeElement === opener);
  opener.remove();
});

test('an approved snapshot does not pretend its estimate was the granted allowance', () => {
  render(<moduleUnderTest.GenerationReview review={{ ...review, approved: true, estimatedCostUsd: '0.08750' }} assets={[]} {...callbacks} />);
  assert.ok(screen.getByText('Estimated cost: $0.08750 USD'));
  assert.ok(screen.queryByRole('textbox', { name: 'Spending limit (USD)' }) === null);
  assert.ok(screen.getByText(/approved spending limits are enforced by the workspace/i));
});

test('exact review identity and binding identifiers are in expandable details', () => {
  render(<moduleUnderTest.GenerationReview review={review} assets={[]} {...callbacks} />);
  const details = screen.getByText('Review details').closest('details')!;
  assert.equal(details.open, false);
  assert.equal(within(details).getByText('exact-request-hash').textContent, review.requestHash);
  assert.equal(within(details).getByText('review-1').textContent, review.id);
});

test('review shows the exact prompt and controls, including false and zero', () => {
  assert.equal(typeof moduleUnderTest.GenerationReview, 'function', 'GenerationReview must be exported');
  const { container } = render(<moduleUnderTest.GenerationReview review={review} assets={[]} busy={false} {...callbacks} />);
  assert.equal(screen.getByTestId('fl-review-prompt').textContent, review.prompt);
  assert.equal(container.querySelector('script'), null);
  for (const text of ['minimax/hailuo-3', '5 seconds', '2K', '16:9', 'Off']) assert.ok(screen.getByText(text));
  assert.equal(screen.getByText('Seed').nextElementSibling?.textContent, '0');
  assert.ok(screen.getByRole('dialog', { name: 'Review generation' }));
});
