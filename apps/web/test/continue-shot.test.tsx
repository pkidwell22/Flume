import '../../../packages/shot-editor/test/setup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ContinueShot, type ContinueShotOutcome, type ContinueShotPort } from '../src/ContinueShot.tsx';

const PROJECT = '10000000-0000-4000-8000-000000000001';
const SOURCE_SHOT = '40000000-0000-4000-8000-000000000001';
const TAKE = '50000000-0000-4000-8000-000000000001';
const FRAME = '70000000-0000-4000-8000-000000000001';
const NEW_SHOT = '80000000-0000-4000-8000-000000000001';

const outcome = (patch: Partial<ContinueShotOutcome> = {}): ContinueShotOutcome => ({
  operationId: '90000000-0000-4000-8000-000000000001', projectId: PROJECT, status: 'completed', resumed: false,
  sourceTakeId: TAKE, sourceShotId: SOURCE_SHOT, sourceAssetId: '60000000-0000-4000-8000-000000000001', sourceAssetSha256: 'a'.repeat(64),
  extractedAssetId: FRAME, shotId: NEW_SHOT, shotRevision: 2, firstFrameAssetId: FRAME, lastFrameAssetId: null,
  nextStep: 'done', commandIds: { shotCreate: '80000000-0000-4000-8000-0000000000c1', shotBind: '80000000-0000-4000-8000-0000000000b1' },
  lineage: { sourceTakeId: TAKE, sourceShotId: SOURCE_SHOT, sourceAssetId: '60000000-0000-4000-8000-000000000001', sourceAssetSha256: 'a'.repeat(64), extractedAssetId: FRAME },
  code: null, message: null, resumable: false, ...patch,
});

const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent === label) as HTMLButtonElement | undefined;
const takeSelect = () => document.querySelector('select[aria-label="Source take"]') as HTMLSelectElement;
function chooseTake() {
  const select = takeSelect();
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(select, TAKE);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

test('continue-shot is an explicit operator trigger: no take is preselected and nothing runs on mount', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const calls: any[] = [];
  let resolve: (value: ContinueShotOutcome) => void = () => {};
  const port: ContinueShotPort = { continueShot: input => { calls.push(input); return new Promise(r => { resolve = r; }); } };
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<ContinueShot port={port} projectId={PROJECT} takes={[{ id: TAKE, label: 'Take 1 — 5s', shotId: SOURCE_SHOT }]} sourceShot={{ id: SOURCE_SHOT, title: 'Door', prompt: 'A figure enters.' }} />));
  await act(async () => {});

  assert.equal(calls.length, 0, 'mounting the control must not continue anything');
  assert.equal(takeSelect().value, '', 'no take is selected automatically');
  assert.equal(button('Continue from this take')!.disabled, true);
  assert.match(document.body.textContent ?? '', /no generation is submitted/i);

  chooseTake();
  assert.equal(button('Continue from this take')!.disabled, false);
  assert.equal(calls.length, 0, 'selecting a take still does not continue');

  await act(async () => { button('Continue from this take')!.click(); await Promise.resolve(); });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceTakeId, TAKE);
  assert.equal(calls[0].projectId, PROJECT);
  assert.match(calls[0].operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(calls[0].prompt, 'A figure enters.');
  assert.match(document.body.textContent ?? '', /extracting the last frame/i);
  assert.equal(button('Continue from this take')!.disabled, true, 'pending state blocks a second trigger');

  await act(async () => { resolve(outcome({ operationId: calls[0].operationId })); });
  const text = document.body.textContent ?? '';
  assert.match(text, new RegExp(`shot ${NEW_SHOT}`, 'i'));
  assert.match(text, /last frame is empty/i);
  assert.match(text, new RegExp(FRAME, 'i'));
  assert.equal(button('Resume continue'), undefined);
  await act(async () => root.unmount());
});

test('continue-shot renders partial progress and resumes with the same operation id', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const inputs: any[] = [];
  const port: ContinueShotPort = { continueShot: async input => { inputs.push(input); return inputs.length === 1 ? outcome({ operationId: input.operationId, status: 'partial', nextStep: 'create', shotId: null, shotRevision: null, firstFrameAssetId: null, resumable: true, code: 'CREATE_FAILED', message: 'The next shot was not created.' }) : outcome({ operationId: input.operationId, resumed: true }); } };
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<ContinueShot port={port} projectId={PROJECT} takes={[{ id: TAKE, label: 'Take 1', shotId: SOURCE_SHOT }]} sourceShot={{ id: SOURCE_SHOT, title: 'Door', prompt: 'A figure enters.' }} />));
  chooseTake();
  await act(async () => { button('Continue from this take')!.click(); await Promise.resolve(); });

  const partialText = document.body.textContent ?? '';
  assert.match(partialText, /partial/i);
  assert.match(partialText, new RegExp(FRAME, 'i'));
  assert.match(partialText, /not created/i);
  assert.equal(button('Continue from this take')!.disabled, true, 'a partial continuation is resumed, not restarted');

  await act(async () => { button('Resume continue')!.click(); await Promise.resolve(); });
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].operationId, inputs[1].operationId, 'resume reuses the durable operation id');
  assert.equal(inputs[1].sourceTakeId, TAKE);
  assert.match(document.body.textContent ?? '', /last frame is empty/i);
  await act(async () => root.unmount());
});

test('continue-shot keeps failures visible, retries the same operation, and stops retrying when operator action is required', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const inputs: any[] = [];
  const port: ContinueShotPort = { continueShot: async input => {
    inputs.push(input);
    if (inputs.length === 1) throw new Error('Last frame extraction is not configured.');
    if (inputs.length === 2) return outcome({ operationId: input.operationId, status: 'blocked', code: 'EXTRACTION_AMBIGUOUS', message: 'Two derived last frames exist for this take.', shotId: null, extractedAssetId: null, firstFrameAssetId: null, lastFrameAssetId: null, resumable: false });
    throw new Error('must not be called');
  } };
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<ContinueShot port={port} projectId={PROJECT} takes={[{ id: TAKE, label: 'Take 1', shotId: SOURCE_SHOT }]} sourceShot={{ id: SOURCE_SHOT, title: 'Door', prompt: 'A figure enters.' }} />));
  chooseTake();
  await act(async () => { button('Continue from this take')!.click(); await Promise.resolve(); });
  assert.match(document.body.textContent ?? '', /Last frame extraction is not configured\./);
  assert.ok(button('Retry continue'));

  await act(async () => { button('Retry continue')!.click(); await Promise.resolve(); });
  assert.equal(inputs[0].operationId, inputs[1].operationId);
  assert.match(document.body.textContent ?? '', /Two derived last frames exist/i);
  assert.equal(button('Retry continue'), undefined, 'a non-resumable block must not offer another blind retry');
  assert.match(document.body.textContent ?? '', /operator/i);
  assert.equal(inputs.length, 2);
  await act(async () => root.unmount());
});

test('disabled and empty-take states expose the blocked reason instead of continuing', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  let calls = 0;
  const port: ContinueShotPort = { continueShot: async () => { calls++; return outcome(); } };
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<ContinueShot port={port} projectId={PROJECT} takes={[]} disabled blockedReason="The provider worker is busy." />));
  assert.equal(button('Continue from this take')!.disabled, true);
  assert.match(document.body.textContent ?? '', /no project-owned takes are available/i);
  assert.match(document.body.textContent ?? '', /The provider worker is busy\./);
  assert.equal(calls, 0);
  await act(async () => root.unmount());
});
