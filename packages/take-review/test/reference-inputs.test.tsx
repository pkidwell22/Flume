import {test} from 'node:test';
import assert from 'node:assert/strict';
import {render,defaults} from './dom';
import {shot,take} from './fixtures';
import type {RecordedInputReference,RecordedInputsState} from '../src/types';

// The package renders supplied data and reports intent. It never fetches, commands or inspects.
const receipt = (status: 'recorded' | 'partial' | 'unknown', references: RecordedInputReference[]): RecordedInputsState =>
  ({phase: 'ready', status, references});

test('a take without recorded inputs renders exactly as before', async () => {
  let reads = 0;
  const ui = await render();
  try {
    assert.match(ui.text(), /Take 1/);
    assert.equal(Boolean(ui.button('Recorded inputs')), false, 'no read control without a receipt source');
    assert.equal(reads, 0);
  } finally { await ui.close(); }
});

test('the disclosure reads on demand only, then shows the recorded roles, ids and digests', async () => {
  const read: string[] = [];
  const states: RecordedInputsState[] = [
    {phase: 'idle'},
    {phase: 'loading'},
    receipt('recorded', [
      {role: 'first_frame', assetId: 'asset-first', sha256: 'a'.repeat(64)},
      {role: 'last_frame', assetId: 'asset-last', sha256: 'b'.repeat(64)},
    ]),
  ];
  let index = 0;
  const props = defaults({recordedInputs: () => states[index]!, onReadRecordedInputs: input => { read.push(input.id); }});
  const ui = await render(props);
  try {
    assert.equal(read.length, 0, 'nothing is read before the disclosure is opened');
    await ui.click(ui.button('Recorded inputs')!);
    assert.deepEqual(read, [take.id], 'one read for this take, by its id');
    assert.equal(read.length, 1, 'opening does not start a request storm');

    index = 1;
    await ui.update(props);
    assert.match(ui.text(), /Reading the recorded review/);

    index = 2;
    await ui.update(props);
    const text = ui.text();
    assert.match(text, /First frame/);
    assert.match(text, /Last frame/);
    assert.match(text, new RegExp('asset-first'));
    assert.match(text, new RegExp('asset-last'));
    assert.match(text, new RegExp('a'.repeat(64)));
    assert.match(text, new RegExp('b'.repeat(64)));
    assert.match(text, /Recorded at review time/);
    assert.match(text, /not a new verification/);
    assert.doesNotMatch(text, /Digest not recorded|Not recorded/);
  } finally { await ui.close(); }
});

test('a same-asset pair keeps both roles visible with the one frozen digest', async () => {
  const ui = await render(defaults({
    recordedInputs: () => receipt('recorded', [
      {role: 'first_frame', assetId: 'asset-both', sha256: 'c'.repeat(64)},
      {role: 'last_frame', assetId: 'asset-both', sha256: 'c'.repeat(64)},
    ]),
    onReadRecordedInputs: () => {},
  }));
  try {
    await ui.click(ui.button('Recorded inputs')!);
    const roles = ui.all('.fl-tr-input-role').map(node => node.textContent);
    assert.deepEqual(roles, ['First frame', 'Last frame']);
    const digests = ui.all('.fl-tr-input-digest').map(node => node.textContent);
    assert.deepEqual(digests, ['c'.repeat(64), 'c'.repeat(64)]);
  } finally { await ui.close(); }
});

test('partial, unknown and recorded-empty states stay honest and never invent an id or digest', async () => {
  let state = receipt('partial', [{role: 'first_frame', assetId: 'asset-first', sha256: null}]);
  const props = defaults({recordedInputs: () => state, onReadRecordedInputs: () => {}});
  const ui = await render(props);
  try {
    await ui.click(ui.button('Recorded inputs')!);
    assert.match(ui.text(), /Partly recorded/);
    assert.match(ui.text(), /Digest not recorded/);
    assert.match(ui.text(), /asset-first/);

    state = receipt('unknown', []);
    await ui.update(props);
    assert.match(ui.text(), /Not recorded/);
    assert.match(ui.text(), /no usable reference record/);
    assert.doesNotMatch(ui.text(), /asset-first|Digest not recorded/);
    assert.equal(ui.all('.fl-tr-input-role').length, 0, 'unknown shows no role rows');

    state = receipt('recorded', []);
    await ui.update(props);
    assert.match(ui.text(), /No references were bound/);
  } finally { await ui.close(); }
});

test('a read failure offers only a retry of the read, and never invokes inspect, select or export', async () => {
  let reads = 0, inspected = 0, selected = 0, exported = 0;
  let state: RecordedInputsState = {phase: 'error', message: 'Could not read the recorded inputs.'};
  const props = defaults({
    recordedInputs: () => state,
    onReadRecordedInputs: () => { reads++; },
    onInspect: async () => { inspected++; return {inspectionId: 'i'}; },
    onSelect: async () => { selected++; },
    onExport: async () => { exported++; },
  });
  const ui = await render(props);
  try {
    await ui.click(ui.button('Recorded inputs')!);
    assert.equal(reads, 1, 'opening a failed disclosure retries the read once');
    assert.match(ui.text(), /Could not read the recorded inputs/);
    await ui.click(ui.button('Try again')!);
    assert.equal(reads, 2, 'retry reads only');
    state = receipt('recorded', [{role: 'first_frame', assetId: 'asset-first', sha256: 'a'.repeat(64)}]);
    await ui.update(props);
    assert.match(ui.text(), /asset-first/);
    assert.equal(inspected, 0, 'reading history never inspects a take');
    assert.equal(selected, 0, 'reading history never selects');
    assert.equal(exported, 0, 'reading history never exports');
    assert.equal(ui.button('Inspect take')?.disabled, true, 'selection controls keep their own authority');
  } finally { await ui.close(); }
});

