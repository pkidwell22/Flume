import './setup.tsx';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ActivityPanel, GenerationReview } from '../src/index.ts';
import type { ApprovalLimits, Attempt, Review } from '../src/index.ts';

afterEach(cleanup);
const review: Review = {
  id: 'review-cost-receipt', projectId: 'project', shotId: 'shot', shotRevision: 1,
  requestHash: 'exact-reviewed-request', prompt: 'Keep this exact intent.',
  controls: { modelId: 'fixture/model', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false, seed: 0 },
  bindings: { firstFrameAssetId: null, lastFrameAssetId: null },
  estimatedCostUsd: '0.000001', blockers: [], approved: false,
};
const attempt: Attempt = {
  id: 'attempt-case-SENSITIVE', projectId: 'project', shotId: 'shot', shotRevision: 1,
  status: 'running', providerJobId: null, errorCode: null, message: null,
};
const callbacks = { onApprove: () => {}, onSubmit: () => {}, onDismiss: () => {} };
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

for (const approved of [false, true]) {
  test(`UI-01 unknown cost holds both actions, including approved=${approved}`, async () => {
    const calls: string[] = [];
    render(<GenerationReview review={{ ...review, estimatedCostUsd: null, approved }} assets={[]}
      onApprove={() => { calls.push('approve'); }} onSubmit={() => { calls.push('submit'); }} onDismiss={() => {}} />);
    assert.equal(button('Approve this generation').disabled, true);
    assert.equal(button('Generate once').disabled, true, 'an approval readback cannot bypass the unknown-cost UI hold');
    assert.ok(screen.queryByRole('textbox') === null, 'do not solicit a dollar cap that cannot be checked');
    assert.match(screen.getByRole('dialog').textContent ?? '', /approval is on hold/i);
    assert.match(screen.getByRole('dialog').textContent ?? '', /unknown does not mean free/i);
    await act(async () => {
      fireEvent.click(button('Approve this generation'));
      fireEvent.click(button('Generate once'));
    });
    assert.deepEqual(calls, [], 'no count-only/null approval or paid submission is emitted');
  });
}

test('UI-01 an entered dollar cap is retained through an unknown-cost hold, never replaced by null', async () => {
  const calls: { id: string; limits: ApprovalLimits }[] = [];
  const props = { assets: [], ...callbacks, onApprove: (id: string, limits: ApprovalLimits) => { calls.push({ id, limits }); } };
  const view = render(<GenerationReview review={review} {...props} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '2.500000' } });
  view.rerender(<GenerationReview review={{ ...review, estimatedCostUsd: null }} {...props} />);
  assert.equal(button('Approve this generation').disabled, true);
  await act(async () => fireEvent.click(button('Approve this generation')));
  assert.deepEqual(calls, []);
  view.rerender(<GenerationReview review={review} {...props} />);
  assert.equal((screen.getByRole('textbox') as HTMLInputElement).value, '2.500000');
  await act(async () => fireEvent.click(button('Approve this generation')));
  assert.deepEqual(calls, [{ id: review.id, limits: { maxAttempts: 1, maxCostUsd: '2.500000' } }]);
});

