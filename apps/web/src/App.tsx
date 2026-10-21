import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { WorkspaceController } from './controller.ts';
import type { WorkspaceComponents } from './ports.ts';
import type { Shot, Workspace, WorkspaceState } from './types.ts';
import { Reel } from './Reel.tsx';
import { ActivityDrawer, Drawer, ExportDrawer, LibraryDrawer, ProjectsDrawer } from './Drawers.tsx';
import type { DrawerKind } from './Drawers.tsx';
import { ownedMediaUrl, restoreOpener } from './shell.ts';
import { frameState, isUnknown, needsWatching, shotNumber, shotPhase, shotTakes } from './shot-status.ts';
import type { FrameKey } from './shot-status.ts';

export { ownedMediaUrl } from './shell.ts';

export interface FlumeAppProps { controller: WorkspaceController; components: WorkspaceComponents; autoStart?: boolean; initialProjectId?: string; previewLabel?: string }

const drawerTitles: Record<DrawerKind, string> = { projects: 'Projects', library: 'Library', activity: 'Activity', export: 'Export' };

export function FlumeApp({ controller, components, autoStart = true, initialProjectId, previewLabel }: FlumeAppProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const { Brand, TakeReview, ActivityPanel, GenerationReview } = components;
  const drawerId = useId();
  const [creating, setCreating] = useState<'project' | 'shot' | null>(null);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const [drawer, setDrawer] = useState<DrawerKind | null>(null);
  // The stage view belongs to one shot; another shot always opens on its frames.
  const [stage, setStage] = useState<{ shotId: string | null; view: 'frames' | 'takes' }>({ shotId: null, view: 'frames' });
  const [discardEpoch,setDiscardEpoch] = useState(0);
  const reviewRef = useRef<HTMLDivElement>(null);
  const reviewOpener = useRef<HTMLElement | null>(null);
  const restoreReviewFocus = useRef(false);
  const workspace = state.workspace;
  const project = workspace?.project;
  const shots = workspace && project ? workspace.shots.filter(item => item.projectId === project.id) : [];
  const shotIndex = shots.findIndex(item => item.id === state.activeShotId);
  const shot = shotIndex >= 0 ? shots[shotIndex] : undefined;
  const review = workspace?.reviews.find(item => item.id === state.reviewId);
  const busy = !!state.busy;
  const held = busy || !!state.uncertainCommand;
  const activeWork = workspace?.attempts.some(item => ['queued', 'running', 'retrieving'].includes(item.status)) || workspace?.exports.some(item => ['queued', 'running'].includes(item.status));
  const watching = workspace?.attempts.filter(item => item.projectId === project?.id && needsWatching(item)) ?? [];
  const dataState = state.phase === 'ready' ? 'ready' : state.phase === 'error' ? 'error' : 'loading';
  const view = stage.shotId === shot?.id ? stage.view : 'frames';

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
  function openShot(id: string, nextView: 'frames' | 'takes' = 'frames') {
    navigate(() => { if (id === shot?.id || controller.selectShot(id)) setStage({ shotId: id, view: nextView }); });
  }
  const toggleDrawer = (kind: DrawerKind) => setDrawer(current => current === kind ? null : kind);
  const capability = workspace?.capabilities.find(item => item.modelId === shot?.controls.modelId);
  const blocker = capability?.availability === 'blocked' ? capability.blocker ?? 'This model is not available through the configured provider.' : null;
  const saveLabel = busy ? 'Saving / checking…' : state.uncertainCommand ? 'Request needs checking' : state.dirtyShotIds.size ? 'Unsaved changes' : state.error ? 'Check saved state' : project ? 'Saved workspace' : 'Local workspace';
  const phase = shot && workspace ? shotPhase(shot, workspace, { dirty: state.dirtyShotIds.has(shot.id), review: review && !state.dirtyShotIds.has(shot.id) ? review : null }) : null;
  const projects = project && !state.projects.some(item => item.id === project.id) ? [...state.projects, project] : state.projects;
  const openDrawer = drawer && (drawer === 'projects' || project) ? drawer : null;

  return <div className="fl-theme fl-workspace">
    <a className="fl-workspace__skip" href="#fl-canvas">Skip to stage</a>
    {previewLabel && <div className="fl-workspace__preview-label" role="note">{previewLabel}</div>}
    <header className="fl-workspace__top">
      <div className="fl-workspace__brand"><Brand /></div>
      <button type="button" className="fl-workspace__project" aria-expanded={openDrawer === 'projects'} aria-controls={openDrawer === 'projects' ? drawerId : undefined} onClick={() => toggleDrawer('projects')}>
        <span className="fl-workspace__project-name">{project?.name ?? (dataState === 'loading' ? 'Opening…' : 'Choose a project')}</span>
        <span className="fl-workspace__project-meta" aria-label={dataState !== 'ready' ? 'Project count unavailable' : undefined}>{dataState === 'ready' ? `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}` : '—'}</span>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 4.5l3 3 3-3" /></svg>
      </button>
      <div className="fl-workspace__top-r">
        <span className="fl-workspace__save-state" aria-live="polite">{saveLabel}</span>
        <button type="button" className="fl-tbtn" disabled={busy || state.phase === 'loading'} onClick={() => run(() => state.phase === 'error' ? controller.start(initialProjectId) : controller.refresh())}>Refresh</button>
        <button type="button" className="fl-tbtn fl-workspace__library-button" aria-expanded={openDrawer === 'library'} aria-controls={openDrawer === 'library' ? drawerId : undefined} disabled={!project} onClick={() => toggleDrawer('library')}><span>Library</span><span className="fl-tbtn__meta" aria-label={!workspace ? 'Media count unavailable' : undefined}>{workspace?.assets.length ?? '—'}</span></button>
        <button type="button" className="fl-tbtn" aria-expanded={openDrawer === 'activity'} aria-controls={openDrawer === 'activity' ? drawerId : undefined} disabled={!project} onClick={() => toggleDrawer('activity')}>Activity{watching.length > 0 && <span className="fl-count" data-tone={watching.some(isUnknown) ? 'unknown' : 'running'}><span className="fl-vh">, </span>{watching.length}<span className="fl-vh"> to watch</span></span>}</button>
        <button type="button" className="fl-tbtn" aria-expanded={openDrawer === 'export'} aria-controls={openDrawer === 'export' ? drawerId : undefined} disabled={!project} onClick={() => toggleDrawer('export')}>Export</button>
      </div>
    </header>

    {state.error && <div className="fl-workspace__issue" role="alert">
      <div><strong>{state.error.currentRevision !== undefined ? 'This shot changed elsewhere.' : state.uncertainCommand ? 'The request may have been accepted.' : 'Action needs attention.'}</strong>
        <p>{state.error.message}</p>
        {state.error.currentRevision !== undefined && <p>Your draft is still here. Saved revision is {state.error.currentRevision}. Refresh, then compare or discard the draft in the editor; nothing is overwritten automatically.</p>}
        {state.uncertainCommand && <p>New actions are on hold. Check the saved state, or retry the original request with the same identity. Do not start another generation.</p>}
      </div>
      <button className="fl-btn fl-btn--ghost fl-btn--sm" disabled={busy} onClick={() => run(() => state.phase === 'error' ? controller.start(initialProjectId) : controller.refresh())}>Check saved state</button>
      {state.uncertainCommand && <button className="fl-btn fl-btn--ghost fl-btn--sm" disabled={busy} onClick={() => run(() => controller.retryUncertain())}>Retry original request</button>}
    </div>}

    <div className="fl-workspace__app" data-slate={!!(project && shot) || undefined}>
      <main id="fl-canvas" className="fl-workspace__stage" tabIndex={-1} aria-label="Stage" data-drawer={openDrawer ? true : undefined}>
        {shot && workspace && project && <div className="fl-workspace__stagebar">
          <div className="fl-seg" role="group" aria-label="Stage view">
            <button type="button" aria-pressed={view === 'frames'} onClick={() => setStage({ shotId: shot.id, view: 'frames' })}>Frames</button>
            <button type="button" aria-pressed={view === 'takes'} onClick={() => setStage({ shotId: shot.id, view: 'takes' })}>Takes <span className="fl-mono">{shotTakes(shot, workspace.takes).length}</span></button>
          </div>
          <span className="fl-workspace__stagebar-mid fl-mono">{shot.selectedTakeId ? 'Selected take on the reel' : 'No selected take'}{state.dirtyShotIds.has(shot.id) ? ' · showing the saved shot' : ''}</span>
          <span className="fl-mono fl-dim">{shot.controls.aspectRatio} · {shot.controls.resolution}</span>
        </div>}
        <div className="fl-workspace__stagebody">
          {openDrawer && <Drawer key={openDrawer} id={drawerId} title={drawerTitles[openDrawer]} meta={openDrawer === 'library' && workspace ? `${workspace.assets.length} files` : undefined} onClose={() => setDrawer(null)}>
            {openDrawer === 'projects' ? <ProjectsDrawer projects={projects} activeProjectId={project?.id ?? null} dataState={dataState} disabled={held || state.phase === 'loading'} onOpen={id => navigate(() => { setDrawer(null); run(() => controller.openProject(id)); })} onCreate={() => navigate(() => setCreating('project'))} />
              : !workspace ? null
              : openDrawer === 'library' ? <LibraryDrawer workspace={workspace} shots={shots} held={held} onImport={file => run(() => controller.uploadAsset(file))} />
              : openDrawer === 'activity' ? <ActivityDrawer workspace={workspace} shots={shots} held={held} ActivityPanel={ActivityPanel} onResume={id => notify(() => controller.resume(id))} onOpenShot={id => openShot(id)} />
              : <ExportDrawer workspace={workspace} shots={shots} held={held} onOpenTakes={id => openShot(id, 'takes')} />}
          </Drawer>}
          <div className="fl-workspace__stagescroll">
          {(state.phase === 'loading' || state.phase === 'idle') ? <div className="fl-empty" role="status"><div className="fl-workspace__loading-frame" aria-hidden="true" /><h1>Opening your workspace…</h1><p>Loading saved projects, shots and media.</p></div>
            : !project ? <div className="fl-empty fl-workspace__welcome"><p className="fl-eyebrow">Flume</p><h1>A place for your next film.</h1><p>Create a project, shape a shot, and give its first and last moments their own frames.</p><button className="fl-btn fl-btn--primary" disabled={held || state.phase === 'error'} onClick={() => setCreating('project')}>Create a project</button><p className="fl-mono fl-dim">Your work saves locally. Generation is reviewed before it is sent.</p></div>
            : !shot || !workspace ? <div className="fl-empty fl-workspace__first-shot"><p className="fl-eyebrow">{project.name}</p><h1>A new film</h1><p>A shot holds your direction, its start and end frames and every take. Nothing is sent until you approve a request.</p><button className="fl-btn fl-btn--primary" disabled={held} onClick={() => setCreating('shot')}>Create a shot</button></div>
            : <>
              <RunCard shot={shot} number={shotNumber(shotIndex)} workspace={workspace} onOpenActivity={() => setDrawer('activity')} />
              {view === 'frames' ? <FramePair key={shot.id} shot={shot} workspace={workspace} />
                : <section className="fl-workspace__takes" aria-label="Takes"><TakeReview shot={shot} takes={shotTakes(shot, workspace.takes)} assets={workspace.assets} exports={workspace.exports.filter(item => item.shotId === shot.id)} busy={held || state.dirtyShotIds.has(shot.id)} onInspect={id => notify(() => controller.inspectTake(id))} onSelect={(id, inspectionId) => notify(() => controller.selectTake(shot.id, id, shot.revision, shot.selectionRevision, inspectionId))} onExport={() => notify(() => controller.exportShot(shot.id, shot.revision, shot.selectionRevision))} /></section>}
            </>}
          </div>
        </div>
      </main>

      {project && shot && workspace && phase && <aside className="fl-workspace__slate" aria-label="Shot slate">
        <div className="fl-workspace__slatehead">
          <div className="fl-workspace__shotnum" aria-hidden="true">{shotNumber(shotIndex)}</div>
          <div>
            <p className="fl-eyebrow">{project.name}</p>
            <h1 className="fl-workspace__shottitle"><span className="fl-vh">Shot {shotNumber(shotIndex)}, </span>{shot.title}</h1>
            <div className="fl-workspace__headmeta"><span className="fl-mono fl-dim">{shot.controls.durationSeconds} s · {shot.controls.aspectRatio} · {shot.controls.resolution}</span><span className="fl-phase" data-phase={phase.key}>{phase.key === 'running' && <span className="fl-pulse" aria-hidden="true" />}{phase.label}</span></div>
          </div>
        </div>
        {blocker && <div className="fl-workspace__provider-blocker"><span className="fl-workspace__status-dot" aria-hidden="true" /><p><strong>Generation unavailable.</strong> {blocker} <span>Editing is still available.</span></p></div>}
        <section className="fl-workspace__composer" aria-label="Shot composer"><EditorBoundary key={`${shot.id}:${discardEpoch}`} shot={shot} workspace={workspace} state={state} controller={controller} components={components} onPrepare={(revision, opener) => { reviewOpener.current = opener; return controller.prepare(shot.id, revision); }} /></section>
      </aside>}

      {(project || dataState !== 'ready') && <Reel project={project ?? null} shots={shots} workspace={workspace} dataState={dataState} activeShotId={state.activeShotId} disabled={held || state.phase === 'loading'}
        status={state.notice ?? 'Original media stays in your project. No generation starts automatically.'}
        onShotActivate={id => openShot(id)} onCreateShot={() => navigate(() => setCreating('shot'))} />}
    </div>
    {!project && <p className="fl-workspace__footer" role="status">{state.notice ?? 'Create something worth keeping.'}</p>}

    {review && shot && workspace && <div ref={reviewRef} tabIndex={-1} className="fl-workspace__review" aria-label="Generation review"><GenerationReview review={review} assets={workspace.assets} busy={held || state.dirtyShotIds.has(shot.id) || review.shotRevision !== shot.revision} onApprove={limits => notify(() => controller.approve(review.id, limits))} onSubmit={() => notify(() => controller.submit(review.id))} onDismiss={() => { restoreReviewFocus.current = true; controller.dismissReview(); }} /></div>}
    {creating && <CreateDialog kind={creating} busy={held} onDismiss={() => setCreating(null)} onCreate={async (name, detail) => { await notify(() => creating === 'project' ? controller.createProject(name, detail) : controller.createShot(name, detail)); setCreating(null); }} />}
    {leaving && <Modal label="Leave this shot?" onDismiss={() => setLeaving(null)}><h2>Keep your changes?</h2><p>This shot has unsaved edits. Stay to save them, or discard the draft before leaving. Saved media is not removed.</p><div className="fl-workspace__dialog-actions"><button className="fl-btn fl-btn--ghost" onClick={() => setLeaving(null)}>Stay here</button><button className="fl-btn fl-btn--ghost" onClick={finishNavigation}>Discard and continue</button></div></Modal>}
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

const frameCopy: Record<FrameKey, { label: string; verb: string; empty: string; hint: string }> = {
  firstFrameAssetId: { label: 'Start frame', verb: 'Opens on', empty: 'Your shot starts here.', hint: 'Choose a start frame in the slate.' },
  lastFrameAssetId: { label: 'End frame', verb: 'Lands on', empty: 'Give the shot an ending.', hint: 'Choose an end frame in the slate.' },
};

/** The saved shot's two frame roles and direction. Media is owned and shown whole, never cropped. */
function FramePair({ shot, workspace }: { shot: Shot; workspace: Workspace }) {
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  return <div className="fl-pair-wrap">
    <div className="fl-pair">
      {(['firstFrameAssetId', 'lastFrameAssetId'] as const).map(key => {
        const copy = frameCopy[key];
        const frame = frameState(shot, key, workspace);
        const url = frame.asset && ownedMediaUrl(frame.asset);
        const shown = !!(frame.asset && url && !failed[frame.asset.id]);
        return <figure key={key} className="fl-frame" aria-label={copy.label}>
          <figcaption className="fl-frame__cap"><span className="fl-eyebrow">{copy.label} · {copy.verb}</span><span className="fl-chip" data-kind={frame.kind}>{frame.label}</span></figcaption>
          <div className="fl-gate" data-kind={frame.kind} data-media={shown || undefined}>
            {shown && <img key={frame.asset!.id} src={url} alt={`${copy.label}: ${frame.asset!.filename}`} onError={() => setFailed(previous => ({ ...previous, [frame.asset!.id]: true }))} />}
            {!shown && <div className="fl-gate__msg">{frame.kind === 'missing' ? <><b>File not found</b><span>This shot still points to <span className="fl-mono">{shot.bindings[key]}</span>. Choose a replacement or clear it in the slate.</span></>
              : frame.asset ? <><b>This preview could not load.</b><span>Refresh the project to check the owned media. Your shot settings are unchanged.</span></>
              : <><b>{copy.empty}</b><span>{copy.hint}</span></>}</div>}
            {frame.kind === 'unsupported' && shown && <span className="fl-gate__kept">Kept on the shot. This model doesn’t take {key === 'firstFrameAssetId' ? 'a start' : 'an end'} frame, so review stays blocked until you clear it or change the model.</span>}
            <i className="fl-cn fl-cn--tl" aria-hidden="true" /><i className="fl-cn fl-cn--tr" aria-hidden="true" /><i className="fl-cn fl-cn--bl" aria-hidden="true" /><i className="fl-cn fl-cn--br" aria-hidden="true" />
          </div>
          <div className="fl-frame__file"><span>{frame.asset?.filename ?? (frame.kind === 'missing' ? 'Unavailable image' : 'No frame bound')}</span><span>{frame.asset ? `${frame.asset.width} × ${frame.asset.height}` : ''}</span></div>
        </figure>;
      })}
      <div className="fl-pair__conn" aria-hidden="true"><svg viewBox="0 0 40 12" width="40" height="12" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M1 6h36M32 1.5 37 6l-5 4.5" /></svg><span className="fl-mono">{shot.controls.durationSeconds} s</span></div>
    </div>
    <p className="fl-script" data-empty={!shot.prompt.trim() || undefined}><span className="fl-eyebrow">Saved direction</span>{shot.prompt.trim() ? shot.prompt : 'No direction yet. Write it in the slate; it is sent exactly as written.'}</p>
  </div>;
}

/** Shows only what Activity knows. No percentage or time remaining is ever invented. */
function RunCard({ shot, number, workspace, onOpenActivity }: { shot: Shot; number: string; workspace: Workspace; onOpenActivity(): void }) {
  const attempts = workspace.attempts.filter(item => item.shotId === shot.id && item.projectId === shot.projectId && needsWatching(item));
  if (!attempts.length) return null;
  const unknown = attempts.some(isUnknown);
  return <div className="fl-run" data-state={unknown ? 'unknown' : 'running'} role="status">
    <div className="fl-run__copy">
      <p className="fl-eyebrow">Shot {number} · {attempts.length === 1 ? `revision ${attempts[0]!.shotRevision}` : `${attempts.length} attempts`}</p>
      <h2>{unknown ? 'Status unknown' : 'Generating'}</h2>
      <p>{unknown ? 'Flume couldn’t confirm whether the provider accepted this request. Sending it again could create another charge. Check the existing attempt in Activity.' : 'The model doesn’t report progress, so none is shown. You can keep working; new takes are never selected automatically.'}</p>
    </div>
    {!unknown && <div className="fl-bar" aria-hidden="true"><span /></div>}
    <button type="button" className="fl-btn fl-btn--ghost fl-btn--sm" onClick={onOpenActivity}>Open activity</button>
  </div>;
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
  return <Modal label={`Create a ${kind}`} onDismiss={onDismiss} busy={busy}><form onSubmit={submit}><h2>Create a {kind}</h2><p>{kind === 'project' ? 'Give your film a home. You can start with a single shot.' : 'Name the moment. Its direction and frame references come next.'}</p><label htmlFor="fl-create-name">{kind === 'project' ? 'Project name' : 'Shot title'}</label><input autoFocus id="fl-create-name" value={name} onChange={event => setName(event.target.value)} required maxLength={240} disabled={busy} /><label htmlFor="fl-create-detail">{kind === 'project' ? 'Brief' : 'Shot direction'} <span>(optional)</span></label><textarea id="fl-create-detail" rows={4} value={detail} onChange={event => setDetail(event.target.value)} disabled={busy} />{error && <p role="alert">{error}</p>}<div className="fl-workspace__dialog-actions"><button type="button" className="fl-btn fl-btn--ghost" disabled={busy} onClick={onDismiss}>Cancel</button><button className="fl-btn fl-btn--primary" disabled={busy || !name.trim()}>{busy ? 'Creating…' : `Create ${kind}`}</button></div></form></Modal>;
}
