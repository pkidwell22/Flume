import '../../../packages/shot-editor/test/setup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ChatPanel, type ChatPort } from '../src/ChatPanel.tsx';

test('shot edit mode is explicit, blocked for dirty state, and renders immutable before/after review', async () => {
  document.body.innerHTML = '<div id="root"></div>'; Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const projectId = '10000000-0000-4000-8000-000000000001', shotId = '10000000-0000-4000-8000-000000000002', conversationId = '10000000-0000-4000-8000-000000000003'; let proposed = 0, applied = 0;
  const proposal = { id: '10000000-0000-4000-8000-000000000004', shotId, instruction: 'Make it specific', before: { title: 'Door', prompt: 'A figure enters', revision: 3 }, after: { title: 'Threshold', prompt: 'A silhouette crosses.' }, rationale: 'Clearer action.', status: 'pending' as const, appliedRevision: null, failure: null };
  const port: ChatPort = { models: async () => ['google/gemini-2.5-flash-lite'], list: async () => [{ id: conversationId, projectId, title: 'Scene', modelId: 'google/gemini-2.5-flash-lite', messages: [], proposals: [] }], create: async () => { throw Error('unused'); }, rename: async () => { throw Error('unused'); }, stream: async () => {}, propose: async () => { proposed++; return proposal; }, applyProposal: async () => { applied++; return { ...proposal, status: 'applied', appliedRevision: 4 }; }, dismissProposal: async () => ({ ...proposal, status: 'dismissed' }) };
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<ChatPanel port={port} project={{ id: projectId, name: 'Film' }} shot={{ id: shotId, title: 'Door', revision: 3 }} dirty={true} blocked={true} assets={[]} />)); await act(async () => {});
  const mode = [...document.querySelectorAll('button')].find(button => button.textContent === 'Suggest shot edit') as HTMLButtonElement;
  assert.equal(mode.disabled, true); assert.equal(proposed, 0);
  await act(async () => root.render(<ChatPanel port={port} project={{ id: projectId, name: 'Film' }} shot={{ id: shotId, title: 'Door', revision: 3 }} dirty={false} blocked={false} assets={[]} />));
  await act(async () => mode.click());
  const instruction = document.querySelector('textarea[aria-label="Shot edit instruction"]') as HTMLTextAreaElement;
  act(() => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(instruction, 'Make it specific'); instruction.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText' })); });
  const request = [...document.querySelectorAll('button')].find(button => button.textContent === 'Request proposal') as HTMLButtonElement;
  await act(async () => request.click());
  assert.equal(proposed, 1); assert.match(document.body.textContent ?? '', /Before.*Door.*A figure enters/s); assert.match(document.body.textContent ?? '', /After.*Threshold.*A silhouette crosses/s);
  const apply = [...document.querySelectorAll('button')].find(button => button.textContent === 'Apply') as HTMLButtonElement; await act(async () => apply.click()); assert.equal(applied, 1); assert.match(document.body.textContent ?? '', /saved revision 4/i);
  await act(async () => root.unmount());
});

test('proposal failure preserves the operator instruction', async () => {
  document.body.innerHTML = '<div id="root"></div>'; Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const id = '10000000-0000-4000-8000-000000000001'; const port: ChatPort = { models: async () => ['google/gemini-2.5-flash-lite'], list: async () => [{ id, projectId: id, title: 'Scene', modelId: 'google/gemini-2.5-flash-lite', messages: [], proposals: [] }], create: async () => { throw Error('unused'); }, rename: async () => { throw Error('unused'); }, stream: async () => {}, propose: async () => { throw Error('Strict response rejected.'); }, applyProposal: async () => { throw Error('unused'); }, dismissProposal: async () => { throw Error('unused'); } };
  const root = createRoot(document.getElementById('root')!); await act(async () => root.render(<ChatPanel port={port} project={{ id, name: 'Film' }} shot={{ id, title: 'Door', revision: 1 }} dirty={false} blocked={false} assets={[]} />)); await act(async () => {});
  await act(async () => ([...document.querySelectorAll('button')].find(b => b.textContent === 'Suggest shot edit') as HTMLButtonElement).click()); const input = document.querySelector('textarea[aria-label="Shot edit instruction"]') as HTMLTextAreaElement; act(() => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Keep this wording'); input.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText' })); }); await act(async () => ([...document.querySelectorAll('button')].find(b => b.textContent === 'Request proposal') as HTMLButtonElement).click()); assert.equal(input.value, 'Keep this wording'); assert.match(document.body.textContent ?? '', /Strict response rejected/);
  await act(async () => root.unmount());
});

