/**
 * StoryboardComposer tests. CONTROLLED FIXTURES: the callbacks below stand in for the coordinator's
 * storyboard-proposal HTTP wiring; no server, planner or provider is exercised here.
 */
import '../../../packages/shot-editor/test/setup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { StoryboardComposer, type ComposerProposal } from '../src/StoryboardComposer.tsx';

const projectId = '10000000-0000-4000-8000-000000000001';
const itemIds = [
  '10000000-0000-4000-8000-000000000011',
  '10000000-0000-4000-8000-000000000012',
  '10000000-0000-4000-8000-000000000013',
];

const proposal = (overrides: Partial<ComposerProposal> = {}): ComposerProposal => ({
  id: '10000000-0000-4000-8000-000000000020',
  status: 'draft',
  revision: 0,
  failure: null,
  items: [
    { itemId: itemIds[0], title: 'Threshold', direction: 'Slow push through the doorway.', startDescription: 'Empty hallway at dusk.', endDescription: 'A silhouette fills the frame.', durationSeconds: 4, continuityNotes: 'Warm practical light from the left.', state: 'pending', shotId: null },
    { itemId: itemIds[1], title: 'Kitchen', direction: 'Handheld follow.', startDescription: 'Kettle steam curls.', endDescription: 'A hand reaches the mug.', durationSeconds: 3, continuityNotes: '', state: 'pending', shotId: null },
    { itemId: itemIds[2], title: 'Window', direction: 'Static wide.', startDescription: 'Rain on glass.', endDescription: 'Streetlight blooms.', durationSeconds: 5, continuityNotes: 'Same rain as before.', state: 'pending', shotId: null },
  ],
  ...overrides,
});

function port(overrides: Record<string, unknown> = {}) {
  const calls = { propose: [] as string[], revise: [] as any[], accept: [] as number[], cancel: 0, resume: [] as any[] };
  return {
    calls,
    props: {
      projectId,
      proposal: proposal(),
      onPropose: async (brief: string) => { calls.propose.push(brief); },
      onRevise: async (items: any[], expectedRevision: number) => { calls.revise.push({ items, expectedRevision }); },
      onAccept: async (expectedRevision: number) => { calls.accept.push(expectedRevision); },
      onCancel: async () => { calls.cancel += 1; },
      onResume: async (retryFailed?: boolean) => { calls.resume.push(retryFailed); },
      ...overrides,
    },
  };
}

const button = (label: string | RegExp) => [...document.querySelectorAll('button')].find(node => typeof label === 'string' ? node.textContent === label : label.test(node.textContent ?? '')) as HTMLButtonElement;
const field = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement;
function type(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value);
  node.dispatchEvent(new window.Event('input', { bubbles: true }));
}

async function mount(props: any) {
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<StoryboardComposer {...props} />));
  await act(async () => {});
  return root;
}

test('a draft shows every cut as editable prose with no generation or spend control', async () => {
  const { props, calls } = port();
  const root = await mount(props);

  assert.equal(document.querySelectorAll('fieldset').length, 3);
  assert.equal(field('Title cut 1').value, 'Threshold');
  assert.equal(field('Direction cut 1').value, 'Slow push through the doorway.');
  assert.equal(field('Start description cut 1').value, 'Empty hallway at dusk.');
  assert.equal(field('End description cut 1').value, 'A silhouette fills the frame.');
  assert.equal(field('Duration seconds cut 1').value, '4');
  assert.equal(field('Continuity notes cut 1').value, 'Warm practical light from the left.');
  assert.match(document.body.textContent ?? '', /creates shot records only/i);
  assert.match(document.body.textContent ?? '', /no image or video is generated/i);
  assert.equal([...document.querySelectorAll('button')].some(node => /approve|spend|generate/i.test(node.textContent ?? '')), false);
  assert.equal(calls.accept.length, 0, 'rendering a proposal must never create shots');
  await act(async () => root.unmount());
});

