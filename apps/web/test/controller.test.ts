import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceController } from '../src/controller.ts';
import type { Command, Receipt, Workspace } from '../src/types.ts';
import { createEditorState, editDraft, finishSave, hasConflict, isDirty, receiveShot, saveDraft, startSave } from '../../../packages/shot-editor/src/editor-state.ts';

const project = { id: 'project-a', name: 'Morning study', brief: '', revision: 1 };
const shot = { id: 'shot-a', projectId: project.id, title: 'Opening', prompt: 'Still camera.', revision: 3,
  controls: { modelId: 'minimax/hailuo-3', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false, seed: 0 },
  bindings: { firstFrameAssetId: null, lastFrameAssetId: null }, selectedTakeId: null, selectionRevision: 0 };
const take = { id: 'take-a', projectId: project.id, shotId: shot.id, attemptId: 'attempt-a', assetId: 'asset-a', createdAt: '2026-01-01T00:00:00Z' };
function workspace(p = project) { return { project: p, shots: [{ ...shot, projectId: p.id }], assets: [], takes: [], attempts: [], reviews: [], exports: [], capabilities: [] }; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function client(overrides = {}) { return { listProjects: async () => [project], getWorkspace: async () => workspace(), command: async () => ({}), uploadAsset: async () => { throw new Error('Unexpected upload'); }, ...overrides }; }

test('opens a real workspace and ignores an obsolete project response', async () => {
  const old = deferred<ReturnType<typeof workspace>>();
  const other = { ...project, id: 'project-b', name: 'Second project' };
  const api = client({ getWorkspace: (id: string) => id === project.id ? old.promise : Promise.resolve(workspace(other)) });
  const store = new WorkspaceController(api as never);
  const first = store.openProject(project.id);
  await store.openProject(other.id);
  old.resolve(workspace());
  await first;
  assert.equal(store.getSnapshot().workspace?.project?.id, other.id);
  assert.equal(store.getSnapshot().phase, 'ready');
});

test('saves with the editor base revision and preserves edits during POST and readback', async () => {
  const post = deferred<any>(); const read = deferred<any>(); const seen: any[] = [];
  let reading = false;
  const store = new WorkspaceController(client({
    command: async (command: any) => { seen.push(command); return post.promise; },
    getWorkspace: async () => reading ? read.promise : workspace(),
  }) as never);
  await store.openProject(project.id);
  store.markDirty(shot.id);
  const saving = store.saveShot(shot.id, 3, { prompt: 'A', controls: { seed: 0, generateAudio: false }, bindings: { lastFrameAssetId: null } });
  store.markDirty(shot.id); // B while the POST is held.
  reading = true;
  post.resolve({ commandId: seen[0].commandId, projectId: project.id, revision: 4 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.getSnapshot().dirtyShotIds.has(shot.id), true);
  store.markDirty(shot.id); // C while the follow-up GET is held.
  read.resolve({ ...workspace(), shots: [{ ...shot, prompt: 'A', revision: 4 }] });
  await saving;
  assert.equal(store.getSnapshot().dirtyShotIds.has(shot.id), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].expectedRevision, 3);
  assert.equal(seen[0].patch.controls.seed, 0);
  assert.equal(seen[0].patch.controls.generateAudio, false);
  assert.deepEqual(seen[0].patch.bindings, { lastFrameAssetId: null });
  assert.equal(store.getSnapshot().workspace?.shots[0].revision, 4);
});

test('a revision conflict never rewrites the submitted patch or loses unsaved state', async () => {
  let captured: any;
  const conflict = Object.assign(new Error('This shot changed in another window.'), { code: 'REVISION_CONFLICT', currentRevision: 7, status: 409 });
  const store = new WorkspaceController(client({ command: async (value: any) => { captured = value; throw conflict; } }) as never);
  await store.openProject(project.id);
  store.markDirty(shot.id);
  await assert.rejects(store.saveShot(shot.id, 3, { prompt: 'Keep this draft' }), /another window/);
  assert.equal(captured.expectedRevision, 3);
  assert.equal(store.getSnapshot().error?.currentRevision, 7);
  assert.equal(store.getSnapshot().error?.code, 'REVISION_CONFLICT');
  assert.equal(store.getSnapshot().dirtyShotIds.has(shot.id), true);
  assert.equal(store.getSnapshot().uncertainCommand, null);
});

test('network ambiguity holds new writes and explicit retry reuses the literal command ID', async () => {
  const seen: any[] = [];
  const store = new WorkspaceController(client({ command: async (value: any) => {
    seen.push(value);
    if (seen.length === 1) throw new TypeError('Network connection lost');
    return { commandId: value.commandId, projectId: project.id, revision: 4 };
  } }) as never);
  await store.openProject(project.id);
  await assert.rejects(store.saveShot(shot.id, 3, { prompt: 'A' }));
  assert.ok(store.getSnapshot().uncertainCommand);
  await assert.rejects(store.saveShot(shot.id, 3, { prompt: 'B' }), /previous request/);
  await store.retryUncertain();
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], seen[0]);
  assert.match(seen[0].commandId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  assert.equal(store.getSnapshot().uncertainCommand, null);
});

