import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { WorkspaceController } from './controller.ts';
import type { WorkspaceComponents } from './ports.ts';
import type { Asset, Shot, Workspace, WorkspaceState } from './types.ts';
import { ProjectRail } from './ProjectRail.tsx';

export interface FlumeAppProps { controller: WorkspaceController; components: WorkspaceComponents; autoStart?: boolean; initialProjectId?: string; previewLabel?: string }

export function FlumeApp({ controller, components, autoStart = true, initialProjectId, previewLabel }: FlumeAppProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const { Brand, TakeReview, ActivityPanel, GenerationReview } = components;
  const [creating, setCreating] = useState<'project' | 'shot' | null>(null);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [discardEpoch,setDiscardEpoch] = useState(0);
  const uploadRef = useRef<HTMLInputElement>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const reviewOpener = useRef<HTMLElement | null>(null);
  const restoreReviewFocus = useRef(false);
  const workspace = state.workspace;
  const project = workspace?.project;
  const shot = workspace?.shots.find(item => item.id === state.activeShotId);
  const review = workspace?.reviews.find(item => item.id === state.reviewId);
  const busy = !!state.busy;
  const held = busy || !!state.uncertainCommand;
  const activeWork = workspace?.attempts.some(item => ['queued', 'running', 'retrieving'].includes(item.status)) || workspace?.exports.some(item => ['queued', 'running'].includes(item.status));

  useEffect(() => { if (autoStart) void controller.start(initialProjectId); }, [autoStart, controller, initialProjectId]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') void controller.refresh(); };
    const timer = activeWork ? window.setInterval(refresh, 4000) : undefined;
    window.addEventListener('focus', refresh);
    return () => { if (timer !== undefined) window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [controller, activeWork]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (state.dirtyShotIds.size || busy || state.uncertainCommand) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [state.dirtyShotIds, busy, state.uncertainCommand]);

  useEffect(() => {
    const panel = reviewRef.current;
    if (!panel || !review) return;
    const previous = reviewOpener.current;
    panel.focus({ preventScroll: true });
    panel.scrollIntoView({ block: 'nearest' });
    return () => {
      if (restoreReviewFocus.current) restoreOpener(previous, panel);
      reviewOpener.current = null;
      restoreReviewFocus.current = false;
    };
  }, [review?.id]);

  async function notify<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) { if (!controller.getSnapshot().error) controller.reportError(error); throw error; }
  }
  function run(action: () => Promise<unknown>) { void notify(action).catch(() => {}); }
  function navigate(action: () => void) {
    if (held) return;
    if (shot && state.dirtyShotIds.has(shot.id)) setLeaving(() => action);
    else action();
  }
  function finishNavigation() {
    setDiscardEpoch(epoch=>epoch+1); // Explicit discard resets the actual buffer, even if navigation is a no-op/canceled.
    if (shot) controller.clearDirty(shot.id);
    leaving?.(); setLeaving(null);
  }
  const capability = workspace?.capabilities.find(item => item.modelId === shot?.controls.modelId);
  const blocker = capability?.availability === 'blocked' ? capability.blocker ?? 'This model is not available through the configured provider.' : null;

  return <div className="fl-theme fl-workspace">
    <a className="fl-workspace__skip" href="#fl-canvas">Skip to workspace</a>
    {previewLabel && <div className="fl-workspace__preview-label" role="note">{previewLabel}</div>}
    <header className="fl-workspace__topbar">
      <div className="fl-workspace__brand"><Brand /></div>
      <div className="fl-workspace__project-switch">
        <label htmlFor="fl-project">Project</label>
        <select id="fl-project" value={project?.id ?? ''} disabled={held || state.phase === 'loading'} onChange={event => { const id = event.target.value; navigate(() => { setLibraryOpen(false); run(() => controller.openProject(id)); }); }}>
          {!project && <option value="">Choose a project</option>}
          {state.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          {project && !state.projects.some(item => item.id === project.id) && <option value={project.id}>{project.name}</option>}
        </select>
      </div>
      <button className="fl-workspace__quiet" disabled={held} onClick={() => navigate(() => setCreating('project'))}>New project</button>
      <div className="fl-workspace__save-state" aria-live="polite">{busy ? 'Saving / checking…' : state.uncertainCommand ? 'Request needs checking' : state.dirtyShotIds.size ? 'Unsaved changes' : state.error ? 'Check saved state' : project ? 'Saved workspace' : 'Local workspace'}</div>
      <button className="fl-workspace__quiet" disabled={busy || state.phase === 'loading'} onClick={() => run(() => state.phase === 'error' ? controller.start(initialProjectId) : controller.refresh())}>Refresh</button>
    </header>

    {state.error && <div className="fl-workspace__issue" role="alert">
      <div><strong>{state.error.currentRevision !== undefined ? 'This shot changed elsewhere.' : state.uncertainCommand ? 'The request may have been accepted.' : 'Action needs attention.'}</strong>
        <p>{state.error.message}</p>
        {state.error.currentRevision !== undefined && <p>Your draft is still here. Saved revision is {state.error.currentRevision}. Refresh, then compare or discard the draft in the editor; nothing is overwritten automatically.</p>}
        {state.uncertainCommand && <p>New actions are on hold. Check the saved state, or retry the original request with the same identity. Do not start another generation.</p>}
      </div>
      <button className="fl-workspace__button" disabled={busy} onClick={() => run(() => state.phase === 'error' ? controller.start(initialProjectId) : controller.refresh())}>Check saved state</button>
      {state.uncertainCommand && <button className="fl-workspace__button" disabled={busy} onClick={() => run(() => controller.retryUncertain())}>Retry original request</button>}
    </div>}

    <div className="fl-workspace__body" data-rail-collapsed={railCollapsed}>
      <div className="fl-workspace__rail">
        <ProjectRail projects={project && !state.projects.some(item => item.id === project.id) ? [...state.projects, project] : state.projects}
          shots={workspace?.shots ?? []} takes={workspace?.takes ?? []} activeProjectId={project?.id ?? null} activeShotId={state.activeShotId}
          dataState={state.phase === 'idle' ? 'loading' : state.phase}
          collapsed={railCollapsed} disabled={held || state.phase === 'loading'} onCollapsedChange={setRailCollapsed}
          onProjectActivate={id => navigate(() => { setLibraryOpen(false); run(() => controller.openProject(id)); })}
          onShotActivate={id => navigate(() => { setLibraryOpen(false); controller.selectShot(id); })}
          onCreateProject={() => navigate(() => setCreating('project'))}
          onCreateShot={() => navigate(() => setCreating('shot'))} />
        <div className="fl-workspace__sidebar-bottom">
          <button className="fl-workspace__library-button" aria-pressed={libraryOpen} disabled={!project || held} onClick={() => navigate(() => setLibraryOpen(!libraryOpen))}><span>Project media</span><span aria-label={!workspace ? 'Media count unavailable' : undefined}>{workspace?.assets.length ?? '—'}</span></button>
          <p>Imports stay in this project.<br />A take is selected only by you.</p>
        </div>
      </div>

      <main id="fl-canvas" className="fl-workspace__main" tabIndex={-1}>
        {(state.phase === 'loading' || state.phase === 'idle') ? <div className="fl-workspace__loading" role="status"><div className="fl-workspace__loading-frame" /><h1>Opening your workspace…</h1><p>Loading saved projects, shots and media.</p></div>
          : !project ? <div className="fl-workspace__welcome"><div className="fl-workspace__blank-film" aria-hidden="true"><span /><span /><span /></div><h1>A place for your next film.</h1><p>Create a project, shape a shot, and give its first and last moments their own frames.</p><button className="fl-workspace__button fl-workspace__button--primary" disabled={held || state.phase === 'error'} onClick={() => setCreating('project')}>Create a project</button><p className="fl-workspace__fine">Your work saves locally. Generation is reviewed before it is sent.</p></div>
          : <>
            <div className="fl-workspace__shot-header"><div><p>{libraryOpen ? 'Project media' : project.name}</p><h1>{libraryOpen ? 'Your source material' : shot?.title ?? 'Make your first shot.'}</h1></div>{libraryOpen ? <button className="fl-workspace__button" onClick={() => setLibraryOpen(false)}>Back to shot</button> : <button className="fl-workspace__quiet" disabled={held} onClick={() => navigate(() => setCreating('shot'))}>Add shot</button>}</div>
            {libraryOpen ? <section className="fl-workspace__library" aria-label="Project media library">
              <div className="fl-workspace__library-intro"><p>Import an image, then explicitly choose it as a start or end frame in the shot editor. Importing never changes a shot.</p><button className="fl-workspace__button" disabled={held} onClick={() => uploadRef.current?.click()}>Import image</button><input ref={uploadRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => { const file = event.target.files?.[0]; if (file) run(() => controller.uploadAsset(file)); event.currentTarget.value = ''; }} /></div>
              {workspace.assets.length ? <ul className="fl-workspace__asset-grid">{workspace.assets.map(asset => <li key={asset.id}><figure><div>{asset.kind === 'image' ? <img src={ownedMediaUrl(asset)} alt={asset.filename} /> : <video src={ownedMediaUrl(asset)} controls preload="metadata" playsInline />}</div><figcaption><strong>{asset.filename}</strong><span>{originLabel(asset)} · {asset.width} × {asset.height}</span></figcaption></figure></li>)}</ul> : <p className="fl-workspace__empty-note">No media yet. Import your first image to begin.</p>}
            </section> : shot ? <>
              {blocker && <div className="fl-workspace__provider-blocker"><span className="fl-workspace__status-dot" aria-hidden="true" /><p><strong>Generation unavailable.</strong> {blocker} <span>Editing is still available.</span></p></div>}
              <div className="fl-workspace__editing-layout">
                <MediaStage key={shot.id} shot={shot} workspace={workspace} />
                <section className="fl-workspace__composer" aria-label="Shot composer"><EditorBoundary key={`${shot.id}:${discardEpoch}`} shot={shot} workspace={workspace} state={state} controller={controller} components={components} onPrepare={(revision, opener) => { reviewOpener.current = opener; return controller.prepare(shot.id, revision); }} /></section>
              </div>
              {review && <div ref={reviewRef} tabIndex={-1} className="fl-workspace__review" aria-label="Generation review"><GenerationReview review={review} assets={workspace.assets} busy={held || state.dirtyShotIds.has(shot.id) || review.shotRevision !== shot.revision} onApprove={limits => notify(() => controller.approve(review.id, limits))} onSubmit={() => notify(() => controller.submit(review.id))} onDismiss={() => { restoreReviewFocus.current = true; controller.dismissReview(); }} /></div>}
              <section className="fl-workspace__takes" aria-label="Takes"><TakeReview shot={shot} takes={workspace.takes.filter(take => take.shotId === shot.id)} assets={workspace.assets} exports={workspace.exports.filter(item => item.shotId === shot.id)} busy={held || state.dirtyShotIds.has(shot.id)} onInspect={id => notify(() => controller.inspectTake(id))} onSelect={(id, inspectionId) => notify(() => controller.selectTake(shot.id, id, shot.revision, shot.selectionRevision, inspectionId))} onExport={() => notify(() => controller.exportShot(shot.id, shot.revision, shot.selectionRevision))} /></section>
              <section className="fl-workspace__activity" aria-label="Generation activity"><ActivityPanel attempts={workspace.attempts.filter(item => item.shotId === shot.id)} busy={held} onResume={id => notify(() => controller.resume(id))} /></section>
            </> : <div className="fl-workspace__first-shot"><div className="fl-workspace__empty-aperture" aria-hidden="true" /><p>A shot holds your direction, frame references and every take.</p><button className="fl-workspace__button fl-workspace__button--primary" disabled={held} onClick={() => setCreating('shot')}>Create a shot</button></div>}
          </>}
      </main>
    </div>
    <footer className="fl-workspace__footer"><span role="status">{state.notice ?? (project ? 'Original media stays in your project. No generation starts automatically.' : 'Create something worth keeping.')}</span><span>Flume / Creative workspace</span></footer>
    {creating && <CreateDialog kind={creating} busy={held} onDismiss={() => setCreating(null)} onCreate={async (name, detail) => { await notify(() => creating === 'project' ? controller.createProject(name, detail) : controller.createShot(name, detail)); setCreating(null); }} />}
    {leaving && <Modal label="Leave this shot?" onDismiss={() => setLeaving(null)}><h2>Keep your changes?</h2><p>This shot has unsaved edits. Stay to save them, or discard the draft before leaving. Saved media is not removed.</p><div className="fl-workspace__dialog-actions"><button className="fl-workspace__button" onClick={() => setLeaving(null)}>Stay here</button><button className="fl-workspace__button" onClick={finishNavigation}>Discard and continue</button></div></Modal>}
  </div>;
}

