import './setup.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GenerationSettings } from '../src/GenerationSettings.tsx';
import type { GenerationSettingsProps, GenerationSettingsValue } from '../src/GenerationSettings.tsx';
import { draftFromShot } from '../src/editor-state.ts';
import { capabilities, shot } from './fixtures.ts';

afterEach(cleanup);
const initial = (): GenerationSettingsValue => draftFromShot(shot).controls;
const input = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
function props(overrides: Partial<GenerationSettingsProps> = {}): GenerationSettingsProps {
  return { value: initial(), capability: capabilities[0], onChange: () => {}, ...overrides };
}
function Controlled({ observe = () => {} }: { observe?: GenerationSettingsProps['onChange'] }) {
  const [value, setValue] = useState(initial);
  return <GenerationSettings {...props()} value={value} onChange={(key, next) => {
    observe(key, next);
    setValue((current) => ({ ...current, [key]: next }));
  }} />;
}

test('controlled edits report only the changed key and wait for a parent value', () => {
  const changes: unknown[] = [];
  const original = Object.freeze(initial());
  const p = props({ value: original, onChange: (key, value) => changes.push([key, value]) });
  const view = render(<GenerationSettings {...p} />);
  fireEvent.change(input('Duration (seconds)'), { target: { value: '05.00' } });
  assert.deepEqual(changes, [['durationSeconds', '05.00']]);
  assert.equal(input('Duration (seconds)').value, '5', 'the parent owns the draft');
  view.rerender(<GenerationSettings {...p} value={{ ...original, durationSeconds: '05.00' }} />);
  assert.equal(input('Duration (seconds)').value, '05.00');
  assert.equal(original.durationSeconds, '5');
});

test('editing preserves literal numeric spelling, zero, false, and seed clearing', () => {
  const changes: unknown[] = [];
  render(<Controlled observe={(key, value) => changes.push([key, value])} />);
  for (const [label, key, values] of [
    ['Duration (seconds)', 'durationSeconds', ['05.00', '5.', '.5', '0', '', ' 5 ', '1e2']],
    ['Seed (optional)', 'seed', ['0007', '0', '', '-', '1e3', '9007199254740993']],
    ['Resolution', 'resolution', ['unlisted', '', ' 2K ']],
    ['Aspect ratio', 'aspectRatio', ['21:9', '', ' 16:9 ']],
  ] as const) {
    for (const value of values) {
      fireEvent.change(input(label), { target: { value } });
      assert.deepEqual(changes.at(-1), [key, value]);
      assert.equal(input(label).value, value);
    }
  }
  assert.equal(input('Generate audio').checked, false);
  fireEvent.click(input('Generate audio'));
  assert.deepEqual(changes.at(-1), ['generateAudio', true]);
  fireEvent.click(input('Generate audio'));
  assert.deepEqual(changes.at(-1), ['generateAudio', false]);
  assert.equal(input('Generate audio').checked, false);
  fireEvent.change(input('Seed (optional)'), { target: { value: '0' } });
  const clear = screen.getByRole('button', { name: 'Clear seed' });
  clear.focus();
  fireEvent.click(clear);
  assert.deepEqual(changes.at(-1), ['seed', '']);
  assert.equal(input('Seed (optional)').value, '');
  assert.ok(document.activeElement === clear, 'clear keeps keyboard focus after the parent update');
});

function options(label: string) {
  const list = input(label).list;
  return list ? Array.from(list.options, (option) => option.value) : [];
}
function describedBy(label: string) {
  return (input(label).getAttribute('aria-describedby') ?? '').split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
}

test('current capability options update without replacing unsupported intent or focused input', () => {
  const changes: unknown[] = [];
  const value = { ...initial(), durationSeconds: '05.00', resolution: '2K', seed: '0' };
  const p = props({ value, onChange: (key, next) => changes.push([key, next]) });
  const view = render(<GenerationSettings {...p} />);
  assert.deepEqual(options('Duration (seconds)'), ['5', '10']);
  assert.deepEqual(options('Resolution'), ['2K', '1080p']);
  assert.doesNotMatch(describedBy('Duration (seconds)'), /not listed/i);
  const duration = input('Duration (seconds)');
  duration.focus();
  duration.setSelectionRange(1, 4);
  const reduced = { ...capabilities[0]!, durations: [6], resolutions: ['720p'], seedSupported: false };
  view.rerender(<GenerationSettings {...p} capability={reduced} />);
  assert.deepEqual(options('Duration (seconds)'), ['6']);
  assert.deepEqual(options('Resolution'), ['720p']);
  assert.equal(duration.value, '05.00');
  assert.equal(input('Resolution').value, '2K');
  assert.equal(input('Seed (optional)').value, '0');
  assert.equal(input('Generate audio').checked, false);
  assert.match(describedBy('Duration (seconds)'), /not listed/i);
  assert.match(describedBy('Duration (seconds)'), /Listed durations: 6 seconds/);
  assert.match(describedBy('Resolution'), /not listed/i);
  assert.match(describedBy('Resolution'), /Listed resolutions: 720p/);
  assert.match(describedBy('Seed (optional)'), /does not support a seed/i);
  assert.ok(document.activeElement === duration, 'metadata refresh retains focus');
  assert.equal(duration.selectionStart, 1);
  assert.equal(duration.selectionEnd, 4);
  assert.equal(duration.disabled, false);
  assert.equal(input('Seed (optional)').disabled, false);
  assert.deepEqual(changes, [], 'metadata never edits the draft');
  fireEvent.change(duration, { target: { value: '6' } });
  assert.deepEqual(changes, [['durationSeconds', '6']], 'listed values remain explicitly selectable');
  view.rerender(<GenerationSettings {...p} capability={reduced} value={{ ...value, durationSeconds: '6' }} />);
  assert.doesNotMatch(describedBy('Duration (seconds)'), /not listed/i);
});