for (const value of ['1000000000', '9999999999.000001', '0.0000001', '1.1234567', '0.000001\n']) {
  test(`UI-01 rejects money outside the server format without repairing ${JSON.stringify(value)}`, async () => {
    let calls = 0;
    render(<GenerationReview review={review} assets={[]} {...callbacks} onApprove={() => { calls++; }} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    // Text inputs strip line breaks natively: raw malformed estimates must still not enable approval.
    if (value.includes('\n')) {
      cleanup();
      render(<GenerationReview review={{ ...review, estimatedCostUsd: value }} assets={[]} {...callbacks} onApprove={() => { calls++; }} />);
    } else {
      fireEvent.change(input, { target: { value } });
      assert.equal(input.value, value);
      assert.equal(input.getAttribute('aria-invalid'), 'true');
    }
    assert.equal(button('Approve this generation').disabled, true);
    await act(async () => fireEvent.click(button('Approve this generation')));
    assert.equal(calls, 0);
  });
}

for (const value of ['0', '0.000000', '0.000001', '2.500000', '999999999.999999']) {
  test(`UI-01 preserves accepted money exactly: ${value}`, async () => {
    let limits: ApprovalLimits | undefined;
    render(<GenerationReview review={{ ...review, estimatedCostUsd: value }} assets={[]} {...callbacks}
      onApprove={(_id, next) => { limits = next; }} />);
    assert.equal((screen.getByRole('textbox') as HTMLInputElement).value, value);
    assert.equal(button('Approve this generation').disabled, false);
    await act(async () => fireEvent.click(button('Approve this generation')));
    assert.deepEqual(limits, { maxAttempts: 1, maxCostUsd: value });
    assert.equal(button('Generate once').disabled, true);
  });
}

test('UI-01 allowance copy distinguishes estimated reservation from provider billing', () => {
  render(<GenerationReview review={review} assets={[]} {...callbacks} />);
  const text = screen.getByRole('dialog').textContent ?? '';
  assert.match(text, /estimated cost within this allowance/i);
  assert.match(text, /not a provider-enforced billing cap/i);
  assert.match(text, /final charge can differ/i);
  assert.doesNotMatch(text, /one attempt within this limit/i);
});

test('UI-01 separate approval/readback/submission preserves an ambiguous outcome hold', async () => {
  const calls: unknown[] = [];
  const props = {
    assets: [], onDismiss: () => {},
    onApprove: (id: string, limits: ApprovalLimits) => { calls.push(['approve', id, limits]); },
    onSubmit: (id: string) => { calls.push(['submit', id]); return Promise.reject(new Error('fixture unknown response')); },
  };
  const view = render(<GenerationReview review={review} {...props} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '4.000001' } });
  await act(async () => fireEvent.click(button('Approve this generation')));
  assert.deepEqual(calls, [['approve', review.id, { maxAttempts: 1, maxCostUsd: '4.000001' }]]);
  assert.equal(button('Generate once').disabled, true, 'callback resolution is not authoritative approval');
  view.rerender(<GenerationReview review={{ ...review, approved: true }} {...props} />);
  assert.equal(calls.length, 1, 'readback does not submit automatically');
  await act(async () => fireEvent.click(button('Generate once')));
  assert.match(screen.getByRole('dialog').textContent ?? '', /provider may have received it/i);
  view.rerender(<GenerationReview review={{ ...review, approved: false }} {...props} />);
  await act(async () => {
    fireEvent.click(button('Approve this generation'));
    fireEvent.click(button('Generate once'));
  });
  assert.deepEqual(calls, [['approve', review.id, { maxAttempts: 1, maxCostUsd: '4.000001' }], ['submit', review.id]]);
  assert.equal(button('Approve this generation').disabled, true);
  assert.equal(button('Generate once').disabled, true);
});

for (const providerJobId of [null, '']) {
  test(`UI-02 running without a usable receipt is confirmation pending: ${JSON.stringify(providerJobId)}`, () => {
    render(<ActivityPanel attempts={[{ ...attempt, providerJobId }]} assets={[]} onResume={() => { throw new Error('no recovery without receipt'); }} />);
    assert.ok(screen.getByRole('heading', { name: 'Confirming submission' }));
    assert.match(screen.getByRole('listitem').textContent ?? '', /acceptance is not confirmed yet/i);
    assert.doesNotMatch(screen.getByRole('listitem').textContent ?? '', /provider is working|\bgenerating\b|\d+%/i);
    assert.equal(screen.queryAllByRole('button').length, 0);
    assert.ok(screen.queryByRole('progressbar') === null);
  });
}

test('UI-02 an arriving receipt changes confirmation to awaiting result, not invented progress', async () => {
  const calls: string[] = [];
  const props = { assets: [], onResume: (id: string) => { calls.push(id); } };
  const view = render(<ActivityPanel attempts={[attempt]} {...props} />);
  assert.ok(screen.getByRole('heading', { name: 'Confirming submission' }));
  view.rerender(<ActivityPanel attempts={[{ ...attempt, providerJobId: 'Receipt-Case-SENSITIVE' }]} {...props} />);
  assert.ok(screen.getByRole('heading', { name: 'Awaiting result' }));
  const text = screen.getByRole('listitem').textContent ?? '';
  assert.match(text, /provider accepted this attempt/i);
  assert.match(text, /execution and completion time are not confirmed/i);
  assert.doesNotMatch(text, /provider is working|\bgenerating\b|\d+%/i);
  assert.equal(screen.getByText('Provider receipt').nextElementSibling?.textContent, 'Receipt-Case-SENSITIVE');
  assert.ok(screen.queryByRole('progressbar') === null);
  await act(async () => fireEvent.click(button('Check existing attempt')));
  assert.deepEqual(calls, [attempt.id]);
});

test('UI-02 ambiguous acceptance without receipt remains on hold and never becomes failed/free', () => {
  render(<ActivityPanel attempts={[{ ...attempt, status: 'acceptance_unknown' }]} assets={[]} onResume={() => { throw new Error('unsafe retry'); }} />);
  assert.ok(screen.getByRole('heading', { name: 'Waiting for confirmation' }));
  const text = screen.getByRole('listitem').textContent ?? '';
  assert.match(text, /keep this attempt on hold; do not resubmit it/i);
  assert.match(text, /not a failed generation/i);
  assert.match(text, /another charge/i);
  assert.doesNotMatch(text, /free retry|provider accepted this attempt/i);
  assert.equal(screen.queryAllByRole('button').length, 0);
});
