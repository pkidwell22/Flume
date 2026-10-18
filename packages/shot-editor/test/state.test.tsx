import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createEditorState,
  editDraft,
  saveDraft,
  startSave,
  finishSave,
  isDirty,
  receiveShot,
  hasConflict,
  reconcile,
} from '../src/editor-state.ts';
import { shot } from './fixtures.ts';

test('explicit save preserves literal prompt, false, zero, and distinct end-frame intent', () => {
  const literal = '  The cup turns.\n\nKeep <camera> still.  ';
  let state = createEditorState(shot);
  state = editDraft(state, { ...state.draft, prompt: literal });
  const request = saveDraft(state);
  assert.equal(request.expectedRevision, 3);
  assert.equal(request.patch.prompt, literal);
  assert.equal(request.patch.controls.seed, 0);
  assert.equal(request.patch.controls.generateAudio, false);
  assert.deepEqual(request.patch.bindings, { firstFrameAssetId: 'start', lastFrameAssetId: 'end' });
  state = finishSave(startSave(state, 1), 1, { revision: 4 });
  assert.equal(state.base.revision, 4);
  assert.equal(state.draft.prompt, literal);
  assert.equal(saveDraft(state).expectedRevision, 4);
});

test('receipt validation refuses to invent a new base revision', () => {
  const state = startSave(createEditorState(shot), 1);
  for (const revision of [3, 2, NaN, Infinity, 3.5]) {
    assert.throws(() => finishSave(state, 1, { revision }), /accepted revision/);
  }
});

test('DTO key order cannot leave a successfully saved shot dirty', () => {
  const reversed = Object.fromEntries(
    Object.entries(shot.controls).reverse(),
  ) as typeof shot.controls;
  let state = createEditorState({ ...shot, controls: reversed });
  state = editDraft(state, { ...state.draft, prompt: 'New literal prompt' });
  state = finishSave(startSave(state, 1), 1, { revision: 4 });
  assert.equal(isDirty(state), false);
});

test('accepted numeric spellings remain clean through same-revision readback without granting a newer base', () => {
  let state = createEditorState(shot);
  state = editDraft(state, { ...state.draft, controls: { ...state.draft.controls, durationSeconds: '05.00', seed: '000' } });
  state = finishSave(startSave(state, 1), 1, { revision: 4 });
  assert.equal(state.draft.controls.durationSeconds, '05.00', 'Receipt must not rewrite literal duration');
  assert.equal(state.draft.controls.seed, '000');
  assert.equal(isDirty(state), false);
  state = receiveShot(state, { ...shot, revision: 4 });
  assert.equal(state.draft.controls.durationSeconds, '05.00', 'GET of accepted revision must not rewrite numeric spelling');
  assert.equal(state.draft.controls.seed, '000');
  assert.equal(isDirty(state), false);
  state = editDraft(state, { ...state.draft, prompt: 'New draft' });
  state = receiveShot(state, { ...shot, revision: 5, prompt: 'Someone else' });
  assert.equal(state.base.revision, 4);
  assert.equal(hasConflict(state), true);
  state = reconcile(state, true);
  assert.equal(state.draft.controls.durationSeconds, '05.00');
  assert.equal(state.base.revision, 5);
  assert.equal(isDirty(state), true);
  state = reconcile(state, false);
  assert.equal(isDirty(state), false);
  assert.equal(state.draft.prompt, 'Someone else');
});

test('successful unchanged numeric input becomes clean without losing edits typed during save',()=>{
 let state=createEditorState(shot);
 state=editDraft(state,{...state.draft,controls:{...state.draft.controls,durationSeconds:'5.0',seed:'00'}});
 const saving=startSave(state,1);
 const saved=finishSave(saving,1,{revision:4});assert.equal(isDirty(saved),false);
 const edited=editDraft(saving,{...saving.draft,prompt:'Newer input while saving'});
 const retained=finishSave(edited,1,{revision:4});assert.equal(retained.draft.prompt,'Newer input while saving');assert.equal(isDirty(retained),true);
});
