import './setup.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PromptComposer } from '../src/PromptComposer.tsx';
import { applyTextareaEdit } from '../src/prompt-insertion.ts';
import { ShotEditor } from '../src/index.ts';
import type { SaveShotInput, SaveShotResult } from '../src/types.ts';
import { assets, capabilities, shot } from './fixtures.ts';

afterEach(cleanup);
const field = () => screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const normalize = (value: string) => value.replace(/\r\n?/g, '\n');
function Harness({ initial, calls }: { initial: string; calls: string[] }) {
  const [value, setValue] = useState(initial);
  return <PromptComposer value={value} onChange={next => { calls.push(next); setValue(next); }} />;
}
function edit(start: number, end: number, inputType: string, next: string) {
  act(() => { field().focus(); field().setSelectionRange(start, end); });
  fireEvent(field(), new window.InputEvent('beforeinput', { bubbles: true, inputType }));
  fireEvent.input(field(), { inputType, target: { value: next } });
}

// PC-01: unchanged source, native ranges and expected canonical strings from the
// independent native counterexamples. The old two-string API cannot express them.
for (const [name, source, start, end, inputType, visible, expected] of [
  ['first deletion', 'A\r\n\nB', 1, 2, 'deleteContentBackward', 'A\nB', 'A\nB'],
  ['second deletion control', 'A\r\n\nB', 2, 3, 'deleteContentBackward', 'A\nB', 'A\r\nB'],
  ['Enter before', 'A\r\nB', 1, 1, 'insertLineBreak', 'A\n\nB', 'A\n\r\nB'],
  ['Enter after control', 'A\r\nB', 2, 2, 'insertLineBreak', 'A\n\nB', 'A\r\n\nB'],
] as const) test(`PC-01 ${name} emits the actual native range once`, () => {
  const calls: string[] = [];
  render(<Harness initial={source} calls={calls} />);
  edit(start, end, inputType, visible);
  assert.deepEqual(calls, [expected]);
  assert.equal(field().value, visible);
});

test('all scalar and mixed-break range pairs retain exact source around pasted replacement', () => {
  const chunks = ['🦆', '\r\n', '\n', '\r', 'e', '\u0301', '\r\n', '👩🏽‍🚀', '中'];
  const source = chunks.join('');
  const raw = [0], native = [0];
  for (const chunk of chunks) {
    raw.push(raw.at(-1)! + chunk.length);
    native.push(native.at(-1)! + normalize(chunk).length);
  }
  for (let i = 0; i < raw.length; i++) for (let j = i; j < raw.length; j++) {
    for (const text of ['', '\n', '🦆\n\ne\u0301']) {
      const expected = source.slice(0, raw[i]) + text + source.slice(raw[j]);
      const visible = normalize(source).slice(0, native[i]) + text + normalize(source).slice(native[j]);
      assert.equal(applyTextareaEdit(source, visible, { start: native[i]!, end: native[j]!, inputType: 'insertFromPaste' }), expected, `${i}:${j}:${JSON.stringify(text)}`);
    }
  }
});

test('collapsed native deletion uses direction and UTF-16 removed length, not a repeated-string diff', () => {
  const source = '🦆\r\n\nB';
  assert.equal(applyTextareaEdit(source, '🦆\nB', { start: 2, end: 2, inputType: 'deleteContentForward' }), '🦆\nB');
  assert.equal(applyTextareaEdit(source, '🦆\nB', { start: 4, end: 4, inputType: 'deleteContentBackward' }), '🦆\r\nB');
  assert.equal(applyTextareaEdit(source, '\n\nB', { start: 2, end: 2, inputType: 'deleteContentBackward' }), '\r\n\nB');
});

test('paste with identical displayed LF still replaces only the selected CRLF in canonical source', () => {
  const calls: string[] = [];
  render(<Harness initial={'🦆\r\n\r\nB'} calls={calls} />);
  edit(2, 3, 'insertFromPaste', '🦆\n\nB');
  assert.deepEqual(calls, ['🦆\n\r\nB']);
});

