import type { FrameBindings, SaveShotInput, SaveShotResult, ShotView } from './types.ts';

export interface Draft {
  title: string;
  prompt: string;
  controls: {
    modelId: string;
    durationSeconds: string;
    resolution: string;
    aspectRatio: string;
    generateAudio: boolean;
    seed: string;
  };
  bindings: FrameBindings;
}
export interface EditorState {
  base: ShotView;
  latest: ShotView;
  draft: Draft;
  /** Literal spelling acknowledged by this base, separate from numeric API values. */
  baseDraft: Draft;
  saving: { token: number; submitted: SaveShotInput; submittedDraft: Draft } | null;
  conflictRevision: number | null;
}
export function draftFromShot(shot: ShotView): Draft {
  return {
    title: shot.title,
    prompt: shot.prompt,
    controls: {
      modelId: shot.controls.modelId,
      durationSeconds: String(shot.controls.durationSeconds),
      resolution: shot.controls.resolution,
      aspectRatio: shot.controls.aspectRatio,
      generateAudio: shot.controls.generateAudio,
      seed: shot.controls.seed === undefined ? '' : String(shot.controls.seed),
    },
    bindings: {
      firstFrameAssetId: shot.bindings.firstFrameAssetId,
      lastFrameAssetId: shot.bindings.lastFrameAssetId,
    },
  };
}
export function createEditorState(shot: ShotView): EditorState {
  return {
    base: shot,
    latest: shot,
    draft: draftFromShot(shot),
    baseDraft: draftFromShot(shot),
    saving: null,
    conflictRevision: null,
  };
}
export function isDirty(state: EditorState): boolean {
  return JSON.stringify(state.draft) !== JSON.stringify(state.baseDraft);
}
export function hasConflict(state: EditorState): boolean {
  return (
    state.latest.revision > state.base.revision ||
    (state.conflictRevision !== null && state.conflictRevision > state.base.revision)
  );
}
/** Passive refreshes may advance a clean buffer, never a dirty write's base. */
export function receiveShot(state: EditorState, shot: ShotView): EditorState {
  if (
    shot.id !== state.base.id ||
    shot.projectId !== state.base.projectId ||
    shot.revision < state.base.revision ||
    shot.revision < state.latest.revision
  )
    return state;
  if (state.saving || isDirty(state) || hasConflict(state)) return { ...state, latest: shot };
  if (shot.revision === state.base.revision) return { ...state, base: shot, latest: shot };
  return { ...state, base: shot, latest: shot, draft: draftFromShot(shot), baseDraft: draftFromShot(shot) };
}
export function reconcile(state: EditorState, keepDraft: boolean): EditorState {
  if (state.latest.revision < (state.conflictRevision ?? 0) || state.saving) return state;
  return {
    ...state,
    base: state.latest,
    baseDraft: draftFromShot(state.latest),
    draft: keepDraft ? state.draft : draftFromShot(state.latest),
    conflictRevision: null,
  };
}
export function editDraft(state: EditorState, draft: Draft): EditorState {
  return { ...state, draft };
}
export function fieldErrors(draft: Draft): { duration?: string; seed?: string } {
  const errors: { duration?: string; seed?: string } = {};
  if (
    !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(draft.controls.durationSeconds) ||
    !Number.isFinite(Number(draft.controls.durationSeconds))
  )
    errors.duration = 'Enter a finite duration in seconds. Blank is not zero.';
  if (
    draft.controls.seed !== '' &&
    (!/^\d+$/.test(draft.controls.seed) || !Number.isSafeInteger(Number(draft.controls.seed)))
  )
    errors.seed = 'Use a non-negative whole-number seed, or leave it blank for random.';
  return errors;
}
export function saveDraft(state: EditorState): SaveShotInput {
  const { draft, base } = state;
  const errors = Object.values(fieldErrors(draft));
  if (errors.length) throw new Error(errors.join(' '));
  return {
    projectId: base.projectId,
    shotId: base.id,
    expectedRevision: base.revision,
    patch: {
      title: draft.title,
      prompt: draft.prompt,
      controls: {
        modelId: draft.controls.modelId,
        durationSeconds: Number(draft.controls.durationSeconds),
        resolution: draft.controls.resolution,
        aspectRatio: draft.controls.aspectRatio,
        generateAudio: draft.controls.generateAudio,
        ...(draft.controls.seed === '' ? {} : { seed: Number(draft.controls.seed) }),
      },
      bindings: { ...draft.bindings },
    },
  };
}
export function startSave(state: EditorState, token: number): EditorState {
  return { ...state, saving: { token, submitted: saveDraft(state), submittedDraft: structuredClone(state.draft) } };
}
export function finishSave(state: EditorState, token: number, result: SaveShotResult): EditorState {
  if (state.saving?.token !== token) return state;
  if (
    !result ||
    !Number.isSafeInteger(result.revision) ||
    result.revision <= state.saving.submitted.expectedRevision
  )
    throw new Error(
      'The save response has no valid accepted revision. Refresh the workspace before retrying.',
    );
  const base={...state.base,...state.saving.submitted.patch,revision:result.revision};
  return {
    ...state, base,
    // Acknowledge only submitted text; newer edits stay dirty against this snapshot.
    baseDraft: state.saving.submittedDraft,
    saving: null,
  };
}