function EditorBoundary({ shot, workspace, state, controller, components, onPrepare }: { shot: Shot; workspace: Workspace; state: WorkspaceState; controller: WorkspaceController; components: WorkspaceComponents; onPrepare(revision: number, opener: HTMLElement | null): Promise<void> }) {
  const { ShotEditor } = components;
  const ref = useRef<HTMLDivElement>(null);
  const baseRevision = useRef(shot.revision);
  const onDirtyChange = useCallback((value:boolean) => value ? controller.markDirty(shot.id) : controller.clearDirty(shot.id), [controller,shot.id]);
  const dirty = state.dirtyShotIds.has(shot.id);
  useEffect(() => { if (!dirty) baseRevision.current = shot.revision; }, [shot.revision, dirty]);
  // Dirty authority comes from the canonical editor update, not DOM input:
  // capture-time store emissions can restore controlled text before onChange.
  return <div ref={ref}>
    <ShotEditor shot={shot} assets={workspace.assets} capabilities={workspace.capabilities} busy={!!state.busy || !!state.uncertainCommand} error={state.error} onDirtyChange={onDirtyChange} onSave={async (patch, revision = baseRevision.current) => { const saved = await controller.saveShot(shot.id, revision, patch); baseRevision.current = saved.revision; return saved; }} onUpload={file => controller.uploadAsset(file)} onPrepare={(revision = baseRevision.current) => {
      // Capture before the controller's busy update disables and blurs the trigger.
      const active = document.activeElement;
      return onPrepare(revision, active instanceof HTMLElement && ref.current?.contains(active) ? active : null);
    }} />
  </div>;
}

