import './setup.tsx';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ActivityPanel, GenerationReview } from '../src/index.ts';
import type { Attempt, Review } from '../src/index.ts';

afterEach(cleanup);
const review: Review = { id: 'r', projectId: 'p', shotId: 's', shotRevision: 0, requestHash: 'h', prompt: 'Exact intent', controls: { modelId: 'minimax/hailuo-3', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false }, bindings: { firstFrameAssetId: null, lastFrameAssetId: null }, estimatedCostUsd: '0.0500', approved: false, blockers: [] };
const callbacks = { onApprove: () => {}, onSubmit: () => {}, onDismiss: () => {} };
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const attempt: Attempt = { id: 'a', projectId: 'p', shotId: 's', shotRevision: 0, status: 'retrieving', providerJobId: 'job', errorCode: null, message: null };

// Additional coverage of the earlier RED→GREEN behavioral slices.
test('null review renders nothing and triggers no action', () => {
  let calls = 0;
  render(<GenerationReview review={null} assets={[]} onApprove={() => { calls++; }} onSubmit={() => { calls++; }} onDismiss={() => { calls++; }} />);
  assert.ok(screen.queryByRole('dialog') === null);
  assert.equal(calls, 0);
});

test('zero known cost stays an estimate and a literal zero allowance is preserved', async () => {
  let allowance: unknown;
  render(<GenerationReview review={{ ...review, estimatedCostUsd: '0' }} assets={[]} {...callbacks} onApprove={(_id, limits) => { allowance = limits; }} />);
  assert.ok(screen.getByText('Estimated cost: $0.00 USD'));
  await act(async () => fireEvent.click(button('Approve this generation')));
  assert.deepEqual(allowance, { maxAttempts: 1, maxCostUsd: '0' });
});

for (const value of ['', '-1', '1e2', 'NaN', 'Infinity', ' 2 ', '2,50', '.5', '01.5']) {
  test(`allowance rejects ${JSON.stringify(value)} without repairing its literal value`, () => {
    render(<GenerationReview review={review} assets={[]} {...callbacks} />);
    const input = screen.getByRole('textbox', { name: 'Spending limit (USD)' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value } });
    assert.equal(input.value, value);
    assert.equal(button('Approve this generation').disabled, true);
    if (value !== '') assert.equal(input.getAttribute('aria-invalid'), 'true');
  });
}

test('busy prevents both approval and submission but keeps dismissal available', () => {
  let calls = 0;
  const props = { assets: [], busy: true, onApprove: () => { calls++; }, onSubmit: () => { calls++; }, onDismiss: () => { calls++; } };
  const view = render(<GenerationReview review={review} {...props} />);
  assert.equal(button('Approve this generation').disabled, true);
  view.rerender(<GenerationReview review={{ ...review, approved: true }} {...props} />);
  assert.equal(button('Generate once').disabled, true);
  fireEvent.click(button('Generate once'));
  assert.equal(calls, 0);
  fireEvent.click(button('Close review'));
  assert.equal(calls, 1);
});

test('a pending approval ignores duplicate clicks and waits for server-derived approval', async () => {
  let release!: () => void;
  let calls = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  render(<GenerationReview review={review} assets={[]} {...callbacks} onApprove={() => { calls++; return pending; }} />);
  fireEvent.click(button('Approve this generation'));
  fireEvent.click(button('Approve this generation'));
  assert.equal(calls, 1);
  assert.equal(button('Generate once').disabled, true);
  assert.equal(screen.getByRole('textbox').getAttribute('disabled'), '');
  await act(async () => release());
  assert.equal(button('Approve this generation').disabled, true);
  assert.equal(button('Generate once').disabled, true);
});

test('approval rejection never grants authority or leaks callback errors', async () => {
  render(<GenerationReview review={review} assets={[]} {...callbacks} onApprove={() => Promise.reject(new Error('private transport details'))} />);
  await act(async () => fireEvent.click(button('Approve this generation')));
  assert.ok(screen.getByText(/approval could not be confirmed/i));
  assert.ok(screen.queryByText(/private transport details/) === null);
  assert.equal(button('Generate once').disabled, true);
});

test('ambiguous submission remains held and does not offer another paid try', async () => {
  let calls = 0;
  render(<GenerationReview review={{ ...review, approved: true }} assets={[]} {...callbacks} onSubmit={() => { calls++; return Promise.reject(new Error('timeout')); }} />);
  await act(async () => fireEvent.click(button('Generate once')));
  assert.ok(screen.getByText(/provider may have received it/i));
  fireEvent.click(button('Generate once'));
  assert.equal(calls, 1);
  assert.equal(button('Generate once').disabled, true);
});