test('an accepted save returns its revision despite failed readback, without replaying the write', async () => {
  let posts = 0; let reads = 0;
  const store = new WorkspaceController(client({
    command: async (value: any) => { posts++; return { commandId: value.commandId, projectId: project.id, revision: 4 }; },
    getWorkspace: async () => { reads++; if (reads === 2) throw new TypeError('Readback lost'); return workspace(); },
  }) as never);
  await store.openProject(project.id);
  const accepted = await store.saveShot(shot.id, 3, { prompt: 'A' });
  assert.equal(accepted.revision, 4);
  assert.equal(accepted.prompt, 'A');
  assert.equal(store.getSnapshot().workspace?.shots[0].revision, 3); // Do not invent a GET.
  assert.equal(store.getSnapshot().error?.code, 'READBACK_FAILED');
  assert.equal(store.getSnapshot().uncertainCommand, null);
  await store.refresh();
  assert.equal(posts, 1);
});

test('an accepted save keeps the newer editor draft after failed GET and fences the next save with its revision', async t => {
  const currentProject = { ...project, id: '11111111-1111-4111-8111-111111111111' };
  let currentShot = { ...shot, id: '22222222-2222-4222-8222-222222222222', projectId: currentProject.id };
  const post = deferred<Receipt>(); const read = deferred<Workspace>(); const reading = deferred<void>();
  const commands: Command[] = []; let reads = 0;
  const store = new WorkspaceController({
    listProjects: async () => [currentProject],
    getWorkspace: async () => {
      if (++reads === 2) { reading.resolve(); return read.promise; }
      return { ...workspace(currentProject), shots: [currentShot] };
    },
    command: async command => {
      commands.push(structuredClone(command));
      assert.equal(command.type, 'shot.update');
      if (command.type !== 'shot.update') throw new Error('Unexpected command');
      if (commands.length === 1) return post.promise;
      assert.equal(command.expectedRevision, 4, 'the next edit must use the accepted revision, not the stale GET snapshot');
      assert.equal(command.patch.prompt, 'B typed during pending save');
      currentShot = { ...currentShot, prompt: command.patch.prompt, revision: 5 };
      return { commandId: command.commandId, projectId: currentProject.id, revision: 5 };
    },
    uploadAsset: async () => { throw new Error('Unexpected upload'); },
  });
  await store.openProject(currentProject.id);
  let editor = createEditorState(currentShot);
  t.after(store.subscribe(() => {
    const latest = store.getSnapshot().workspace?.shots[0];
    if (latest) editor = receiveShot(editor, latest);
  }));
  const typePrompt = (prompt: string) => {
    editor = editDraft(editor, { ...editor.draft, prompt });
    store.markDirty(currentShot.id);
  };
  typePrompt('A submitted');
  const first = saveDraft(editor);
  editor = startSave(editor, 1);
  const saving = store.saveShot(first.shotId, first.expectedRevision, first.patch).then(result => {
    editor = finishSave(editor, 1, result);
    return result;
  });
  typePrompt('B typed during pending save');
  assert.equal(editor.draft.prompt, 'B typed during pending save');
  assert.equal(editor.saving?.submitted.patch.prompt, 'A submitted');
  assert.equal(editor.base.revision, 3);
  assert.equal(isDirty(editor), true);
  assert.equal(store.getSnapshot().busy, 'shot.update');

  post.resolve({ commandId: commands[0].commandId, projectId: currentProject.id, revision: 4 });
  await reading.promise;
  // Assert POST preservation before GET completion so a later edit cannot mask loss.
  assert.equal(editor.draft.prompt, 'B typed during pending save');
  assert.equal(isDirty(editor), true);
  assert.equal(store.getSnapshot().dirtyShotIds.has(currentShot.id), true);
  read.reject(new TypeError('Readback lost after accepted save'));
  const accepted = await saving;
  assert.equal(accepted.revision, 4);
  assert.equal(accepted.prompt, 'A submitted');
  assert.equal(editor.base.revision, 4);
  assert.equal(editor.base.prompt, 'A submitted');
  assert.equal(editor.draft.prompt, 'B typed during pending save');
  assert.equal(editor.saving, null);
  assert.equal(isDirty(editor), true);
  assert.equal(hasConflict(editor), false);
  assert.equal(store.getSnapshot().dirtyShotIds.has(currentShot.id), true);
  assert.equal(store.getSnapshot().workspace?.shots[0].revision, 3);
  assert.equal(store.getSnapshot().workspace?.shots[0].prompt, shot.prompt);
  assert.equal(store.getSnapshot().error?.code, 'READBACK_FAILED');
  assert.match(store.getSnapshot().error?.message ?? '', /accepted.*Refresh.*do not submit it again/);
  assert.equal(store.getSnapshot().uncertainCommand, null);
  assert.equal(store.getSnapshot().busy, null);
  await store.retryUncertain(); // A known accepted write is not an unknown command to replay.
  assert.equal(commands.length, 1);
  assert.equal(reads, 2);

  // Explicitly save B before any successful recovery GET. Use the real editor's base.
  const next = saveDraft(editor);
  assert.equal(next.expectedRevision, 4);
  editor = startSave(editor, 2);
  const saved = await store.saveShot(next.shotId, next.expectedRevision, next.patch);
  editor = finishSave(editor, 2, saved);
  assert.equal(commands.length, 2);
  assert.notEqual(commands[1].commandId, commands[0].commandId);
  assert.equal(reads, 3);
  assert.equal(editor.base.revision, 5);
  assert.equal(editor.draft.prompt, 'B typed during pending save');
  assert.equal(isDirty(editor), false);
  assert.equal(store.getSnapshot().dirtyShotIds.has(currentShot.id), false);
});