export function ownedMediaUrl(asset: Asset, origin = typeof window === 'undefined' ? 'http://flume.local' : window.location.origin): string | undefined {
  // Media comes from the owned API, never directly from a provider or arbitrary URL.
  try { const url = new URL(asset.mediaUrl, origin); return url.origin === origin && !url.username && !url.password && url.pathname.startsWith('/api/media/') ? `${url.pathname}${url.search}` : undefined; }
  catch { return undefined; }
}
function originLabel(asset: Asset) { return asset.origin === 'sample' ? 'Sample media' : asset.origin === 'imported' ? 'Imported media' : 'Generated media'; }

function MediaStage({ shot, workspace }: { shot: Shot; workspace: Workspace }) {
  const [view, setView] = useState<'first' | 'last' | 'selected'>(shot.selectedTakeId ? 'selected' : 'first');
  const [failedId, setFailedId] = useState<string | null>(null);
  const take = workspace.takes.find(item => item.id === shot.selectedTakeId);
  const assetId = view === 'first' ? shot.bindings.firstFrameAssetId : view === 'last' ? shot.bindings.lastFrameAssetId : take?.assetId;
  const asset = workspace.assets.find(item => item.id === assetId);
  const labels = { first: 'Start frame', last: 'End frame', selected: 'Selected take' };
  const url = asset && ownedMediaUrl(asset);
  return <section className="fl-workspace__stage" aria-label="Shot preview">
    <div className="fl-workspace__stage-toolbar"><div className="fl-workspace__view-switch" role="group" aria-label="Preview source">{(['first', 'last', 'selected'] as const).map(item => <button key={item} aria-pressed={view === item} onClick={() => setView(item)}>{labels[item]}</button>)}</div><span>{shot.controls.aspectRatio}</span></div>
    <div className={`fl-workspace__screen${asset ? ' fl-workspace__screen--media' : ''}`}>
      {asset && url && failedId !== asset.id ? asset.kind === 'video' ? <video key={asset.id} src={url} controls playsInline preload="metadata" onError={() => setFailedId(asset.id)} aria-label={`${labels[view]}: ${asset.filename}`} /> : <img key={asset.id} src={url} alt={`${labels[view]}: ${asset.filename}`} onError={() => setFailedId(asset.id)} />
        : <div className="fl-workspace__stage-empty"><div className="fl-workspace__empty-aperture" aria-hidden="true" /><h2>{asset ? 'This preview could not load.' : view === 'selected' ? 'The choice is yours.' : view === 'first' ? 'Your shot starts here.' : 'Give the shot an ending.'}</h2><p>{asset ? 'Refresh the project to check the owned media. Your shot settings are unchanged.' : view === 'selected' ? 'Inspect a take, then select it. Completed generations are never selected automatically.' : `Import an image and choose it as the ${view === 'first' ? 'start' : 'end'} frame in the editor.`}</p></div>}
    </div>
    <div className="fl-workspace__stage-caption"><span>{asset ? originLabel(asset) : 'No frame bound'}{asset && <span> / {asset.filename}</span>}</span><span>{asset ? `${asset.width} × ${asset.height}` : 'Saved shot preview'}</span></div>
  </section>;
}

