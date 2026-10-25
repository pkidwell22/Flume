/**
 * Authoring surfaces mounted inside the real workspace.
 *
 * The tabs and drawer here are the product entry points: they call the workspace
 * controller, which talks only to the fixed Wave 2 routes. Nothing generates,
 * spends, binds or writes on mount; every write is one explicit operator action.
 */
import { useState } from 'react';
import { FrameAuthoring } from './FrameAuthoring.tsx';
import { StoryboardComposer } from './StoryboardComposer.tsx';
import { ContinueShot } from './ContinueShot.tsx';
import type { FrameModel, FrameRole, FrameSourceAsset } from './frame-authoring-types.ts';
import type { WorkspaceController } from './controller.ts';
import type { Shot, Workspace, WorkspaceState } from './types.ts';

function capabilitiesNote(state: WorkspaceState, models: FrameModel[]): string | null {
  const authoring = state.authoring;
  if (authoring.phase === 'loading') return 'Reading the image models configured on this server…';
  if (authoring.phase === 'error') {
    return `Image authoring is unavailable: ${authoring.error?.message ?? 'the server did not report its configured models.'} Availability is unknown, so nothing can be sent.`;
  }
  if (!authoring.capabilities) return 'The server has not reported any image authoring capabilities. Availability is unknown, so nothing can be sent.';
  if (models.length === 0) return 'No image model is configured on this server. Availability is unknown, so nothing can be sent.';
  if (models.every(model => model.availability !== 'available')) return 'No configured image model is available right now. Drafting stays free; nothing can be sent.';
  return null;
}

/** Frame authoring for the open shot. Rendered by the stage's Author tab. */
export function FrameAuthoringSurface({ controller, state, shot, workspace }: {
  controller: WorkspaceController;
  state: WorkspaceState;
  shot: Shot;
  workspace: Workspace;
}) {
  const models = state.authoring.capabilities?.imageModels ?? [];
  const note = capabilitiesNote(state, models);
  const sourceAssets: FrameSourceAsset[] = workspace.assets
    .filter(asset => asset.projectId === shot.projectId && asset.kind === 'image')
    .map(asset => ({ assetId: asset.id, filename: asset.filename, width: asset.width, height: asset.height, mediaUrl: asset.mediaUrl, sha256: asset.sha256 }));
  // Prefer the empty frame role, so binding never offers to overwrite the other side.
  const initialRole: FrameRole = !shot.bindings.firstFrameAssetId && shot.bindings.lastFrameAssetId ? 'first_frame'
    : shot.bindings.firstFrameAssetId && !shot.bindings.lastFrameAssetId ? 'last_frame' : 'first_frame';
  const busy = !!state.busy || !!state.uncertainCommand;
  return <section className="fl-author" aria-label="Frame authoring" data-authoring-phase={state.authoring.phase}>
    {note && <p className="fl-author__note" role="status">{note}</p>}
    <FrameAuthoring
      projectId={shot.projectId}
      shotId={shot.id}
      expectedRevision={shot.revision}
      bindings={shot.bindings}
      models={models}
      sourceAssets={sourceAssets}
      initialRole={initialRole}
      busy={busy}
      onPrepareReview={draft => controller.prepareFrameReview(draft)}
      onApproveAndGenerate={(review, limits) => controller.approveAndGenerate(review, limits)}
      // The stored review id is the status handle; there is no video attempt to resume.
      onCheckSubmission={reviewId => controller.checkFrameSubmission(reviewId)}
      // Inspect is the explicit import step; it reads/owns bytes and spends nothing.
      onInspectResult={assetId => controller.importFrameResult(assetId)}
      onBindFrame={input => controller.bindFrame(input)}
      // No cancellation route exists for an image review, so no cancel control is offered.
    />
  </section>;
}

