import './setup.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PromptComposer } from '../src/PromptComposer.tsx';

afterEach(cleanup);
const prompt = () => screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;
const trigger = () => screen.getByRole('button', { name: 'Camera directions' });
function choose(name: string) {
  fireEvent.click(trigger());
  fireEvent.click(screen.getByRole('button', { name: `Insert ${name}` }));
}
function Harness({ initial = '', changes = [] as string[], disabled = false }) {
  const [value, setValue] = useState(initial);
  return <>
    <PromptComposer value={value} disabled={disabled} onChange={next => { changes.push(next); setValue(next); }} />
    <pre data-testid="literal-review">{value}</pre>
  </>;
}
function select(start: number, end = start, direction: 'forward' | 'backward' | 'none' = 'none') {
  act(() => { prompt().focus(); prompt().setSelectionRange(start, end, direction); });
  fireEvent.select(prompt());
}

test('deliberate choices insert in order into the single controlled prompt and restore its caret', () => {
  const changes: string[] = [];
  render(<Harness initial={'  A subject.\n'} changes={changes} />);
  assert.equal(changes.length, 0);
  choose('Dolly in');
  choose('Rack focus');
  const expected = '  A subject.\nMove the camera toward the subject. Shift focus from the foreground to the background.';
  assert.equal(prompt().value, expected);
  assert.equal(screen.getByTestId('literal-review').textContent, expected);
  assert.deepEqual(changes, [
    '  A subject.\nMove the camera toward the subject.',
    expected,
  ]);
  assert.equal(document.activeElement === prompt(), true);
  assert.equal(prompt().selectionStart, expected.length);
  assert.equal(prompt().selectionEnd, expected.length);
  assert.equal(trigger().getAttribute('aria-expanded'), 'false');
});

test('uses the last backward selection, replacing exactly that range and leaving all other literal text intact', () => {
  const before = '  🦆 <script>"$&"\\\\ # @ref\t';
  const after = '\n\n</script>  ';
  const changes: string[] = [];
  render(<Harness initial={before + 'replace\nonly me' + after} changes={changes} />);
  select(before.length, before.length + 'replace\nonly me'.length, 'backward');
  choose('Static shot');
  assert.equal(prompt().value, before + 'Keep the camera still.' + after);
  assert.equal(changes[0], before + 'Keep the camera still.' + after);
  assert.equal(prompt().selectionStart, before.length + 'Keep the camera still.'.length);
  assert.equal(document.querySelector('script') === null, true);
  choose('Dolly out');
  assert.equal(prompt().value, before + 'Keep the camera still. Move the camera away from the subject.' + after);
});

test('preserves a deliberate caret in the middle instead of always appending', () => {
  render(<Harness initial="leftRIGHT" />);
  select(4);
  choose('Arc left');
  assert.equal(prompt().value, 'left Move the camera in an arc to the left around the subject. RIGHT');
  assert.equal(prompt().value.slice(prompt().selectionStart), ' RIGHT');
});

test('opens with focus on the first choice, Escape cancels without editing and returns to the trigger', () => {
  const changes: string[] = [];
  render(<Harness initial="leave this alone" changes={changes} />);
  select(6, 10, 'backward');
  fireEvent.click(trigger());
  assert.equal(document.activeElement === screen.getByRole('button', { name: 'Insert Static shot' }), true);
  assert.equal(trigger().getAttribute('aria-expanded'), 'true');
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  assert.equal(screen.queryByRole('dialog', { name: 'Camera direction guidance' }) === null, true);
  assert.equal(document.activeElement === trigger(), true);
  assert.equal(prompt().value, 'leave this alone');
  assert.deepEqual(changes, []);
  choose('Static shot');
  assert.equal(prompt().value, 'leave Keep the camera still. alone');
});

test('close and leaving the composer dismiss without trapping or stealing focus', () => {
  const changes: string[] = [];
  render(<><Harness initial="unchanged" changes={changes} /><button type="button">Outside</button></>);
  fireEvent.click(trigger());
  fireEvent.click(screen.getByRole('button', { name: 'Close camera directions' }));
  assert.equal(document.activeElement === trigger(), true);
  fireEvent.click(trigger());
  const outside = screen.getByRole('button', { name: 'Outside' });
  act(() => outside.focus());
  assert.equal(trigger().getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement === outside, true);
  assert.deepEqual(changes, []);
});

test('disabled prevents edits and insertion; disabling an open panel closes it without stealing focus', () => {
  const changes: string[] = [];
  const view = render(<><Harness initial="kept" changes={changes} disabled /><button type="button">Outside</button></>);
  assert.equal(prompt().disabled, true);
  assert.equal((trigger() as HTMLButtonElement).disabled, true);
  fireEvent.change(prompt(), { target: { value: 'must not propagate' } });
  fireEvent.click(trigger());
  assert.deepEqual(changes, []);
  assert.equal(trigger().getAttribute('aria-expanded'), 'false');
  view.rerender(<><Harness initial="kept" changes={changes} /><button type="button">Outside</button></>);
  fireEvent.click(trigger());
  view.rerender(<><Harness initial="kept" changes={changes} disabled /><button type="button">Outside</button></>);
  assert.equal(screen.queryByRole('dialog', { name: 'Camera direction guidance' }) === null, true);
  assert.equal(trigger().getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement === prompt(), false);
  view.rerender(<><Harness initial="kept" changes={changes} /><button type="button">Outside</button></>);
  assert.equal(trigger().getAttribute('aria-expanded'), 'false');
  assert.equal(prompt().value, 'kept');
  assert.deepEqual(changes, []);
});