function restoreOpener(opener: Element | null, surface: HTMLElement) {
  const active = document.activeElement;
  if (opener instanceof HTMLElement && opener.isConnected && !opener.matches(':disabled, [aria-disabled="true"]') && !opener.closest('[inert], [hidden]') && opener.getClientRects().length && getComputedStyle(opener).visibility === 'visible' && !document.querySelector('dialog[open]') && (active === document.body || surface.contains(active))) opener.focus();
}

function Modal({ label, onDismiss, children, busy = false }: { label: string; onDismiss(): void; children: ReactNode; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    dialog?.showModal();
    return () => { dialog?.close(); if (dialog) restoreOpener(opener, dialog); };
  }, []);
  return <dialog className="fl-workspace__dialog" aria-label={label} ref={ref} onCancel={event => { event.preventDefault(); if (!busy) onDismiss(); }}>{children}</dialog>;
}
function CreateDialog({ kind, busy, onCreate, onDismiss }: { kind: 'project' | 'shot'; busy: boolean; onCreate(name: string, detail: string): Promise<void>; onDismiss(): void }) {
  const [name, setName] = useState(''); const [detail, setDetail] = useState(''); const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) { event.preventDefault(); try { await onCreate(name, detail); } catch (error) { setError(error instanceof Error ? error.message : 'Could not create this item.'); } }
  return <Modal label={`Create a ${kind}`} onDismiss={onDismiss} busy={busy}><form onSubmit={submit}><h2>Create a {kind}</h2><p>{kind === 'project' ? 'Give your film a home. You can start with a single shot.' : 'Name the moment. Its direction and frame references come next.'}</p><label htmlFor="fl-create-name">{kind === 'project' ? 'Project name' : 'Shot title'}</label><input autoFocus id="fl-create-name" value={name} onChange={event => setName(event.target.value)} required maxLength={240} disabled={busy} /><label htmlFor="fl-create-detail">{kind === 'project' ? 'Brief' : 'Shot direction'} <span>(optional)</span></label><textarea id="fl-create-detail" rows={4} value={detail} onChange={event => setDetail(event.target.value)} disabled={busy} />{error && <p role="alert">{error}</p>}<div className="fl-workspace__dialog-actions"><button type="button" className="fl-workspace__button" disabled={busy} onClick={onDismiss}>Cancel</button><button className="fl-workspace__button fl-workspace__button--primary" disabled={busy || !name.trim()}>{busy ? 'Creating…' : `Create ${kind}`}</button></div></form></Modal>;
}
