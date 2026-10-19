import './setup.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PromptComposer } from '../src/PromptComposer.tsx';

afterEach(cleanup);
const field = () => screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;
function Harness({ initial, calls, echo = 'batch' }: { initial: string; calls: string[]; echo?: 'batch' | 'flush' | 'decline' }) {
  const [value, setValue] = useState(initial);
  return <PromptComposer value={value} onChange={next => {
    calls.push(next);
    if (echo === 'flush') flushSync(() => setValue(next));
    else if (echo === 'batch') setValue(next);
  }} />;
}
function before(start: number, end: number, inputType: string, data: string | null = null) {
  act(() => { field().focus(); field().setSelectionRange(start, end); });
  const event = new window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data });
  fireEvent(field(), event);
  return event;
}
function input(inputType: string, visible: string, data: string | null = null, caret = visible.length) {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field(), visible);
    field().setSelectionRange(caret, caret);
    field().dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType, data }));
  });
}
function edit(start: number, end: number, inputType: string, visible: string, data: string | null = null, caret = visible.length) {
  before(start, end, inputType, data); input(inputType, visible, data, caret);
}
for (const cancelAt of ['target', 'ancestor'] as const) test(`PC-FIX-01 ${cancelAt} canceled same-type beforeinput cannot authorize a later edit`, () => {
  const calls: string[] = [];
  render(<Harness initial={'A\r\nB'} calls={calls} />);
  const target = cancelAt === 'target' ? field() : document;
  target.addEventListener('beforeinput', event => event.preventDefault(), { once: true });
  assert.equal(before(1, 1, 'insertLineBreak').defaultPrevented, true);
  input('insertLineBreak', 'A\n\nB');
  assert.deepEqual(calls, []);
  assert.equal(field().value, 'A\nB');
});
test('PC-FIX-01 different operation or data cannot use an old range', () => {
  const calls: string[] = [];
  render(<Harness initial={'A\r\nB'} calls={calls} />);
  before(1, 1, 'insertText', 'x'); input('insertLineBreak', 'A\n\nB');
  assert.deepEqual(calls, []);
  before(1, 1, 'insertText', 'x'); input('insertText', 'A\n\nB', '\n');
  assert.deepEqual(calls, []);
});
test('PC-FIX-01 unused authority expires before a later task', async () => {
  const calls: string[] = [];
  render(<Harness initial={'A\r\nB'} calls={calls} />);
  before(1, 1, 'insertText', '\n');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  input('insertText', 'A\n\nB', '\n');
  assert.deepEqual(calls, []);
  edit(2, 2, 'insertLineBreak', 'A\n\nB');
  assert.deepEqual(calls, ['A\r\n\nB']);
});

for (const echo of ['batch', 'flush', 'decline'] as const) test(`PC-FIX-02 replacement input data/caret preserves literal suffix with ${echo} echo`, () => {
  const calls: string[] = [];
  render(<Harness initial={'teh\r\ncat'} calls={calls} echo={echo} />);
  input('insertReplacementText', 'the\ncat', 'the', 3);
  assert.deepEqual(calls, ['the\r\ncat']);
  assert.equal(field().value, echo === 'decline' ? 'teh\ncat' : 'the\ncat');
  edit(3, 3, 'insertText', (echo === 'decline' ? 'teh' : 'the') + '!\ncat', '!', 4);
  assert.deepEqual(calls, ['the\r\ncat', (echo === 'decline' ? 'teh' : 'the') + '!\r\ncat']);
});
test('PC-FIX-01/02 canceled range cannot displace a later independently witnessed replacement', () => {
  const calls: string[] = [];
  render(<Harness initial={'A\r\n\nB'} calls={calls} />);
  field().addEventListener('beforeinput', event => event.preventDefault(), { once: true });
  before(1, 1, 'insertLineBreak');
  input('insertReplacementText', 'A\n\n\nB', '\n\n', 4);
  assert.deepEqual(calls, ['A\r\n\n\nB']);
  assert.equal(field().value, 'A\n\n\nB');
});
for (const [data, caret] of [[null, 3], ['WRONG', 3], ['the', 7]] as const) test(`PC-FIX-02 uncertain replacement ${data}/${caret} is accessible and recoverable`, () => {
  const calls: string[] = [];
  render(<Harness initial={'teh\r\ncat'} calls={calls} />);
  input('insertReplacementText', 'the\ncat', data, caret);
  assert.deepEqual(calls, []);
  assert.equal(field().value, 'teh\ncat');
  const warning = screen.getByRole('alert');
  assert.match(warning.textContent!, /not applied/i);
  assert.match(warning.textContent!, /select.*type or paste/i);
  assert.ok(field().getAttribute('aria-describedby')!.split(' ').includes(warning.id));
  const recovery = screen.getByRole('textbox', { name: 'Unapplied prompt edit' }) as HTMLTextAreaElement;
  assert.equal(recovery.value, 'the\ncat'); assert.equal(recovery.readOnly, true);
  edit(0, 3, 'insertFromPaste', 'the\ncat', 'the', 3);
  assert.deepEqual(calls, ['the\r\ncat']); assert.equal(field().value, 'the\ncat');
  assert.equal(screen.queryByRole('alert'), null);
});
test('PC-FIX-02 explicit unsupported edit keeps attempted text without guessing a source splice', () => {
  const calls: string[] = [];
  render(<Harness initial={'A\r\nB'} calls={calls} />);
  edit(1, 1, 'insertFromDrop', 'A\n\nB', '\n', 2);
  assert.deepEqual(calls, []); assert.equal(field().value, 'A\nB');
  assert.equal((screen.getByRole('textbox', { name: 'Unapplied prompt edit' }) as HTMLTextAreaElement).value, 'A\n\nB');
  assert.match(screen.getByRole('alert').textContent!, /not applied/);
});