test('upload owns media without assigning either frame role', async () => {
  const asset = { id: 'asset-a', projectId: project.id, filename: 'start.png', kind: 'image', origin: 'imported', sha256: 'digest', mediaUrl: '/api/media/asset-a', width: 640, height: 480 };
  const calls: any[] = []; let uploaded = false;
  const store = new WorkspaceController(client({
    command: async (command: any) => { calls.push(command); },
    uploadAsset: async (file: File, id: string) => { assert.equal(id, project.id); assert.equal(file.name, 'start.png'); uploaded = true; return asset; },
    getWorkspace: async () => ({ ...workspace(), assets: uploaded ? [asset] : [] }),
  }) as never);
  await store.openProject(project.id);
  const owned = await store.uploadAsset(new File(['test bytes'], 'start.png', { type: 'image/png' }));
  assert.equal(owned.id, asset.id);
  assert.deepEqual(calls, []);
  assert.deepEqual(store.getSnapshot().workspace?.shots[0].bindings, { firstFrameAssetId: null, lastFrameAssetId: null });
  assert.match(store.getSnapshot().notice ?? '', /choose.*frame/i);
});

test('generation prepare, approval and one submit are distinct server-backed actions', async () => {
  const state: any = workspace(); const calls: any[] = [];
  const review = { id: 'review-a', projectId: project.id, shotId: shot.id, shotRevision: shot.revision, requestHash: 'hash', prompt: shot.prompt, controls: shot.controls, bindings: shot.bindings, estimatedCostUsd: null, blockers: [], approved: false };
  const store = new WorkspaceController(client({ getWorkspace: async () => structuredClone(state), command: async (command: any) => {
    calls.push(command);
    if (command.type === 'generation.prepare') state.reviews = [review];
    if (command.type === 'generation.approve') state.reviews = [{ ...review, approved: true }];
    if (command.type === 'generation.submit') state.attempts = [{ id: 'attempt-a', projectId: project.id, shotId: shot.id, shotRevision: 3, status: 'blocked', providerJobId: null, errorCode: 'zdr-violation-by-account', message: 'Account privacy policy excludes this route.' }];
    return { commandId: command.commandId, projectId: project.id, reviewId: review.id, attemptId: command.type === 'generation.submit' ? 'attempt-a' : undefined };
  } }) as never);
  await store.openProject(project.id);
  store.markDirty(shot.id);
  await assert.rejects(store.prepare(shot.id, 3), /Save/);
  store.clearDirty(shot.id); // The editor explicitly discarded its buffer.
  await store.prepare(shot.id, 3);
  assert.deepEqual(calls.map(x => x.type), ['generation.prepare']);
  await assert.rejects(store.submit(review.id), /Approve/);
  await store.approve(review.id, { maxAttempts: 1, maxCostUsd: '5.00' });
  assert.equal(store.getSnapshot().workspace?.reviews[0].approved, true);
  assert.equal(calls.length, 2);
  await store.submit(review.id);
  await assert.rejects(store.submit(review.id), /already submitted/);
  assert.deepEqual(calls.map(x => x.type), ['generation.prepare', 'generation.approve', 'generation.submit']);
  assert.equal(store.getSnapshot().workspace?.attempts[0].status, 'blocked');
  assert.equal(store.getSnapshot().workspace?.shots[0].selectedTakeId, null);
  assert.equal(store.getSnapshot().workspace?.takes.length, 0);
});