test('edits stay local until saved, bounds block saving and creating, and acceptance uses the reviewed revision', async () => {
  const { props, calls } = port();
  const root = await mount(props);

  await act(async () => type(field('Title cut 1'), 'The Threshold'));
  assert.equal(button('Save edits').disabled, false);
  assert.equal(button(/Create 3 shots/).disabled, true, 'unsaved edits must block creation');

  await act(async () => type(field('Duration seconds cut 2'), '90'));
  assert.match(document.body.textContent ?? '', /Cut 2 must be between 1 and 60 seconds/i);
  assert.equal(button('Save edits').disabled, true);
  assert.equal(button(/Create 3 shots/).disabled, true);

  await act(async () => type(field('Duration seconds cut 2'), '25'));
  assert.equal(button('Save edits').disabled, false);
  await act(async () => button('Save edits').click());
  assert.equal(calls.revise.length, 1);
  assert.equal(calls.revise[0].expectedRevision, 0);
  assert.equal(calls.revise[0].items[0].title, 'The Threshold');
  assert.equal(calls.revise[0].items[1].durationSeconds, 25);
  assert.deepEqual(calls.revise[0].items[0].itemId, itemIds[0]);
  await act(async () => root.unmount());
});

test('the total duration bound blocks saving and names the limit', async () => {
  const { props } = port({
    proposal: proposal({ items: proposal().items.map(item => ({ ...item, durationSeconds: 25 })) }),
    bounds: { minSeconds: 1, maxSeconds: 60, maxShots: 12, maxTotalSeconds: 100 },
  });
  const root = await mount(props);
  assert.equal(button('Save edits').disabled, true, 'an unchanged proposal has nothing to save');

  await act(async () => type(field('Title cut 3'), 'Rain window'));
  assert.equal(button('Save edits').disabled, false, '75s across three cuts is inside the total bound');
  await act(async () => type(field('Duration seconds cut 3'), '55'));
  assert.match(document.body.textContent ?? '', /A proposal is limited to 100 seconds/i);
  assert.equal(button('Save edits').disabled, true);
  assert.equal(button(/Create 3 shots/).disabled, true);
  await act(async () => root.unmount());
});

test('acceptance creates shots only on explicit action, with the reviewed revision', async () => {
  const { props, calls } = port();
  const root = await mount(props);

  await act(async () => button(/Create 3 shots/).click());
  assert.deepEqual(calls.accept, [0]);
  assert.equal(calls.revise.length, 0);
  await act(async () => root.unmount());
});

test('a partial application reports the shots that exist and offers resume instead of a second create', async () => {
  const items = proposal().items.map((item, index) => index === 0 ? { ...item, state: 'created' as const, shotId: '10000000-0000-4000-8000-000000000031' } : item);
  const { props, calls } = port({ proposal: proposal({ status: 'partial', revision: 1, items, failure: { itemId: itemIds[1], code: 'SHOT_SCOPE', message: 'The shot was refused by the project scope guard.' } }) });
  const root = await mount(props);

  assert.match(document.body.textContent ?? '', /1 of 3 shots created/i);
  assert.match(document.body.textContent ?? '', /The shot was refused by the project scope guard/i);
  assert.equal(button(/Create 3 shots/), undefined, 'an accepted proposal cannot be created twice');
  assert.equal(field('Title cut 2'), null, 'an accepted proposal is no longer editable');

  await act(async () => button('Resume applying shots').click());
  assert.deepEqual(calls.resume, [false]);
  await act(async () => button('Cancel proposal').click());
  assert.equal(calls.cancel, 1);
  await act(async () => root.unmount());
});

test('the brief is required before a planner is asked for a shot list', async () => {
  const { props, calls } = port({ proposal: null });
  const root = await mount(props);

  assert.equal(button('Draft shot list').disabled, true);
  await act(async () => type(field('Storyboard brief'), 'Three cuts of a house at dusk.'));
  assert.equal(button('Draft shot list').disabled, false);
  await act(async () => button('Draft shot list').click());
  assert.deepEqual(calls.propose, ['Three cuts of a house at dusk.']);
  await act(async () => root.unmount());
});