for (const source of ['AB', 'A\r\nB']) test(`PC-FIX-03 repeated identical snapshots retain Undo/Redo and both possible positions: ${JSON.stringify(source)}`, () => {
  const calls: string[] = [];
  render(<Harness initial={source} calls={calls} />);
  const visible = source.replace(/\r\n?/g, '\n');
  const withText = (s: string) => visible.slice(0, 1) + s + visible.slice(1);
  edit(1, 1, 'insertText', withText('x'), 'x', 2);
  edit(1, 2, 'deleteContentBackward', visible, null, 1);
  edit(1, 1, 'insertText', withText('y'), 'y', 2);
  for (const [type, text] of [['historyUndo', ''], ['historyRedo', 'y'], ['historyUndo', ''], ['historyUndo', 'x'], ['historyUndo', ''], ['historyRedo', 'x'], ['historyRedo', ''], ['historyRedo', 'y']]) {
    edit(1, 1, type!, withText(text!));
    assert.equal(calls.at(-1), source.slice(0, 1) + text + source.slice(1));
    assert.equal(field().value, withText(text!));
    assert.equal(screen.queryByRole('alert'), null);
  }
});
test('PC-FIX-03 distinct canonical histories are visibly rejected, retained and recoverable', () => {
  const calls: string[] = [];
  render(<Harness initial={'A\r\nB'} calls={calls} />);
  edit(1, 2, 'insertFromPaste', 'A\nB');
  edit(3, 3, 'insertText', 'A\nBx', 'x', 4);
  edit(4, 4, 'historyUndo', 'A\nB');
  assert.deepEqual(calls, ['A\nB', 'A\nBx']);
  assert.equal(field().value, 'A\nBx');
  assert.match(screen.getByRole('alert').textContent!, /history is uncertain/);
  assert.equal((screen.getByRole('textbox', { name: 'Unapplied prompt edit' }) as HTMLTextAreaElement).value, 'A\nB');
  edit(3, 4, 'deleteContentBackward', 'A\nB');
  assert.equal(calls.at(-1), 'A\nB'); assert.equal(screen.queryByRole('alert'), null);
});
test('PC-FIX-03 branching at an unresolved index does not choose an old branch', () => {
  const calls: string[] = [];
  render(<Harness initial={'A\r\nB'} calls={calls} />);
  edit(1, 1, 'insertText', 'Ax\nB', 'x');
  edit(1, 2, 'deleteContentBackward', 'A\nB');
  edit(1, 1, 'insertText', 'Ay\nB', 'y');
  edit(1, 1, 'historyUndo', 'A\nB');
  assert.equal(calls.at(-1), 'A\r\nB');
  edit(1, 1, 'insertText', 'Az\nB', 'z');
  edit(1, 1, 'historyUndo', 'A\nB');
  const accepted = [...calls];
  edit(1, 1, 'historyUndo', 'Ax\nB');
  assert.deepEqual(calls, accepted); assert.equal(field().value, 'A\nB');
  assert.match(screen.getByRole('alert').textContent!, /not applied/);
});

test('recovery belongs to its controlled value and cannot reappear after an external replacement cycle', () => {
  const calls: string[] = [];
  const cb = (next: string) => calls.push(next);
  const view = render(<PromptComposer value={'A\r\nB'} onChange={cb} />);
  edit(1, 1, 'insertFromDrop', 'A\n\nB', '\n');
  assert.match(screen.getByRole('alert').textContent!, /not applied/);
  view.rerender(<PromptComposer value={'SERVER\r\nB'} onChange={cb} />);
  assert.ok(screen.queryByRole('alert') === null);
  view.rerender(<PromptComposer value={'A\r\nB'} onChange={cb} />);
  assert.ok(screen.queryByRole('alert') === null);
  assert.deepEqual(calls, []); assert.equal(field().value, 'A\nB');
});