test('a consumed approval readback cannot re-enable approval on an already submitted snapshot', async () => {
  const view = render(<GenerationReview review={{ ...review, approved: true }} assets={[]} {...callbacks} />);
  await act(async () => fireEvent.click(button('Generate once')));
  view.rerender(<GenerationReview review={{ ...review, approved: false }} assets={[]} {...callbacks} />);
  assert.equal(button('Approve this generation').disabled, true);
  assert.equal(button('Generate once').disabled, true);
});

test('new review identity clears old local state; late old callbacks cannot approve the new intent', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const props = { assets: [], ...callbacks, onApprove: () => pending };
  const view = render(<GenerationReview review={review} {...props} />);
  fireEvent.click(button('Approve this generation'));
  view.rerender(<GenerationReview review={{ ...review, id: 'new', requestHash: 'new-hash', prompt: 'New intent', estimatedCostUsd: null }} {...props} />);
  await act(async () => release());
  assert.equal(screen.getByTestId('fl-review-prompt').textContent, 'New intent');
  assert.ok(screen.queryByRole('textbox') === null);
  assert.ok(screen.getByText(/approval is on hold/i));
  assert.equal(button('Generate once').disabled, true);
  assert.ok(screen.queryByText(/approval requested/i) === null);
});

test('generic and string blockers are displayed and remain blocking after approval', () => {
  render(<GenerationReview review={{ ...review, approved: true, blockers: ['Seed is unsupported', { code: 'model-unavailable', message: 'This model is not available for the account' }] }} assets={[]} {...callbacks} />);
  assert.ok(screen.getByText('Seed is unsupported'));
  assert.ok(screen.getByText('This model is not available for the account'));
  assert.equal(button('Generate once').disabled, true);
});

test('activity busy and pending states disable recovery, including rapid repeats', async () => {
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const onResume = () => { calls++; return pending; };
  const view = render(<ActivityPanel attempts={[attempt]} assets={[]} busy onResume={onResume} />);
  fireEvent.click(button('Check existing attempt'));
  assert.equal(calls, 0);
  view.rerender(<ActivityPanel attempts={[attempt]} assets={[]} busy={false} onResume={onResume} />);
  fireEvent.click(button('Check existing attempt'));
  fireEvent.click(button('Check existing attempt'));
  assert.equal(calls, 1);
  assert.equal(button('Check existing attempt').disabled, true);
  await act(async () => release());
  assert.equal(button('Check existing attempt').disabled, false);
  assert.ok(screen.getByRole('heading', { name: 'Saving your video' }));
});

test('a failed recovery check keeps the existing state and describes uncertainty', async () => {
  render(<ActivityPanel attempts={[attempt]} assets={[]} onResume={() => Promise.reject(new Error('network'))} />);
  await act(async () => fireEvent.click(button('Check existing attempt')));
  assert.ok(screen.getByText(/check could not be confirmed/i));
  assert.ok(screen.getByRole('heading', { name: 'Saving your video' }));
});

for (const status of ['queued', 'running', 'retrieving', 'ready', 'blocked', 'failed', 'acceptance_unknown'] as const) {
  test(`recovery availability for ${status} respects the receipt boundary`, () => {
    for (const providerJobId of [null, 'receipt']) {
      const view = render(<ActivityPanel attempts={[{ ...attempt, status, providerJobId }]} assets={[]} onResume={() => {}} />);
      const expected = status === 'queued' || (providerJobId !== null && status !== 'ready' && status !== 'blocked');
      assert.equal(screen.queryAllByRole('button', { name: 'Check existing attempt' }).length, expected ? 1 : 0);
      view.unmount();
    }
  });
}

test('unrelated media cannot turn ready status into a claimed owned output', () => {
  const assets = [{ id: 'unrelated', projectId: 'another-project', filename: 'sample.mp4', origin: 'sample' as const, kind: 'video' as const, mediaUrl: '/api/media/unrelated', sha256: 'hash', width: 640, height: 360 }];
  const { container } = render(<ActivityPanel attempts={[{ ...attempt, status: 'ready' }]} assets={assets} onResume={() => {}} />);
  assert.ok(screen.getByText(/does not confirm a playable result/i));
  assert.ok(container.querySelector('video') === null);
});