test('external controlled changes cancel an open stale selection rather than editing the wrong text', () => {
  const changes: string[] = [];
  const onChange = (next: string) => changes.push(next);
  const view = render(<PromptComposer value="old selected words" onChange={onChange} />);
  select(4, 12);
  fireEvent.click(trigger());
  view.rerender(<PromptComposer value="new authoritative prompt" onChange={onChange} />);
  assert.equal(prompt().value, 'new authoritative prompt');
  assert.equal(trigger().getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement === trigger(), true);
  assert.deepEqual(changes, []);
  choose('Static shot');
  assert.deepEqual(changes, ['new authoritative prompt Keep the camera still.']);
  assert.equal(prompt().value, 'new authoritative prompt', 'No optimistic hidden copy when the controller declines an edit');
});

test('a delayed controlled echo cannot restore old focus or caret after a declined synchronous edit', () => {
  const changes: string[] = [];
  const onChange = (next: string) => changes.push(next);
  const view = render(<><PromptComposer value="Base" onChange={onChange} /><button type="button">Outside</button></>);
  choose('Static shot');
  assert.equal(prompt().value, 'Base');
  const outside = screen.getByRole('button', { name: 'Outside' });
  act(() => outside.focus());
  view.rerender(<><PromptComposer value={changes[0]!} onChange={onChange} /><button type="button">Outside</button></>);
  assert.equal(document.activeElement === outside, true);
  assert.equal(prompt().value, changes[0]);
});

test('typing is literal, does not interpret # or camera prose, and preserves untouched source line endings', () => {
  const changes: string[] = [];
  render(<Harness initial={'  one\r\ntwo\rthree  '} changes={changes} />);
  const typed = '  one\ntwo # Dolly in <script>"$&"\\\\ @ref\nthree  ';
  select('  one\ntwo'.length);
  fireEvent(prompt(), new window.InputEvent('beforeinput', { bubbles: true, inputType: 'insertText' }));
  fireEvent.input(prompt(), { inputType: 'insertText', target: { value: typed } });
  assert.equal(changes[0], '  one\r\ntwo # Dolly in <script>"$&"\\\\ @ref\rthree  ');
  assert.equal(prompt().value, typed);
  assert.equal(document.querySelector('script') === null, true);
  assert.equal(trigger().getAttribute('aria-expanded'), 'false');
  fireEvent.click(trigger());
  assert.equal(document.querySelector('[aria-pressed]') === null, true, 'Arbitrary prose must not become structured camera selections');
  assert.equal(changes.length, 1);
});

test('each catalog sentence is shown verbatim before insertion, repeats are allowed, and no button submits a form', () => {
  const changes: string[] = [];
  let submits = 0;
  render(<form onSubmit={event => { event.preventDefault(); submits++; }}><Harness changes={changes} /></form>);
  const choices = [
    ['Static shot', 'Keep the camera still.'],
    ['Dolly in', 'Move the camera toward the subject.'],
    ['Dolly out', 'Move the camera away from the subject.'],
    ['Arc left', 'Move the camera in an arc to the left around the subject.'],
    ['Arc right', 'Move the camera in an arc to the right around the subject.'],
    ['Rack focus', 'Shift focus from the foreground to the background.'],
    ['Static shot', 'Keep the camera still.'],
  ];
  for (const [name, sentence] of choices) {
    fireEvent.click(trigger());
    const choice = screen.getByRole('button', { name: `Insert ${name}` });
    assert.equal(document.getElementById(choice.getAttribute('aria-describedby')!)!.textContent, sentence);
    for (const button of screen.getAllByRole('button')) assert.equal(button.getAttribute('type'), 'button');
    fireEvent.click(choice);
  }
  assert.equal(prompt().value, choices.map(([, sentence]) => sentence).join(' '));
  assert.equal(changes.length, choices.length);
  assert.equal(submits, 0);
});

test('multiple instances keep accessible labels and panels local to their own controlled value', () => {
  render(<><div data-testid="first"><Harness initial="First" /></div><div data-testid="second"><Harness initial="Second" /></div></>);
  const first = within(screen.getByTestId('first'));
  const second = within(screen.getByTestId('second'));
  const firstPrompt = first.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;
  const secondPrompt = second.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;
  assert.notEqual(firstPrompt.id, secondPrompt.id);
  fireEvent.click(second.getByRole('button', { name: 'Camera directions' }));
  assert.equal(first.queryByRole('region') === null, true);
  fireEvent.click(second.getByRole('button', { name: 'Insert Static shot' }));
  assert.equal(firstPrompt.value, 'First');
  assert.equal(secondPrompt.value, 'Second Keep the camera still.');
  assert.equal(document.activeElement === secondPrompt, true);
});
