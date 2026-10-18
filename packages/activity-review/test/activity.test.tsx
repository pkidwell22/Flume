import './setup.tsx';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as moduleUnderTest from '../src/index.ts';
import type { Attempt } from '../src/types.ts';

afterEach(cleanup);
const attempt: Attempt = { id: 'attempt-1', projectId: 'project-1', shotId: 'shot-1', shotRevision: 0, status: 'queued', providerJobId: null, errorCode: null, message: null };
test('only safely addressable attempts offer recovery; no paid retry is exposed', async () => {
  const calls: string[] = [];
  const attempts: Attempt[] = [
    { ...attempt, id: 'recoverable', status: 'retrieving', providerJobId: 'job-1' },
    { ...attempt, id: 'unknown-no-receipt', status: 'acceptance_unknown' },
    { ...attempt, id: 'blocked', status: 'blocked', providerJobId: 'job-2', errorCode: 'zdr-violation-by-account' },
  ];
  render(<moduleUnderTest.ActivityPanel attempts={attempts} assets={[]} onResume={id => { calls.push(id); }} />);
  assert.ok(screen.getByText(/no provider receipt/i));
  assert.ok(screen.getByText(/zero-data-retention privacy setting/i));
  assert.equal(screen.getAllByRole('button').length, 1);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check existing attempt' })); });
  assert.deepEqual(calls, ['recoverable']);
  assert.ok(screen.getByText(/check requested/i));
});

test('empty activity invites a concrete action without an invented attempt', () => {
  render(<moduleUnderTest.ActivityPanel attempts={[]} assets={[]} busy={false} onResume={() => {}} />);
  assert.ok(screen.getByText('No generations yet'));
  assert.ok(screen.getByText(/prepare a generation review/i));
  assert.equal(screen.queryAllByRole('listitem').length, 0);
});

const cases = [
  ['queued', 'Waiting to start', /not a progress estimate/i],
  ['running', 'Confirming submission', /no reliable completion time/i],
  ['retrieving', 'Saving your video', /not ready to inspect yet/i],
  ['ready', 'Check Takes', /does not confirm a playable result/i],
  ['blocked', 'Generation blocked', /keep editing/i],
  ['failed', 'Attempt stopped', /new generation needs a new review/i],
  ['acceptance_unknown', 'Waiting for confirmation', /another charge/i],
] as const;
for (const [status, title, detail] of cases) {
  test(`activity explains ${status} without made-up progress or completion`, () => {
    assert.equal(typeof moduleUnderTest.ActivityPanel, 'function', 'ActivityPanel must be exported');
    render(<moduleUnderTest.ActivityPanel attempts={[{ ...attempt, status }]} assets={[]} busy={false} onResume={() => {}} />);
    assert.ok(screen.getByRole('heading', { name: title }));
    assert.ok(screen.getByText(detail));
    assert.equal(screen.queryByRole('progressbar'), null);
    assert.equal(screen.queryByText(/100%|\bComplete\b|free retry/i), null);
  });
}