test('missing and inconsistent ranges cannot rewrite a mixed-ending source', () => {
  const source = 'A\r\n\nB';
  assert.equal(applyTextareaEdit(source, 'A\nB'), source);
  for (const [start, end] of [[-1, 2], [4, 3], [0, 99], [1.5, 2], [0, 0]]) {
    assert.equal(applyTextareaEdit(source, 'A\nB', { start: start!, end: end!, inputType: 'insertText' }), source);
  }
});

test('unsupported operations do not treat the current selection as their edit authority', () => {
  for (const inputType of ['insertFromDrop', 'insertReplacementText', 'deleteEntireSoftLine', 'unknown']) {
    assert.equal(applyTextareaEdit('A\r\nB', 'A\n\nB', { start: 1, end: 1, inputType }), 'A\r\nB');
  }
});

test('history restores the unique recorded raw source and does not infer CRLF from the displayed string', () => {
  const calls: string[] = [];
  render(<Harness initial={'A\r\n\nB'} calls={calls} />);
  edit(1, 2, 'deleteContentBackward', 'A\nB');
  edit(1, 1, 'historyUndo', 'A\n\nB');
  edit(1, 2, 'historyRedo', 'A\nB');
  assert.deepEqual(calls, ['A\nB', 'A\r\n\nB', 'A\nB']);
});

test('ambiguous history fails closed instead of selecting among different literal snapshots', () => {
  const calls: string[] = [];
  render(<Harness initial={'A\r\nB'} calls={calls} />);
  edit(1, 2, 'insertFromPaste', 'A\nB');
  edit(3, 3, 'insertText', 'A\nBx');
  edit(4, 4, 'historyUndo', 'A\nB');
  assert.deepEqual(calls, ['A\nB', 'A\nBx']);
  assert.equal(field().value, 'A\nBx');
});

test('external controlled replacement invalidates source history without emitting a stale undo', () => {
  const calls: string[] = [];
  const view = render(<PromptComposer value={'A\r\nB'} onChange={next => calls.push(next)} />);
  edit(1, 1, 'insertText', 'Ax\nB');
  view.rerender(<PromptComposer value={'SERVER\r\nB'} onChange={next => calls.push(next)} />);
  edit(2, 2, 'historyUndo', 'A\nB');
  assert.deepEqual(calls, ['Ax\r\nB']);
  assert.equal(field().value, 'SERVER\nB');
});

test('native provenance and camera insertion use parent dirty/save/review gates during a held save', async () => {
  const saves: SaveShotInput[] = [], dirty: boolean[] = [], reviews: unknown[] = [];
  let finish!: (result: SaveShotResult) => void;
  render(<ShotEditor shot={{ ...shot, prompt: 'A\r\n\nB' }} assets={assets} capabilities={capabilities}
    onUpload={async () => assets[0]!} onDirtyChange={value => dirty.push(value)}
    onSave={request => { saves.push(request); return new Promise(resolve => { finish = resolve; }); }}
    onPrepare={async request => { reviews.push(request); }} />);
  edit(1, 2, 'deleteContentBackward', 'A\nB');
  assert.equal(dirty.at(-1), true);
  assert.equal(button('Review generation').disabled, true);
  fireEvent.click(button('Save changes'));
  assert.equal(saves[0]!.patch.prompt, 'A\nB');
  assert.equal(saves[0]!.expectedRevision, 3);
  assert.equal(field().disabled, false, 'Save busy must not disable typing');
  edit(1, 1, 'insertLineBreak', 'A\n\nB');
  await act(async () => finish({ revision: 4 }));
  assert.equal(field().value, 'A\n\nB');
  assert.equal(dirty.at(-1), true);
  assert.equal(button('Review generation').disabled, true);
  fireEvent.click(button('Camera directions'));
  fireEvent.click(button('Insert Static shot'));
  const expected = 'A\n\nB Keep the camera still.';
  assert.equal(field().value, expected);
  fireEvent.click(button('Save changes'));
  assert.equal(saves[1]!.patch.prompt, expected);
  assert.equal(saves[1]!.expectedRevision, 4);
  await act(async () => finish({ revision: 5 }));
  assert.equal(dirty.at(-1), false);
  assert.equal(button('Review generation').disabled, false);
  await act(async () => fireEvent.click(button('Review generation')));
  assert.deepEqual(reviews, [{ projectId: shot.projectId, shotId: shot.id, expectedRevision: 5 }]);
});