test('take selection requires an explicit inspection receipt and uses both revision fences', async () => {
  const state: any = workspace(); const calls: any[] = [];
  state.takes = [{ id: 'take-a', projectId: project.id, shotId: shot.id, attemptId: 'attempt-a', assetId: 'asset-a', createdAt: '2026-01-01T00:00:00Z' }];
  const store = new WorkspaceController(client({ getWorkspace: async () => structuredClone(state), command: async (command: any) => {
    calls.push(command);
    if (command.type === 'take.select') state.shots[0] = { ...shot, selectedTakeId: 'take-a', selectionRevision: 1 };
    if (command.type === 'export.create') state.exports = [{ id: 'export-a', projectId: project.id, shotId: shot.id, takeId: 'take-a', shotRevision: 3, selectionRevision: 1, status: 'queued', stale: false, assetId: null }];
    return { commandId: command.commandId, projectId: project.id, resourceId: 'inspection-a' };
  } }) as never);
  await store.openProject(project.id);
  await assert.rejects(store.selectTake(shot.id, 'take-a', 3, 0), /Inspect/);
  await assert.rejects(store.exportShot(shot.id, 3, 0), /Select/);
  const inspection = await store.inspectTake('take-a');
  assert.equal(inspection.inspectionId, 'inspection-a');
  assert.equal(store.getSnapshot().workspace?.shots[0].selectedTakeId, null);
  await store.selectTake(shot.id, 'take-a', 3, 0, inspection.inspectionId);
  await store.exportShot(shot.id, 3, 1);
  assert.equal(calls[1].expectedRevision, 3);
  assert.equal(calls[1].expectedSelectionRevision, 0);
  assert.equal(calls[1].inspectionId, 'inspection-a');
  assert.equal(calls[2].expectedSelectionRevision, 1);
  assert.equal(store.getSnapshot().workspace?.exports[0].status, 'queued');
});

test('accepted submit stays single-use when readback fails', async () => {
  const review = { id: 'review-a', projectId: project.id, shotId: shot.id, shotRevision: 3, requestHash: 'h', prompt: shot.prompt, controls: shot.controls, bindings: shot.bindings, estimatedCostUsd: null, blockers: [], approved: true };
  let reads = 0; let writes = 0;
  const store = new WorkspaceController(client({ getWorkspace: async () => { if (++reads === 2) throw new TypeError('read failed'); return { ...workspace(), reviews: [review] }; }, command: async (value: any) => { writes++; return { commandId: value.commandId, projectId: project.id, attemptId: 'a' }; } }) as never);
  await store.openProject(project.id);
  await assert.rejects(store.submit(review.id));
  await assert.rejects(store.submit(review.id), /already submitted/);
  assert.equal(writes, 1);
});