/** Storyboard proposing plus continue-from-take. Rendered by the Storyboard drawer. */
export function AuthoringStoryboard({ controller, state, workspace }: {
  controller: WorkspaceController;
  state: WorkspaceState;
  workspace: Workspace;
}) {
  const project = workspace.project;
  const [reopenId, setReopenId] = useState('');
  const [reopenError, setReopenError] = useState<string | null>(null);
  const [reopening, setReopening] = useState(false);
  if (!project) return null;
  const storyboard = state.authoring.capabilities?.storyboard ?? null;
  // The actual configured blocker, not a generic "unavailable".
  const plannerBlocker = storyboard && !storyboard.available ? storyboard.blocker ?? 'No storyboard planner is configured.' : null;
  const busy = !!state.busy || !!state.uncertainCommand;
  const shotsById = new Map(workspace.shots.filter(shot => shot.projectId === project.id).map(shot => [shot.id, shot]));
  const takes = workspace.takes
    .filter(take => take.projectId === project.id)
    .map(take => ({
      id: take.id,
      shotId: take.shotId,
      label: `${shotsById.get(take.shotId)?.title ?? 'Untitled shot'} · ${workspace.assets.find(asset => asset.id === take.assetId)?.filename ?? take.assetId}`,
    }));
  const activeShot = workspace.shots.find(shot => shot.projectId === project.id) ?? null;
  async function reopen() {
    const id = reopenId.trim();
    if (!id || reopening) return;
    setReopening(true); setReopenError(null);
    try { await controller.openProposal(id); setReopenId(''); }
    catch (error) { setReopenError(error instanceof Error && error.message ? error.message : 'That proposal could not be opened.'); }
    finally { setReopening(false); }
  }
  return <div className="fl-story">
    {state.authoring.recovery && <section aria-label="Storyboard recovery">
      <p className="fl-author__note" role={state.authoring.recovery.phase === 'error' ? 'alert' : 'status'}>{state.authoring.recovery.message}</p>
      <p className="fl-hint">Saved proposal: {state.authoring.recovery.proposalId}</p>
      {state.authoring.recovery.phase === 'error' && <button type="button" className="fl-btn fl-btn--ghost fl-btn--sm" disabled={busy}
        onClick={() => void controller.restoreStoryboard()}>Check saved storyboard</button>}
    </section>}
    <StoryboardComposer
      projectId={project.id}
      proposal={state.authoring.proposal}
      busy={busy || (!state.authoring.proposal && plannerBlocker !== null)}
      error={!state.authoring.proposal && plannerBlocker ? `Storyboard planning is not configured: ${plannerBlocker}` : null}
      onPropose={brief => controller.proposeStoryboard(brief)}
      onRevise={(items, expectedRevision) => controller.reviseProposal(items, expectedRevision)}
      onAccept={expectedRevision => controller.acceptProposal(expectedRevision)}
      onCancel={() => controller.cancelProposal()}
      onResume={retryFailed => controller.resumeProposal(retryFailed)}
    />
    {/* An interrupted application is resumed by reopening the stored proposal, never by re-proposing. */}
    <section className="fl-story__reopen" aria-label="Reopen a stored proposal">
      <label htmlFor="fl-story-reopen">Reopen a stored proposal</label>
      <div className="fl-story__reopen-row">
        <input id="fl-story-reopen" value={reopenId} disabled={busy || reopening} placeholder="Proposal ID" onChange={event => setReopenId(event.target.value)} />
        <button type="button" className="fl-btn fl-btn--ghost fl-btn--sm" disabled={busy || reopening || reopenId.trim() === ''} onClick={() => void reopen()}>
          {reopening ? 'Opening…' : 'Open proposal'}
        </button>
      </div>
      <p className="fl-hint">Reopening reads the stored proposal and its real per-cut state. It creates nothing and spends nothing.</p>
      {reopenError && <p className="fl-author__note" role="alert">{reopenError}</p>}
    </section>
    <ContinueShot
      port={{ continueShot: input => controller.continueFromTake(input) }}
      projectId={project.id}
      takes={takes}
      sourceShot={activeShot ? { id: activeShot.id, title: activeShot.title, prompt: activeShot.prompt } : undefined}
      disabled={busy}
      blockedReason={busy ? 'The workspace is busy. Finish the current action first.' : null}
      // Saved continuation identity comes from storage; every shown value comes from the server read.
      recovery={state.authoring.continuation ?? null}
      onRetryRecovery={() => controller.restoreContinuation()}
      onResumeOperation={operationId => controller.resumeContinuation(operationId)}
    />
  </div>;
}
