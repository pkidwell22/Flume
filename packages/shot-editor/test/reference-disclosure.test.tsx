import './setup.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ShotEditor } from '../src/ShotEditor.tsx';
import { assets, capabilities, shot } from './fixtures.ts';

afterEach(cleanup);
const trigger = (role: string) => screen.getByLabelText(`${role} frame reference`);
const details = (role: string) => trigger(role).closest('details')!;
const field = (role: string) => screen.getByLabelText(`${role} frame image`) as HTMLSelectElement;
function mount() {
  const calls: unknown[] = [], dirty: boolean[] = [];
  const view = render(<ShotEditor shot={shot} assets={assets} capabilities={capabilities}
    onSave={async value => { calls.push(value); return { revision: 4 }; }}
    onUpload={async value => { calls.push(value); return assets[1]!; }}
    onPrepare={async value => { calls.push(value); }} onDirtyChange={value => dirty.push(value)} />);
  return { calls, dirty, view };
}

for (const role of ['Start', 'End']) test(`A13 explicit ${role} close restores only its summary without dirtying or business calls`, () => {
  const h = mount();
  const other = role === 'Start' ? 'End' : 'Start';
  fireEvent.click(trigger(role)); fireEvent.click(trigger(other));
  assert.equal(details(role).open, true); assert.equal(details(other).open, true);
  const close = screen.getByRole('button', { name: `Close ${role.toLowerCase()} frame picker` });
  close.focus(); fireEvent.click(close);
  assert.equal(details(role).open, false); assert.equal(details(other).open, true);
  assert.ok(document.activeElement === trigger(role), 'close restores its own trigger');
  assert.equal(field('Start').value, 'start'); assert.equal(field('End').value, 'end');
  assert.deepEqual(h.calls, []); assert.deepEqual(h.dirty, []);
});

for (const role of ['Start', 'End']) test(`A13 ${role} Escape is scoped, non-destructive and repeatable`, () => {
  const h = mount(); const other = role === 'Start' ? 'End' : 'Start';
  fireEvent.click(trigger(other));
  for (let i = 0; i < 3; i++) {
    fireEvent.click(trigger(role)); field(role).focus();
    const bubbles: string[] = [];
    const handler = (e: KeyboardEvent) => bubbles.push(e.key);
    document.addEventListener('keydown', handler);
    try { fireEvent.keyDown(field(role), { key: 'Escape' }); }
    finally { document.removeEventListener('keydown', handler); }
    assert.equal(details(role).open, false); assert.equal(details(other).open, true);
    assert.ok(document.activeElement === trigger(role), 'Escape restores matching summary');
    assert.deepEqual(bubbles, [], 'handled Escape does not cancel an outer surface');
  }
  fireEvent.keyDown(trigger(role), { key: 'Escape' });
  assert.equal(details(other).open, true, 'closed role cannot dismiss another role');
  assert.deepEqual(h.calls, []); assert.deepEqual(h.dirty, []);
});

test('A13 close after explicit same-image reuse retains both roles and synchronous dirty authority', () => {
  const h = mount(); fireEvent.click(trigger('End'));
  fireEvent.change(field('End'), { target: { value: 'start' } });
  assert.deepEqual(h.dirty, [true]);
  fireEvent.click(screen.getByRole('button', { name: 'Close end frame picker' }));
  assert.equal(field('Start').value, 'start'); assert.equal(field('End').value, 'start');
  assert.deepEqual(h.dirty, [true]); assert.deepEqual(h.calls, []);
  fireEvent.click(trigger('End'));
  assert.equal(field('End').value, 'start');
});

test('A13 default-prevented child Escape remains owned by the child', () => {
  mount(); fireEvent.click(trigger('End')); field('End').focus();
  field('End').addEventListener('keydown', event => event.preventDefault(), { once: true });
  fireEvent.keyDown(field('End'), { key: 'Escape' });
  assert.equal(details('End').open, true);
  assert.ok(document.activeElement === field('End'));
});

test('A13 closing pending replacement preserves old ID and import completion never reopens or steals focus', async () => {
  let resolve!: (asset: typeof assets[number]) => void;
  render(<ShotEditor shot={shot} assets={assets} capabilities={capabilities}
    onSave={async () => ({ revision: 4 })} onPrepare={async () => {}}
    onUpload={() => new Promise(yes => { resolve = yes; })} />);
  fireEvent.click(trigger('End'));
  const file = new File(['fixture'], 'replace.png', { type: 'image/png' });
  fireEvent.change(screen.getByLabelText('Upload end frame'), { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: 'Close end frame picker' }));
  assert.equal(field('End').value, 'end');
  assert.match(details('End').parentElement!.textContent!, /Importing replace.png/);
  screen.getByLabelText('Prompt').focus();
  await act(async () => resolve({ ...assets[1]!, id: 'new', filename: 'new.png' }));
  assert.equal(field('End').value, 'new'); assert.equal(details('End').open, false);
  assert.ok(document.activeElement === screen.getByLabelText('Prompt'));
  assert.equal((within(screen.getByRole('region', { name: 'Shot editor' })).getByRole('button', { name: 'Review generation' }) as HTMLButtonElement).disabled, true);
});
