import '../../../packages/shot-editor/test/setup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ContinueShot, type ContinueShotOutcome, type ContinueShotPublicView } from '../src/ContinueShot.tsx';

const PROJECT = '10000000-0000-4000-8000-000000000001';
const SOURCE_SHOT = '40000000-0000-4000-8000-000000000001';
const TAKE = '50000000-0000-4000-8000-000000000001';
const OP = '90000000-0000-4000-8000-000000000001';
const FRAME = '70000000-0000-4000-8000-000000000001';

const view = (patch: Partial<ContinueShotPublicView> = {}): ContinueShotPublicView => ({
  operationId: OP, projectId: PROJECT, status: 'partial', resumable: true, active: false,
  sourceTakeId: TAKE, sourceShotId: SOURCE_SHOT,
  sourceAssetId: '60000000-0000-4000-8000-000000000001', extractedAssetId: FRAME,
  shotId: null, shotRevision: null, nextStep: 'create', blockers: ['CREATE_FAILED'],
  message: 'The next shot was not created.', updatedAt: '2026-10-24T00:00:00.000Z', ...patch,
});

const outcome = (patch: Partial<ContinueShotOutcome> = {}): ContinueShotOutcome => ({
  operationId: OP, projectId: PROJECT, status: 'completed', resumed: true,
  sourceTakeId: TAKE, sourceShotId: SOURCE_SHOT, sourceAssetId: '60000000-0000-4000-8000-000000000001', sourceAssetSha256: 'a'.repeat(64),
  extractedAssetId: FRAME, shotId: '80000000-0000-4000-8000-000000000001', shotRevision: 2,
  firstFrameAssetId: FRAME, lastFrameAssetId: null, nextStep: 'done',
  commandIds: { shotCreate: '80000000-0000-4000-8000-0000000000c1', shotBind: '80000000-0000-4000-8000-0000000000b1' },
  lineage: { sourceTakeId: TAKE, sourceShotId: SOURCE_SHOT, sourceAssetId: '60000000-0000-4000-8000-000000000001', sourceAssetSha256: 'a'.repeat(64), extractedAssetId: FRAME },
  code: null, message: null, resumable: false, ...patch,
});

const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent === label) as HTMLButtonElement | undefined;
const text = () => document.body.textContent ?? '';

test('a recovered continuation shows server progress and lineage with one explicit resume control', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const resumes: string[] = [];
  let settle: (value: ContinueShotOutcome) => void = () => {};
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<ContinueShot
    port={{ continueShot: async () => outcome() }}
    projectId={PROJECT}
    takes={[{ id: TAKE, label: 'Take 1', shotId: SOURCE_SHOT }]}
    recovery={{ phase: 'restored', operationId: OP, view: view(), message: null }}
    onResumeOperation={operationId => { resumes.push(operationId); return new Promise<ContinueShotOutcome>(resolve => { settle = resolve; }); }}
  />));
  await act(async () => {});

  assert.match(text(), /Partial continuation/);
  assert.match(text(), new RegExp(FRAME, 'i'), 'extracted frame is shown');
  assert.match(text(), new RegExp(TAKE, 'i'), 'source take lineage is shown');
  assert.match(text(), /CREATE_FAILED/, 'the blocker code is shown truthfully');

  const resume = button('Resume saved continuation')!;
  assert.ok(resume);
  await act(async () => { resume.click(); resume.click(); await Promise.resolve(); });
  assert.deepEqual(resumes, [OP], 'one UI turn dispatches exactly one resume');
  assert.equal(Boolean(button('Resume saved continuation')), false, 'the pending state removes the control');

  await act(async () => { settle(outcome()); });
  assert.match(text(), /last frame is empty/i);
  await act(async () => root.unmount());
});

test('unknown, blocked and active states never expose an executable resume', async () => {
  for (const snapshot of [view({ status: 'unknown', resumable: false }), view({ status: 'blocked', resumable: false }), view({ status: 'in_progress', active: true, resumable: false })]) {
    document.body.innerHTML = '<div id="root"></div>';
    let resumes = 0;
    const root = createRoot(document.getElementById('root')!);
    await act(async () => root.render(<ContinueShot
      port={{ continueShot: async () => outcome() }}
      projectId={PROJECT}
      takes={[{ id: TAKE, label: 'Take 1', shotId: SOURCE_SHOT }]}
      recovery={{ phase: 'restored', operationId: OP, view: snapshot, message: null }}
      onResumeOperation={async () => { resumes++; return outcome(); }}
    />));
    assert.equal(Boolean(button('Resume saved continuation')), false, `${snapshot.status} must not offer resume`);
    assert.equal(resumes, 0);
    if (snapshot.status === 'unknown') assert.match(text(), /will not be resumed automatically/i);
    if (snapshot.active) assert.match(text(), /another request is already continuing/i);
    await act(async () => root.unmount());
  }
});

test('a failed recovery read offers a read retry and never falls back to a continue POST', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  let retries = 0, posts = 0;
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<ContinueShot
    port={{ continueShot: async () => { posts++; return outcome(); } }}
    projectId={PROJECT}
    takes={[{ id: TAKE, label: 'Take 1', shotId: SOURCE_SHOT }]}
    recovery={{ phase: 'error', operationId: OP, view: null, message: 'Could not read the saved continuation.' }}
    onRetryRecovery={() => { retries++; }}
    onResumeOperation={async () => { posts++; return outcome(); }}
  />));
  assert.match(text(), /Could not read the saved continuation\./);
  await act(async () => { button('Check saved continuation')!.click(); await Promise.resolve(); });
  assert.equal(retries, 1);
  assert.equal(posts, 0);
  assert.equal(Boolean(button('Resume saved continuation')), false);
  await act(async () => root.unmount());
});

test('a completed recovered continuation reports completion without a resume control', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<ContinueShot
    port={{ continueShot: async () => outcome() }}
    projectId={PROJECT}
    takes={[{ id: TAKE, label: 'Take 1', shotId: SOURCE_SHOT }]}
    recovery={{ phase: 'restored', operationId: OP, view: view({ status: 'completed', resumable: false, shotId: '80000000-0000-4000-8000-000000000001', shotRevision: 2, nextStep: 'done', blockers: [] }), message: null }}
  />));
  assert.match(text(), /Completed continuation/);
  assert.equal(Boolean(button('Resume saved continuation')), false);
  await act(async () => root.unmount());
});