test('switching to another take reads that take and never shows the previous answer', async () => {
  const read: string[] = [];
  let secondRead = false;
  const nextTake = {...take, id: 'take-b', attemptId: 'attempt-b'};
  const props = defaults({
    takes: [take, nextTake],
    recordedInputs: candidate => candidate.id === take.id
      ? receipt('recorded', [{role: 'first_frame', assetId: 'asset-first', sha256: 'a'.repeat(64)}])
      : secondRead ? receipt('recorded', [{role: 'last_frame', assetId: 'asset-second', sha256: 'b'.repeat(64)}]) : {phase: 'idle'},
    onReadRecordedInputs: candidate => { read.push(candidate.id); },
  });
  const ui = await render(props);
  try {
    const disclosures = ui.all('.fl-tr-inputs button[aria-expanded]') as HTMLButtonElement[];
    assert.equal(disclosures.length, 2, 'each take carries its own disclosure');
    await ui.click(disclosures[1]!);
    assert.deepEqual(read, ['take-b'], 'the second take reads its own attempt');
    assert.doesNotMatch(ui.text(), /asset-first/, 'the other take’s receipt is never shown');
    secondRead = true;
    await ui.update(props);
    assert.match(ui.text(), /asset-second/);
    assert.doesNotMatch(ui.text(), /asset-first/);
  } finally { await ui.close(); }
});

test('a shot change clears the open disclosure so another shot cannot inherit it', async () => {
  let reads = 0;
  let state: RecordedInputsState = {phase: 'idle'};
  const props = defaults({
    recordedInputs: () => state,
    onReadRecordedInputs: () => { reads++; },
  });
  const ui = await render(props);
  try {
    await ui.click(ui.button('Recorded inputs')!);
    assert.equal(reads, 1);
    state = receipt('recorded', [{role: 'first_frame', assetId: 'asset-first', sha256: 'a'.repeat(64)}]);
    await ui.update(props);
    assert.match(ui.text(), /asset-first/);
    await ui.update({...props, shot: {...shot, id: 'shot-b'}, takes: [{...take, shotId: 'shot-b'}]});
    assert.doesNotMatch(ui.text(), /asset-first/);
    assert.equal(Boolean(ui.button('Recorded inputs')), true);
    assert.equal(ui.button('Recorded inputs')?.getAttribute('aria-expanded'), 'false');
    assert.equal(reads, 1, 'a new shot starts closed and silent');
  } finally { await ui.close(); }
});

// ---- Truthful idle and partial-empty copy (03 repair) ----

test('an open disclosure with no current read shows neutral copy and can start exactly one read', async () => {
  let reads = 0, inspected = 0, selected = 0, exported = 0;
  let state: RecordedInputsState = {phase: 'idle'};
  const props = defaults({
    recordedInputs: () => state,
    onReadRecordedInputs: () => { reads++; },
    onInspect: async () => { inspected++; return {inspectionId: 'i'}; },
    onSelect: async () => { selected++; },
    onExport: async () => { exported++; },
  });
  const ui = await render(props);
  try {
    await ui.click(ui.button('Recorded inputs')!);
    assert.equal(reads, 1, 'opening an idle disclosure reads once');
    assert.doesNotMatch(ui.text(), /Reading the recorded review/, 'no progress claim without a current request');
    assert.match(ui.text(), /Not read yet/);
    const again = ui.button('Read recorded inputs');
    assert.equal(Boolean(again), true, 'an open idle panel offers a read control');
    await ui.click(again!);
    assert.equal(reads, 2, 'the open panel reads only when asked');

    state = {phase: 'loading'};
    await ui.update(props);
    assert.match(ui.text(), /Reading the recorded review/, 'progress copy belongs to a current request');

    state = {phase: 'idle'};
    await ui.update(props);
    assert.doesNotMatch(ui.text(), /Reading the recorded review/, 'a superseded read cannot leave a permanent progress claim');
    assert.match(ui.text(), /Not read yet/);
    assert.equal(Boolean(ui.button('Read recorded inputs')), true);
    assert.equal(inspected + selected + exported, 0, 'reading history never touches inspect, select or export');
  } finally { await ui.close(); }
});

test('partial without a retained identity claims nothing about what survived or why it is missing', async () => {
  let state: RecordedInputsState = receipt('partial', []);
  const props = defaults({recordedInputs: () => state, onReadRecordedInputs: () => {}});
  const ui = await render(props);
  try {
    await ui.click(ui.button('Recorded inputs')!);
    let text = ui.text();
    assert.match(text, /Partly recorded/);
    assert.doesNotMatch(text, /survived/, 'an empty partial record cannot claim that some identity survived');
    assert.doesNotMatch(text, /never recorded/, 'the copy cannot assert why details are absent');
    assert.equal(ui.all('.fl-tr-input-role').length, 0, 'nothing is invented for an empty partial record');

    state = receipt('partial', [{role: 'first_frame', assetId: null, sha256: null}]);
    await ui.update(props);
    text = ui.text();
    assert.match(text, /Partly recorded/);
    assert.match(text, /Asset ID not recorded/);
    assert.match(text, /Digest not recorded/);
    assert.doesNotMatch(text, /survived/);
    assert.equal(ui.all('.fl-tr-input-role').length, 1, 'the one role the record carries is still shown');
  } finally { await ui.close(); }
});
