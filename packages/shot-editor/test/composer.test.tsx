import './setup.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ShotEditor } from '../src/index.ts';
import { assets, capabilities, shot } from './fixtures.ts';
import type { SaveShotInput } from '../src/types.ts';

afterEach(cleanup);
test('a compact reference never presents an unavailable saved binding as an empty role', () => {
  render(<ShotEditor shot={{ ...shot, bindings: { ...shot.bindings, lastFrameAssetId: 'missing-owned-image' } }}
    assets={assets} capabilities={capabilities} onSave={async () => ({ revision: 4 })}
    onUpload={async () => assets[0]!} onPrepare={async () => {}} />);
  const summary = screen.getByRole('region', { name: 'End frame' }).querySelector('summary')!;
  assert.match(summary.textContent!, /Unavailable image: missing-owned-image/);
  assert.equal((screen.getByLabelText('End frame image') as HTMLSelectElement).value, 'missing-owned-image');
});

test('compact reference disclosures keep both roles visible and preserve explicit edit/save/review boundaries', async () => {
  const saved: SaveShotInput[] = [];
  const dirty: boolean[] = [];
  let prepares = 0;
  render(<ShotEditor shot={shot} assets={assets} capabilities={capabilities}
    onSave={async input => { saved.push(input); return { revision: 4 }; }}
    onUpload={async () => assets[0]!} onPrepare={async () => { prepares++; }} onDirtyChange={value => dirty.push(value)} />);
  const compatibility = screen.getByRole('region', { name: 'Model compatibility' });
  const actions = screen.getByRole('button', { name: 'Review generation' }).closest('footer')!;
  assert.ok(actions.compareDocumentPosition(compatibility) & document.defaultView!.Node.DOCUMENT_POSITION_FOLLOWING,
    'The composer action row belongs with prompt/settings, before the full diagnostic explanation');
  const references = screen.getByRole('group', { name: 'Frame references' });
  const disclosures = references.querySelectorAll('details');
  assert.equal(disclosures.length, 2, 'Each endpoint has its own compact edit disclosure');
  assert.ok([...disclosures].every(item => !item.open), 'Reference editing starts compact, not in a tall inspector');
  for (const role of ['Start frame', 'End frame']) {
    const frame = within(references).getByRole('region', { name: role });
    const summary = frame.querySelector('summary')!;
    assert.ok(summary, 'Native keyboard-operable reference disclosure');
    assert.match(summary.textContent!, new RegExp(role));
    assert.ok(summary.querySelector('img'), 'Bound reference thumbnail remains visible');
  }
  disclosures[1]!.open = true;
  fireEvent.click(screen.getByRole('button', { name: 'Clear end frame' }));
  assert.equal(dirty.at(-1), true, 'Button-only reference edits still report dirty');
  assert.equal(saved.length, 0, 'Opening or clearing a reference must not save');
  assert.equal((screen.getByRole('button', { name: 'Review generation' }) as HTMLButtonElement).disabled, true);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
  assert.deepEqual(saved[0]!.patch.bindings, { firstFrameAssetId: 'start', lastFrameAssetId: null });
  assert.equal(saved[0]!.patch.prompt, shot.prompt);
  assert.equal(saved[0]!.expectedRevision, shot.revision);
  assert.equal(prepares, 0, 'Save must not become review/approval/submission');
});
