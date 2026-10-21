// Display-only derivations from the saved workspace. Nothing here grants an
// action: commands still go through the controller's revision and review fences.
import type { Asset, Attempt, Review, Shot, Take, Workspace } from './types.ts';

export type FrameKey = 'firstFrameAssetId' | 'lastFrameAssetId';
export interface FrameState { kind: 'empty' | 'missing' | 'unknown' | 'unsupported' | 'supported'; label: string; asset?: Asset }

const ACTIVE: ReadonlySet<Attempt['status']> = new Set(['queued', 'running', 'retrieving']);
export const isActive = (attempt: Attempt) => ACTIVE.has(attempt.status);
export const isUnknown = (attempt: Attempt) => attempt.status === 'acceptance_unknown';
/** Attempts a person may need to watch or check: running work and unconfirmed acceptance. */
export const needsWatching = (attempt: Attempt) => isActive(attempt) || isUnknown(attempt);

export function shotNumber(index: number) { return String(index + 1).padStart(2, '0'); }

/** Saved binding against the saved model's reported roles. Unreported is unknown, never assumed. */
export function frameState(shot: Shot, key: FrameKey, workspace: Pick<Workspace, 'assets' | 'capabilities'>): FrameState {
  const assetId = shot.bindings[key];
  if (assetId === null) return { kind: 'empty', label: 'Empty' };
  const asset = workspace.assets.find(item => item.id === assetId && item.projectId === shot.projectId && item.kind === 'image');
  if (!asset) return { kind: 'missing', label: 'Missing' };
  const model = workspace.capabilities.find(item => item.modelId === shot.controls.modelId);
  if (!model) return { kind: 'unknown', label: 'Model unknown', asset };
  const role = key === 'firstFrameAssetId' ? 'first' : 'last';
  // An unsupported binding stays on the shot and blocks review; it is never dropped from the request.
  if (!model.frameRoles.some(item => item === role || item === `${role}_frame`)) return { kind: 'unsupported', label: 'Kept · not supported', asset };
  return { kind: 'supported', label: 'Supported', asset };
}

export interface Phase { key: 'draft' | 'dirty' | 'review' | 'approved' | 'running' | 'unknown' | 'takes' | 'chosen'; label: string }
export function shotPhase(shot: Shot, workspace: Pick<Workspace, 'attempts' | 'takes'>, options: { dirty?: boolean; review?: Review | null } = {}): Phase {
  const { dirty = false, review = null } = options;
  if (dirty) return { key: 'dirty', label: 'Unsaved edits' };
  if (review && review.shotId === shot.id && review.shotRevision === shot.revision) return review.approved ? { key: 'approved', label: 'Approved · not sent' } : { key: 'review', label: 'In review' };
  const attempts = workspace.attempts.filter(item => item.shotId === shot.id && item.projectId === shot.projectId);
  if (attempts.some(isUnknown)) return { key: 'unknown', label: 'State unknown' };
  if (attempts.some(isActive)) return { key: 'running', label: 'Generating' };
  if (shot.selectedTakeId) return { key: 'chosen', label: 'Take selected' };
  if (shotTakes(shot, workspace.takes).length) return { key: 'takes', label: 'Takes to review' };
  return { key: 'draft', label: 'Draft' };
}

export function shotTakes(shot: Shot, takes: readonly Take[]) { return takes.filter(take => take.shotId === shot.id && take.projectId === shot.projectId); }

/** The reel's one-line status. Missing media outranks routine states; uncertain work outranks both. */
export function reelStatus(shot: Shot, workspace: Pick<Workspace, 'assets' | 'capabilities' | 'attempts' | 'takes'>): { tone: 'ok' | 'warn' | 'err' | 'run' | 'dim'; text: string } {
  const phase = shotPhase(shot, workspace);
  if (phase.key === 'unknown') return { tone: 'warn', text: 'State unknown' };
  if ((['firstFrameAssetId', 'lastFrameAssetId'] as const).some(key => frameState(shot, key, workspace).kind === 'missing')) return { tone: 'err', text: 'Missing frame' };
  if (phase.key === 'running') return { tone: 'run', text: 'Generating' };
  if (phase.key === 'chosen') return { tone: 'ok', text: 'Take selected' };
  if (phase.key === 'takes') return { tone: 'dim', text: 'Takes to review' };
  return { tone: 'dim', text: 'No take selected' };
}

export function timecode(totalSeconds: number) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