test('missing or stale capability metadata is unknown; no aspect/audio presets are invented', () => {
  const changes: unknown[] = [];
  const p = props({ onChange: (key, value) => changes.push([key, value]) });
  const view = render(<GenerationSettings {...p} />);
  for (const label of ['Aspect ratio', 'Generate audio']) {
    assert.match(describedBy(label), /support.*unknown/i);
    assert.ok(input(label).list === null);
  }
  for (const capability of [undefined, null, capabilities[1]]) {
    view.rerender(<GenerationSettings {...p} capability={capability} />);
    assert.deepEqual(options('Duration (seconds)'), []);
    assert.deepEqual(options('Resolution'), []);
    assert.match(describedBy('Duration (seconds)'), /support.*unknown/i);
    assert.match(describedBy('Seed (optional)'), /support.*unknown/i);
    assert.equal(input('Duration (seconds)').value, '5');
    assert.equal(input('Seed (optional)').value, '0');
  }
  assert.deepEqual(changes, []);
  assert.ok(screen.queryByLabelText('Model') === null, 'model picker is composed separately');
});

test('empty catalogs expose no fallback options and blank duration is not treated as zero', () => {
  const p = props({ capability: { ...capabilities[0]!, durations: [0], resolutions: [] } });
  const view = render(<GenerationSettings {...p} value={{ ...initial(), durationSeconds: '' }} />);
  assert.match(describedBy('Duration (seconds)'), /not listed/i);
  assert.match(describedBy('Resolution'), /no resolution options.*listed/i);
  assert.deepEqual(options('Resolution'), []);
  view.rerender(<GenerationSettings {...p} value={{ ...initial(), durationSeconds: '0' }} />);
  assert.doesNotMatch(describedBy('Duration (seconds)'), /not listed/i);
  view.rerender(<GenerationSettings {...p} capability={{ ...p.capability!, durations: [] }} />);
  assert.match(describedBy('Duration (seconds)'), /no duration options.*listed/i);
  assert.deepEqual(options('Duration (seconds)'), []);
});

test('parent validation errors are associated with the exact fields without replacing drafts', () => {
  const errors = { duration: 'Blank is not zero.', seed: 'Use a whole number.' };
  const value = { ...initial(), durationSeconds: '', seed: '-' };
  const p = props({ value, errors });
  const view = render(<GenerationSettings {...p} />);
  for (const [label, message] of [['Duration (seconds)', errors.duration], ['Seed (optional)', errors.seed]]) {
    assert.equal(input(label!).getAttribute('aria-invalid'), 'true');
    assert.ok(describedBy(label!).includes(message!));
  }
  assert.equal(input('Duration (seconds)').value, '');
  assert.equal(input('Seed (optional)').value, '-');
  view.rerender(<GenerationSettings {...p} errors={{}} />);
  assert.equal(input('Duration (seconds)').getAttribute('aria-invalid'), 'false');
  assert.doesNotMatch(describedBy('Duration (seconds)'), /Blank is not zero/);
});

test('the audio value surface toggles the checkbox instead of requiring a tiny click target', () => {
  const changes: unknown[] = [];
  render(<Controlled observe={(key, value) => changes.push([key, value])} />);
  fireEvent.click(screen.getByText('Off'));
  assert.equal(input('Generate audio').checked, true);
  assert.deepEqual(changes, [['generateAudio', true]]);
  fireEvent.click(screen.getByText('On'));
  assert.equal(input('Generate audio').checked, false);
  assert.deepEqual(changes.at(-1), ['generateAudio', false]);
});

test('independent bars have unique labels, hints and suggestion lists', () => {
  const p = props({ value: { ...initial(), durationSeconds: '7' }, errors: { seed: 'Invalid seed.' } });
  const { container } = render(<><GenerationSettings {...p} /><GenerationSettings {...p} /></>);
  const ids = Array.from(container.querySelectorAll('[id]'), (node) => node.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const element of container.querySelectorAll('input')) {
    const bar = element.closest('.fl-generation-settings')!;
    assert.ok(bar.querySelector(`label[for="${element.id}"]`));
    for (const id of (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean))
      assert.ok(bar.contains(document.getElementById(id)));
    if (element.list) assert.ok(bar.contains(element.list));
  }
});