test('reopened applying and reconciliation proposals expose explicit same-command recovery', async () => {
  document.body.innerHTML = '<div id="root"></div>'; Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const projectId = '10000000-0000-4000-8000-000000000001', shotId = '10000000-0000-4000-8000-000000000002', conversationId = '10000000-0000-4000-8000-000000000003';
  const base = { id: '10000000-0000-4000-8000-000000000004', shotId, instruction: 'Keep it', before: { title: 'Door', prompt: 'Enter', revision: 3 }, after: { title: 'Threshold', prompt: 'Cross' }, rationale: 'Specific', appliedRevision: null, failure: 'Outcome unknown.' };
  let calls = 0;
  const port: ChatPort = { models: async () => ['google/gemini-2.5-flash-lite'], list: async () => [{ id: conversationId, projectId, title: 'Scene', modelId: 'google/gemini-2.5-flash-lite', messages: [], proposals: [{ ...base, status: 'reconciliation' as const }] }], create: async () => { throw Error('unused'); }, rename: async () => { throw Error('unused'); }, stream: async () => {}, propose: async () => { throw Error('unused'); }, applyProposal: async () => { calls++; return { ...base, status: 'applied', appliedRevision: 4 }; }, dismissProposal: async () => { throw Error('unused'); } };
  const root = createRoot(document.getElementById('root')!); await act(async () => root.render(<ChatPanel port={port} project={{ id: projectId, name: 'Film' }} shot={{ id: shotId, title: 'Door', revision: 3 }} dirty={false} blocked={false} assets={[]} />)); await act(async () => {});
  assert.match(document.body.textContent ?? '', /may complete a prior mutation/i);
  const reconcile = [...document.querySelectorAll('button')].find(button => button.textContent === 'Reconcile same save') as HTMLButtonElement;
  await act(async () => reconcile.click()); assert.equal(calls, 1); assert.match(document.body.textContent ?? '', /saved revision 4/i);
  await act(async () => root.unmount());
});

test('authoritative apply calls parent refresh, reports readback failure, and does not repeat apply', async () => {
  document.body.innerHTML = '<div id="root"></div>'; Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const id = '10000000-0000-4000-8000-000000000001'; let applies = 0, refreshes = 0;
  const proposal = { id, shotId: id, instruction: 'Keep it', before: { title: 'Door', prompt: 'Enter', revision: 1 }, after: { title: 'Threshold', prompt: 'Cross' }, rationale: 'Specific', status: 'pending' as const, appliedRevision: null, failure: null };
  const port: ChatPort = { models: async () => ['google/gemini-2.5-flash-lite'], list: async () => [{ id, projectId: id, title: 'Scene', modelId: 'google/gemini-2.5-flash-lite', messages: [], proposals: [proposal] }], create: async () => { throw Error('unused'); }, rename: async () => { throw Error('unused'); }, stream: async () => {}, propose: async () => { throw Error('unused'); }, applyProposal: async () => { applies++; return { ...proposal, status: 'applied', appliedRevision: 2 }; }, dismissProposal: async () => { throw Error('unused'); } };
  const root = createRoot(document.getElementById('root')!); await act(async () => root.render(<ChatPanel port={port} project={{ id, name: 'Film' }} shot={{ id, title: 'Door', revision: 1 }} dirty={false} blocked={false} assets={[]} onApplied={async () => { refreshes++; throw Error('readback failed'); }} />)); await act(async () => {});
  await act(async () => ([...document.querySelectorAll('button')].find(button => button.textContent === 'Apply') as HTMLButtonElement).click());
  assert.equal(applies, 1); assert.equal(refreshes, 1); assert.match(document.body.textContent ?? '', /applied.*saved state could not be refreshed/i); assert.match(document.body.textContent ?? '', /saved revision 2/i);
  assert.equal([...document.querySelectorAll('button')].some(button => button.textContent === 'Apply'), false);
  await act(async () => root.unmount());
});

test('late proposal and action completions are fenced by current shot and unmount', async () => {
  document.body.innerHTML = '<div id="root"></div>'; Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const projectId = '10000000-0000-4000-8000-000000000001', a = '10000000-0000-4000-8000-000000000002', b = '10000000-0000-4000-8000-000000000003', conversationId = '10000000-0000-4000-8000-000000000004';
  let resolve!: (value: any) => void; const pending = new Promise<any>(done => { resolve = done; });
  const port: ChatPort = { models: async () => ['google/gemini-2.5-flash-lite'], list: async () => [{ id: conversationId, projectId, title: 'Scene', modelId: 'google/gemini-2.5-flash-lite', messages: [], proposals: [] }], create: async () => { throw Error('unused'); }, rename: async () => { throw Error('unused'); }, stream: async () => {}, propose: async () => pending, applyProposal: async () => pending, dismissProposal: async () => pending };
  const root = createRoot(document.getElementById('root')!); const render = (shotId: string) => root.render(<ChatPanel port={port} project={{ id: projectId, name: 'Film' }} shot={{ id: shotId, title: shotId === a ? 'A' : 'B', revision: 1 }} dirty={false} blocked={false} assets={[]} />);
  await act(async () => render(a)); await act(async () => {}); await act(async () => ([...document.querySelectorAll('button')].find(x => x.textContent === 'Suggest shot edit') as HTMLButtonElement).click());
  const input = document.querySelector('textarea[aria-label="Shot edit instruction"]') as HTMLTextAreaElement; act(() => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Keep instruction'); input.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText' })); });
  await act(async () => ([...document.querySelectorAll('button')].find(x => x.textContent === 'Request proposal') as HTMLButtonElement).click());
  await act(async () => render(b)); await act(async () => resolve({ id: a, shotId: a, instruction: 'Keep instruction', before: { title: 'A', prompt: '', revision: 1 }, after: { title: 'Changed', prompt: 'Changed' }, rationale: '', status: 'pending', appliedRevision: null, failure: null }));
  assert.doesNotMatch(document.body.textContent ?? '', /Changed/); assert.equal((document.querySelector('textarea[aria-label="Shot edit instruction"]') as HTMLTextAreaElement).value, 'Keep instruction');
  await act(async () => root.unmount());
});