test('creates a project and a shot by receipts, then restores them from server state', async () => {
  let created = false; let shotCreated = false; const commands: any[] = [];
  const api = client({ listProjects: async () => created ? [project] : [], getWorkspace: async () => ({ ...workspace(), project: created ? project : null, shots: shotCreated ? [shot] : [] }), command: async (command: any) => {
    commands.push(command);
    if (command.type === 'project.create') created = true;
    if (command.type === 'shot.create') shotCreated = true;
    return { commandId: command.commandId, projectId: project.id, resourceId: command.type === 'project.create' ? project.id : shot.id };
  } });
  const store = new WorkspaceController(api as never);
  await store.start();
  assert.equal(store.getSnapshot().workspace?.project, null);
  await store.createProject('Morning study', 'Real brief');
  await store.createShot('Opening', 'Still camera.');
  assert.equal(store.getSnapshot().activeShotId, shot.id);
  assert.equal(store.getSnapshot().projects[0].id, project.id);
  assert.equal(commands[0].brief, 'Real brief');
  const reopened = new WorkspaceController(api as never);
  await reopened.start(project.id);
  assert.equal(reopened.getSnapshot().workspace?.shots[0].id, shot.id);
});

test('dirty navigation is blocked until a deliberate discard; resume is explicit', async () => {
  const state: any = workspace(); state.shots.push({ ...shot, id: 'shot-b' });
  state.attempts = [{ id: 'attempt-a', projectId: project.id, shotId: shot.id, shotRevision: 3, status: 'acceptance_unknown', providerJobId: null, errorCode: null, message: null }];
  const commands: any[] = [];
  const store = new WorkspaceController(client({ getWorkspace: async () => structuredClone(state), command: async (command: any) => { commands.push(command); return { commandId: command.commandId, projectId: project.id }; } }) as never);
  await store.openProject(project.id);
  store.markDirty(shot.id);
  assert.equal(store.selectShot('shot-b'), false);
  assert.equal(store.getSnapshot().activeShotId, shot.id);
  store.clearDirty(shot.id);
  assert.equal(store.selectShot('shot-b'), true);
  assert.equal(commands.length, 0);
  await store.resume('attempt-a');
  assert.equal(commands[0].type, 'attempt.resume');
});

test('concurrent status refreshes share a read and cannot replace a newer saved snapshot', async () => {
  let reads = 0; const pending = deferred<any>(); let saved = false;
  const store = new WorkspaceController(client({
    getWorkspace: async () => { reads++; if (reads === 2) return pending.promise; return { ...workspace(), shots: [{ ...shot, revision: saved ? 4 : 3 }] }; },
    command: async (command: any) => { saved = true; return { commandId: command.commandId, projectId: project.id, revision: 4 }; },
  }) as never);
  await store.openProject(project.id);
  const first = store.refresh(); const second = store.refresh();
  assert.equal(reads, 2);
  await store.saveShot(shot.id, 3, { prompt: 'New' });
  pending.resolve(workspace());
  await Promise.all([first, second]);
  assert.equal(store.getSnapshot().workspace?.shots[0].revision, 4);
});

test('a mismatched command receipt is held as ambiguous, not treated as saved', async () => {
  const store = new WorkspaceController(client({ command: async () => ({ commandId: 'unrelated', projectId: project.id }) }) as never);
  await store.openProject(project.id);
  await assert.rejects(store.saveShot(shot.id, 3, { prompt: 'A' }), /receipt/);
  assert.ok(store.getSnapshot().uncertainCommand);
});

test('a saved revision drops the cached inspection receipt instead of sending a stale selection', async () => {
  const state: any = workspace(); state.takes = [take]; const calls: any[] = [];
  const store = new WorkspaceController(client({
    getWorkspace: async () => structuredClone(state),
    command: async (command: any) => {
      calls.push(command);
      if (command.type === 'shot.update') state.shots[0] = { ...state.shots[0], revision: command.expectedRevision + 1 };
      return command.type === 'shot.update'
        ? { commandId: command.commandId, projectId: project.id, revision: state.shots[0].revision }
        : { commandId: command.commandId, projectId: project.id, resourceId: 'inspection-a' };
    },
  }) as never);
  await store.openProject(project.id);
  const inspection = await store.inspectTake('take-a');
  await store.saveShot(shot.id, 3, { prompt: 'Revised prompt' });
  assert.equal(store.getSnapshot().workspace?.shots[0].revision, 4);
  // The receipt was recorded against revision 3, so the client must refuse locally.
  await assert.rejects(store.selectTake(shot.id, 'take-a', 4, 0, inspection.inspectionId), /Inspect/);
  assert.deepEqual(calls.map(command => command.type), ['take.inspect', 'shot.update']);
});

