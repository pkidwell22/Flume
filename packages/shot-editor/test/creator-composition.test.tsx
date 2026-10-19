import './setup.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ShotEditor } from '../src/index.ts';
import type { ShotEditorProps, SaveShotInput } from '../src/types.ts';
import { assets, capabilities, shot } from './fixtures.ts';

afterEach(cleanup);
const props = (overrides: Partial<ShotEditorProps> = {}): ShotEditorProps => ({
  shot, assets, capabilities, onSave: async () => ({ revision: 4 }),
  onUpload: async () => assets[0]!, onPrepare: async () => {}, ...overrides,
});
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const chooseModel = (name: string) => {
  fireEvent.click(button('Model'));
  fireEvent.click(screen.getByRole('option', { name }));
};
const insert = (name: string) => {
  fireEvent.click(button('Camera directions'));
  fireEvent.click(button(`Insert ${name}`));
};

test('optional capability metadata is shown literally without changing unsupported or unknown intent', () => {
  const available = { ...capabilities[0]!, aspectRatios: ['16:9', '9:16'], generateAudioSupported: true };
  const p = props({ capabilities: [available] });
  const view = render(<ShotEditor {...p} />);
  const options = () => Array.from(field('Aspect ratio').list?.options ?? [], item => item.value);
  const description = (name: string) => (field(name).getAttribute('aria-describedby') ?? '').split(/\s+/)
    .map(id => document.getElementById(id)?.textContent ?? '').join(' ');
  assert.deepEqual(options(), ['16:9', '9:16'], 'Only supplied ratio metadata becomes suggestions');
  assert.doesNotMatch(description('Aspect ratio'), /unknown/i);
  assert.doesNotMatch(description('Generate audio'), /unknown|not supported/i);
  fireEvent.change(field('Aspect ratio'), { target: { value: ' 21:9 ' } });
  fireEvent.click(field('Generate audio'));
  view.rerender(<ShotEditor {...p} capabilities={[{ ...available, aspectRatios: [], generateAudioSupported: false }]} />);
  assert.deepEqual(options(), []);
  assert.equal(field('Aspect ratio').value, ' 21:9 ');
  assert.equal(field('Generate audio').checked, true);
  assert.match(description('Aspect ratio'), /No aspect ratio options.*listed/);
  assert.match(description('Generate audio'), /not supported/);
  assert.equal(field('Generate audio').disabled, false);
  view.rerender(<ShotEditor {...p} capabilities={capabilities} />);
  assert.deepEqual(options(), []);
  assert.match(description('Aspect ratio'), /support.*unknown/i);
  assert.match(description('Generate audio'), /support.*unknown/i);
  assert.equal(field('Aspect ratio').value, ' 21:9 ');
  assert.equal(field('Generate audio').checked, true);
  chooseModel('Start-only model');
  assert.deepEqual(options(), [], 'Do not keep the previous model’s suggestions');
  assert.match(description('Generate audio'), /support.*unknown/i);
});

test('assembled creator controls use one dirty draft and explicit save then review', async () => {
  const saves: SaveShotInput[] = [];
  const dirty: boolean[] = [];
  const prepares: unknown[] = [];
  const literal = '  Hold <still> @frame #1 $\\ \"雪😀\".\n\n';
  const { container } = render(<ShotEditor {...props({
    shot: { ...shot, prompt: literal },
    onSave: async request => { saves.push(request); return { revision: 4 }; },
    onPrepare: async request => { prepares.push(request); },
    onDirtyChange: value => dirty.push(value),
  })} />);
  assert.ok(screen.queryByRole('button', { name: 'Camera directions' }) !== null,
    'Use the delivered prompt composer in the actual ShotEditor');
  assert.equal(container.querySelectorAll('textarea').length, 1, 'No second prompt buffer');
  assert.equal(container.querySelectorAll('details.fl-shot-editor__reference').length, 2);
  assert.ok([...container.querySelectorAll('details')].every(item => !item.open));
  insert('Dolly in');
  const expected = literal + 'Move the camera toward the subject.';
  assert.equal(field('Prompt').value, expected);
  assert.equal(dirty.at(-1), true, 'Button insertions must report dirty without native input bubbling');
  assert.equal(button('Review generation').disabled, true);
  fireEvent.change(field('Duration (seconds)'), { target: { value: '05.00' } });
  fireEvent.change(field('Seed (optional)'), { target: { value: '000' } });
  fireEvent.click(field('Generate audio'));
  chooseModel('Start-only model');
  assert.equal(field('Prompt').value, expected);
  assert.equal(field('Duration (seconds)').value, '05.00');
  assert.equal(field('Seed (optional)').value, '000');
  assert.equal(field('Generate audio').checked, true);
  assert.equal(field('End frame image').value, 'end');
  assert.equal(saves.length, 0);
  assert.equal(prepares.length, 0);
  await act(async () => fireEvent.click(button('Save changes')));
  assert.equal(saves.length, 1);
  assert.equal(saves[0]!.expectedRevision, 3);
  assert.equal(saves[0]!.patch.prompt, expected);
  assert.deepEqual(saves[0]!.patch.controls, { ...shot.controls, modelId: 'start-only', generateAudio: true });
  assert.deepEqual(saves[0]!.patch.bindings, shot.bindings);
  assert.equal(field('Duration (seconds)').value, '05.00', 'Numeric API conversion must not normalize the edit buffer');
  assert.equal(field('Seed (optional)').value, '000');
  assert.equal(prepares.length, 0, 'Saving does not prepare, approve or submit');
  await act(async () => fireEvent.click(button('Review generation')));
  assert.deepEqual(prepares, [{ projectId: shot.projectId, shotId: shot.id, expectedRevision: 4 }]);
  assert.equal(screen.queryAllByRole('button', { name: /Approve|Submit generation/ }).length, 0);
});
