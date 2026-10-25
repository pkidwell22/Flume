import './setup.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ShotEditor } from '../src/index.ts';
import type { DraftFrameReport, SaveShotInput, ShotEditorProps } from '../src/types.ts';
import { assets, capabilities, shot } from './fixtures.ts';

afterEach(cleanup);

function props(overrides: Partial<ShotEditorProps> = {}): ShotEditorProps {
  return {
    shot,
    assets,
    capabilities,
    onSave: async () => ({ revision: 4 }),
    onUpload: async () => assets[0]!,
    onPrepare: async () => {},
    ...overrides,
  };
}

const draftAsset = { ...assets[1]!, id: 'draft-ref', filename: 'draft-ref.png', mediaUrl: '/api/media/draft-ref' };

async function stageStartFrame() {
  const file = new File(['image bytes'], 'draft-ref.png', { type: 'image/png' });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Upload start frame'), { target: { files: [file] } });
  });
}

test('reports draft frame references so an adjacent preview can show them as unsaved', async () => {
  const reports: DraftFrameReport[] = [];
  render(
    <ShotEditor
      {...props({
        onDraftChange: report => reports.push(report),
        onUpload: async () => draftAsset,
      })}
    />,
  );
  assert.deepEqual(reports.at(-1), {
    shotId: shot.id,
    first: { assetId: 'start', filename: 'cup-start.png', mediaUrl: '/api/media/start' },
    last: { assetId: 'end', filename: 'cup-end.png', mediaUrl: '/api/media/end' },
  }, 'the initial report matches the saved shot');

  await stageStartFrame();

  assert.deepEqual(reports.at(-1), {
    shotId: shot.id,
    first: { assetId: 'draft-ref', filename: 'draft-ref.png', mediaUrl: '/api/media/draft-ref' },
    last: { assetId: 'end', filename: 'cup-end.png', mediaUrl: '/api/media/end' },
  }, 'a staged import is reported with its owned filename and media');
  assert.equal(screen.getByRole('status').textContent!.includes('Unsaved changes'), true);
});

test('clearing a draft frame is reported as an empty reference, never as the saved one', async () => {
  const reports: DraftFrameReport[] = [];
  render(<ShotEditor {...props({ onDraftChange: report => reports.push(report) })} />);
  fireEvent.change(screen.getByLabelText('Start frame image'), { target: { value: '' } });
  assert.deepEqual(reports.at(-1)?.first, null);
  assert.equal(reports.at(-1)?.last?.assetId, 'end');
});

test('the registered save action is the editor save path and stays behind every existing guard', async () => {
  const saves: SaveShotInput[] = [];
  const actions: Array<(() => void) | null> = [];
  const view = render(
    <ShotEditor
      {...props({
        registerSave: action => actions.push(action),
        onUpload: async () => draftAsset,
        onSave: async input => {
          saves.push(input);
          return { revision: 4 };
        },
      })}
    />,
  );
  const action = actions.at(-1);
  assert.equal(typeof action, 'function');

  await act(async () => { action!(); });
  assert.equal(saves.length, 0, 'a clean editor has nothing to save');

  await stageStartFrame();
  const staged = actions.at(-1)!;
  await act(async () => { staged(); });
  assert.equal(saves.length, 1);
  assert.equal(saves[0]!.patch.bindings.firstFrameAssetId, 'draft-ref');
  assert.equal(saves[0]!.expectedRevision, 3);

  await act(async () => { actions.at(-1)!(); });
  assert.equal(saves.length, 1, 'the adjacent surface cannot double-submit the same draft');

  view.unmount();
  assert.equal(actions.at(-1), null, 'unmounting retires the registered action');
});

test('a successful save retires the import instruction and names the saved revision', async () => {
  render(<ShotEditor {...props({ onUpload: async () => draftAsset, onSave: async () => ({ revision: 4 }) })} />);
  await stageStartFrame();
  assert.match(document.body.textContent ?? '', /Imported draft-ref\.png\. Save changes to keep this start frame\./);

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });

  assert.doesNotMatch(document.body.textContent ?? '', /Save changes to keep this start frame/, 'a persisted frame is not told to save again');
  assert.match(document.body.textContent ?? '', /Saved with the shot · revision 4/);
  assert.match(screen.getByRole('status').textContent!, /Saved revision 4/);
});

test('a failed save keeps the instruction to save the imported frame', async () => {
  render(<ShotEditor {...props({ onUpload: async () => draftAsset, onSave: async () => { throw new Error('offline'); } })} />);
  await stageStartFrame();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
  assert.match(document.body.textContent ?? '', /Save changes to keep this start frame/, 'an unconfirmed save is not replaced by a saved claim');
  assert.doesNotMatch(document.body.textContent ?? '', /Saved with the shot/);
});