test('a selection revision change invalidates a receipt bound to the previous selection', async () => {
  const state: any = workspace(); state.takes = [take]; const calls: any[] = [];
  const store = new WorkspaceController(client({
    getWorkspace: async () => structuredClone(state),
    command: async (command: any) => {
      calls.push(command);
      if (command.type === 'take.select') state.shots[0] = { ...state.shots[0], selectedTakeId: 'take-a', selectionRevision: state.shots[0].selectionRevision + 1 };
      return { commandId: command.commandId, projectId: project.id, resourceId: 'inspection-a' };
    },
  }) as never);
  await store.openProject(project.id);
  const inspection = await store.inspectTake('take-a');
  await store.selectTake(shot.id, 'take-a', 3, 0, inspection.inspectionId);
  assert.equal(store.getSnapshot().workspace?.shots[0].selectionRevision, 1);
  await assert.rejects(store.selectTake(shot.id, 'take-a', 3, 1, inspection.inspectionId), /Inspect/);
  assert.equal(calls.filter(command => command.type === 'take.select').length, 1);
});

test('a same-revision refresh retains a valid inspection but still requires the exact receipt identity', async () => {
  const state: any = workspace(); state.takes = [take]; const calls: any[] = [];
  const store = new WorkspaceController(client({
    getWorkspace: async () => structuredClone(state),
    command: async (command: any) => { calls.push(command); return { commandId: command.commandId, projectId: project.id, resourceId: 'inspection-a' }; },
  }) as never);
  await store.openProject(project.id);
  const inspection = await store.inspectTake('take-a');
  await store.refresh();
  await assert.rejects(store.selectTake(shot.id, 'take-a', 3, 0, 'inspection-from-another-scope'), /Inspect/);
  assert.deepEqual(calls.map(command => command.type), ['take.inspect']);
  await store.selectTake(shot.id, 'take-a', 3, 0, inspection.inspectionId);
  assert.equal(calls[1].type, 'take.select');
  assert.equal(calls[1].inspectionId, 'inspection-a');
  assert.equal(calls[1].expectedRevision, 3);
  assert.equal(calls[1].expectedSelectionRevision, 0);
});

test('an inspection result that arrives after the shot revision changed is rejected, not cached', async () => {
  const state: any = workspace(); state.takes = [take]; const calls: any[] = [];
  const store = new WorkspaceController(client({
    getWorkspace: async () => structuredClone(state),
    command: async (command: any) => {
      calls.push(command);
      // Another actor saved between the inspect POST and its readback.
      if (command.type === 'take.inspect') state.shots[0] = { ...state.shots[0], revision: 4 };
      return { commandId: command.commandId, projectId: project.id, resourceId: 'inspection-late' };
    },
  }) as never);
  await store.openProject(project.id);
  await assert.rejects(store.inspectTake('take-a'), /Inspect/);
  await assert.rejects(store.selectTake(shot.id, 'take-a', 4, 0, 'inspection-late'), /Inspect/);
  assert.equal(calls.filter(command => command.type === 'take.select').length, 0);
});

test('an inspection result that arrives after navigation cannot authorize a selection', async () => {
  const other = { ...project, id: 'project-b', name: 'Second project' };
  const stateA: any = workspace(); stateA.takes = [take];
  const stateB: any = { ...workspace(other), shots: [], takes: [] };
  const post = deferred<Receipt>(); const calls: any[] = [];
  const store = new WorkspaceController(client({
    listProjects: async () => [project, other],
    getWorkspace: async (id?: string) => structuredClone(id === other.id ? stateB : stateA),
    command: async (command: any) => { calls.push(command); return post.promise; },
  }) as never);
  await store.openProject(project.id);
  const inspecting = store.inspectTake('take-a');
  await store.openProject(other.id);
  post.resolve({ commandId: calls[0].commandId, projectId: project.id, resourceId: 'inspection-orphan' });
  await assert.rejects(inspecting, /Inspect/);
  await store.openProject(project.id);
  await assert.rejects(store.selectTake(shot.id, 'take-a', 3, 0, 'inspection-orphan'), /Inspect/);
  assert.equal(calls.filter(command => command.type === 'take.select').length, 0);
});
