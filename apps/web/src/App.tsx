import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { WorkspaceController } from './controller.ts';
import type { DraftFrameReport, WorkspaceComponents } from './ports.ts';
import type { Project, Shot, Workspace, WorkspaceState } from './types.ts';
import { Reel } from './Reel.tsx';
import { ActivityDrawer, Drawer, ExportDrawer, LibraryDrawer, ProjectsDrawer } from './Drawers.tsx';
import type { DrawerKind } from './Drawers.tsx';
import { ownedMediaUrl, restoreOpener } from './shell.ts';
import { frameState, isUnknown, needsWatching, shotNumber, shotPhase, shotTakes } from './shot-status.ts';
import type { FrameKey } from './shot-status.ts';
import { ChatPanel, type ChatPort } from './ChatPanel.tsx';
import { recordedInputsFor, referenceReadKey } from './reference-provenance.ts';
import { HomeShowreel } from './HomeShowreel.tsx';
import { AuthoringStoryboard, FrameAuthoringSurface } from './AuthoringWorkspace.tsx';
import { PROVIDER_SETUP_DOC } from '@flume/activity-review';

// Non-Home empty workspaces retain their established environmental artwork.
function WelcomeLandscape() {
  return <picture className="fl-workspace__landscape" aria-hidden="true">
    <source media="(max-width: 600px)" srcSet="/art/alpine-forest-portrait.webp" />
    <img src="/art/alpine-forest-wide.webp" width={1584} height={672} alt="" decoding="async" fetchPriority="high" />
  </picture>;
}

export { ownedMediaUrl } from './shell.ts';

export interface FlumeAppProps { controller: WorkspaceController; components: WorkspaceComponents; chatPort?: ChatPort; autoStart?: boolean; initialProjectId?: string; initialView?: 'home' | 'workspace'; previewLabel?: string }

const drawerTitles: Record<DrawerKind, string> = { projects: 'Projects', library: 'Library', activity: 'Activity', export: 'Export', story: 'Storyboard' };

export function FlumeApp({ controller, components, chatPort, autoStart = true, initialProjectId, initialView, previewLabel }: FlumeAppProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const { Brand, TakeReview, ActivityPanel, GenerationReview } = components;
  const drawerId = useId();
  const [creating, setCreating] = useState<'project' | 'shot' | null>(null);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const [drawer, setDrawer] = useState<DrawerKind | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [home, setHome] = useState(() => initialView ? initialView === 'home' : autoStart && !initialProjectId);
  const [projectQuery, setProjectQuery] = useState('');
  const [homeMessage, setHomeMessage] = useState<string | null>(null);
  // Draft frame references reported by the live editor. They are presentation
  // only: the preview labels them unsaved and never saves, reviews or approves.
  const [draftPreview, setDraftPreview] = useState<DraftFrameReport | null>(null);
  const draftSaveAction = useRef<(() => void) | null>(null);
  const onDraftChange = useCallback((report: DraftFrameReport) => {
    setDraftPreview(current => JSON.stringify(current) === JSON.stringify(report) ? current : report);
  }, []);
  const registerSaveAction = useCallback((action: (() => void) | null) => { draftSaveAction.current = action; }, []);
  // The stage view belongs to one shot; another shot always opens on its frames.
  const [stage, setStage] = useState<{ shotId: string | null; view: 'frames' | 'takes' | 'author' }>({ shotId: null, view: 'frames' });
  const [discardEpoch,setDiscardEpoch] = useState(0);
  const reviewRef = useRef<HTMLDivElement>(null);
  const reviewOpener = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLElement>(null);
  const restoreReviewFocus = useRef(false);
  const navigationEpoch = useRef(0);
  const [historyIdentity] = useState(() => {
    const marker = typeof window === 'undefined' ? undefined : window.history.state?.flume;
    return marker && typeof marker.session === 'string' && Number.isSafeInteger(marker.index) && marker.index >= 0
      ? { session: marker.session, index: marker.index as number }
      : { session: crypto.randomUUID(), index: 0 };
  });
  const historySession = useRef(historyIdentity.session);
  const historyIndex = useRef(historyIdentity.index);
  const historyTagged = useRef(false);
  const suppressPop = useRef(0);
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
  const atHome = home;

  useEffect(() => { if (autoStart) void controller.start(initialProjectId); }, [autoStart, controller, initialProjectId]);
  // Configured authoring capabilities are server facts; they are read per open project.
  useEffect(() => { if (!project || atHome) return; void controller.loadAuthoring(); }, [controller, project?.id, atHome]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') void (atHome ? controller.refreshProjects() : controller.refresh()); };
    const timer = activeWork ? window.setInterval(refresh, 4000) : undefined;
    window.addEventListener('focus', refresh);
    return () => { if (timer !== undefined) window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [controller, activeWork, atHome]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (state.dirtyShotIds.size || busy || state.uncertainCommand) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [state.dirtyShotIds, busy, state.uncertainCommand]);

  useEffect(() => {
    const panel = reviewRef.current;
    if (atHome || !panel || !review) return;
    const previous = reviewOpener.current;
    panel.focus({ preventScroll: true });
    panel.scrollIntoView({ block: 'nearest' });
    return () => {
      if (restoreReviewFocus.current) restoreOpener(previous, panel);
      reviewOpener.current = null;
      restoreReviewFocus.current = false;
    };
  }, [review?.id, atHome]);

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
  function openShot(id: string, nextView: 'frames' | 'takes' | 'author' = 'frames') {
    navigate(() => { if (id === shot?.id || controller.selectShot(id)) setStage({ shotId: id, view: nextView }); });
  }
  function rememberProject(id: string) {
    try { window.localStorage.setItem('flume.resumeProjectId', id); } catch { /* Storage is optional. */ }
  }
  function updateLocation(id?: string, replace = false) {
    if (!autoStart) return;
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('projectId', id); else url.searchParams.delete('projectId');
    if (!replace) historyIndex.current += 1;
    const state = { flume: { session: historySession.current, index: historyIndex.current } };
    window.history[replace ? 'replaceState' : 'pushState'](state, '', `${url.pathname}${url.search}${url.hash}`);
  }
  async function openProject(id: string, intent: 'workspace' | 'shot' | 'chat' | 'takes' | 'library' = 'workspace', replace = false, history = true): Promise<boolean> {
    if (held) return false;
    if (!state.projects.some(item => item.id === id)) {
      setHomeMessage('That project is not available.');
      return false;
    }
    const epoch = ++navigationEpoch.current;
    setHomeMessage(null);
    await notify(() => controller.openProject(id));
    if (epoch !== navigationEpoch.current) return false;
    const snapshot = controller.getSnapshot();
    const opened = snapshot.workspace;
    if (snapshot.phase !== 'ready' || opened?.project?.id !== id) {
      setHomeMessage('That project could not be opened. Your previous workspace is unchanged.');
      return false;
    }
    rememberProject(id); if (history) updateLocation(id, replace); setHome(false); setDrawer(null);
    if (intent === 'shot') setCreating('shot');
    if (intent === 'chat') {
      if (chatPort) setChatOpen(true); else setHomeMessage('Project chat is not available in this workspace.');
    }
    if (intent === 'library') setDrawer('library');
    if (intent === 'takes') {
      const take = opened.takes.find(item => item.projectId === id);
      const takeShot = take && opened.shots.find(item => item.id === take.shotId);
      if (takeShot) { controller.selectShot(takeShot.id); setStage({ shotId: takeShot.id, view: 'takes' }); }
      else setHomeMessage(opened.shots.length ? 'This project has no takes to review yet.' : 'Create a shot before reviewing takes.');
    }
    return true;
  }
  function goHome(replace = false, history = true) {
    navigate(() => {
      ++navigationEpoch.current;
      controller.cancelPendingNavigation();
      setDrawer(null); setChatOpen(false); setHome(true); if (history) updateLocation(undefined, replace);
    });
  }
  useEffect(() => {
    if (!autoStart) return;
    if (!historyTagged.current) {
      historyTagged.current = true;
      window.history.replaceState({ ...window.history.state, flume: { session: historySession.current, index: historyIndex.current } }, '', window.location.href);
    }
    const compensate = (targetIndex?: number) => {
      if (typeof targetIndex === 'number') {
        const delta = historyIndex.current - targetIndex;
        if (delta) { suppressPop.current += 1; window.history.go(delta); }
      } else {
        // A legacy/unmarked destination cannot be indexed reliably. Preserve it
        // and append the rendered location instead of overwriting that entry.
        updateLocation(atHome ? undefined : project?.id);
      }
    };
    const onPop = (event: PopStateEvent) => {
      const marker = (event.state as { flume?: { session?: string; index?: number } } | null)?.flume;
      if (suppressPop.current) { suppressPop.current -= 1; return; }
      const targetIndex = marker && marker.session === historySession.current && typeof marker.index === 'number' ? marker.index : undefined;
      const target = new URLSearchParams(window.location.search).get('projectId');
      if (held) { compensate(targetIndex); setHomeMessage('Finish the current action before navigating.'); return; }
      if (target && !state.projects.some(item => item.id === target)) {
        compensate(targetIndex);
        setHomeMessage('That project is not available.');
        return;
      }
      const accept = () => {
        if (!target) {
          if (typeof targetIndex === 'number') historyIndex.current = targetIndex;
          goHome(false, false);
        } else {
          const epoch = navigationEpoch.current + 1;
          void openProject(target, 'workspace', false, false).then(opened => {
            if (navigationEpoch.current !== epoch) return;
            if (opened) { if (typeof targetIndex === 'number') historyIndex.current = targetIndex; }
            else compensate(targetIndex);
          }).catch(() => { if (navigationEpoch.current === epoch) compensate(targetIndex); });
        }
      };
      if (shot && state.dirtyShotIds.has(shot.id)) {
        compensate(targetIndex);
        setLeaving(() => () => {
          if (typeof targetIndex === 'number') window.history.go(targetIndex - historyIndex.current);
          else accept();
        });
      } else accept();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  });
  const toggleDrawer = (kind: DrawerKind) => setDrawer(current => current === kind ? null : kind);
  // On a stacked phone layout the slate sits below the stage, so the work's next
  // action needs a labelled way in from the first viewport. This only moves
  // focus and scroll: every save and review guard still applies untouched.
  function revealSaveAndReview() {
    const footer = composerRef.current?.querySelector<HTMLElement>('.fl-shot-editor__footer');
    if (!footer) return;
    footer.scrollIntoView?.({ block: 'center' });
    const action = Array.from(footer.querySelectorAll<HTMLButtonElement>('.fl-shot-editor__footer-actions button')).find(button => !button.disabled);
    const target: HTMLElement = action ?? footer;
    if (!action && footer.tabIndex < 0) footer.tabIndex = -1;
    target.focus({ preventScroll: true });
  }
  const capability = workspace?.capabilities.find(item => item.modelId === shot?.controls.modelId);
  const blocker = capability?.availability === 'blocked' ? capability.blocker ?? 'This model is not available through the configured provider.' : null;
  const saveLabel = busy ? 'Saving / checking…' : state.uncertainCommand ? 'Request needs checking' : state.dirtyShotIds.size ? 'Unsaved changes' : state.error ? 'Check saved state' : project ? 'Saved workspace' : 'Local workspace';
  const phase = shot && workspace ? shotPhase(shot, workspace, { dirty: state.dirtyShotIds.has(shot.id), review: review && !state.dirtyShotIds.has(shot.id) ? review : null }) : null;
  const projects = project && !state.projects.some(item => item.id === project.id) ? [...state.projects, project] : state.projects;
  const openDrawer = drawer && (drawer === 'projects' || project) ? drawer : null;
  // Draft frames differ from the saved shot: the stage, not only the editor, says so.
  const draftForShot = shot && draftPreview?.shotId === shot.id ? draftPreview : null;
  const draftPending = !!(shot && draftForShot && ((draftForShot.first?.assetId ?? null) !== shot.bindings.firstFrameAssetId || (draftForShot.last?.assetId ?? null) !== shot.bindings.lastFrameAssetId));
  // Choosing a project is exactly what the Home header selector is for; it only
  // refuses while the truth about the project list is unknown or absent.
  const selectorReason = dataState === 'loading' ? 'Available once your projects have loaded.'
    : dataState === 'error' ? 'Available once your projects load. Use Refresh to try again.'
    : projects.length === 0 ? 'Available once you create a project.'
    : null;
  const selectorEnabled = !held && selectorReason === null;
  const needsProject = !project || atHome;
  const projectReasonProps: { title?: string; 'aria-describedby'?: string } = needsProject
    ? { title: 'Available once a project is open.', 'aria-describedby': `${drawerId}-needs-project` }
    : {};

  return <div className="fl-theme fl-workspace">
    <a className="fl-workspace__skip" href="#fl-canvas">Skip to stage</a>
    {previewLabel && <div className="fl-workspace__preview-label" role="note">{previewLabel}</div>}
    <header className="fl-workspace__top">
      <div className="fl-workspace__brand"><Brand /></div>
      <span id={`${drawerId}-needs-project`} className="fl-vh">Available once a project is open.</span>
      <span id={`${drawerId}-selector-reason`} className="fl-vh">{selectorReason ?? ''}</span>
      <nav className="fl-workspace__places" aria-label="Workspace location">
        <button type="button" aria-current={atHome ? 'page' : undefined} disabled={held} onClick={() => goHome()}>Home</button>
        <button type="button" aria-current={!atHome ? 'page' : undefined} disabled={!project || held} {...projectReasonProps} onClick={() => { if (project) navigate(() => run(() => openProject(project.id))); }}>Workspace</button>
      </nav>
      <button type="button" className="fl-workspace__project" disabled={!selectorEnabled} title={selectorReason ?? undefined} aria-describedby={selectorReason ? `${drawerId}-selector-reason` : undefined} aria-expanded={openDrawer === 'projects'} aria-controls={openDrawer === 'projects' ? drawerId : undefined} onClick={() => toggleDrawer('projects')}>
        <span className="fl-workspace__project-name">{project?.name ?? (dataState === 'loading' ? 'Opening…' : 'Choose a project')}</span>
        <span className="fl-workspace__project-meta" aria-label={dataState !== 'ready' ? 'Project count unavailable' : undefined}>{dataState === 'ready' ? `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}` : '—'}</span>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 4.5l3 3 3-3" /></svg>
      </button>
      <div className="fl-workspace__top-r">
        <span className="fl-workspace__save-state" aria-live="polite">{saveLabel}</span>
        <button type="button" className="fl-tbtn" disabled={busy || state.phase === 'loading'} onClick={() => run(() => atHome ? controller.refreshProjects() : state.phase === 'error' ? controller.start(initialProjectId) : controller.refresh())}>Refresh</button>
        <button type="button" className="fl-tbtn fl-workspace__library-button" aria-expanded={openDrawer === 'library'} aria-controls={openDrawer === 'library' ? drawerId : undefined} disabled={!project || atHome} {...projectReasonProps} onClick={() => toggleDrawer('library')}><span>Library</span><span className="fl-tbtn__meta" aria-label={!workspace ? 'Media count unavailable' : undefined}>{workspace?.assets.length ?? '—'}</span></button>
        <button type="button" className="fl-tbtn" aria-expanded={openDrawer === 'activity'} aria-controls={openDrawer === 'activity' ? drawerId : undefined} disabled={!project || atHome} {...projectReasonProps} onClick={() => toggleDrawer('activity')}>Activity{watching.length > 0 && <span className="fl-count" data-tone={watching.some(isUnknown) ? 'unknown' : 'running'}><span className="fl-vh">, </span>{watching.length}<span className="fl-vh"> to watch</span></span>}</button>
        <button type="button" className="fl-tbtn" aria-expanded={openDrawer === 'export'} aria-controls={openDrawer === 'export' ? drawerId : undefined} disabled={!project || atHome} {...projectReasonProps} onClick={() => toggleDrawer('export')}>Export</button>
        <button type="button" className="fl-tbtn" aria-expanded={openDrawer === 'story'} aria-controls={openDrawer === 'story' ? drawerId : undefined} disabled={!project || atHome} {...projectReasonProps} onClick={() => toggleDrawer('story')}>Storyboard</button>
        {chatPort && <button type="button" className="fl-tbtn" aria-expanded={chatOpen} disabled={!project || atHome} {...projectReasonProps} onClick={() => setChatOpen(value => !value)}>Chat</button>}
      </div>
    </header>

    {state.error && <div className="fl-workspace__issue" role="alert">
      <div><strong>{state.error.currentRevision !== undefined ? 'This shot changed elsewhere.' : state.uncertainCommand ? 'The request may have been accepted.' : 'Action needs attention.'}</strong>
        <p>{state.error.message}</p>
        {state.error.currentRevision !== undefined && <p>Your draft is still here. Saved revision is {state.error.currentRevision}. Refresh, then compare or discard the draft in the editor; nothing is overwritten automatically.</p>}
        {state.uncertainCommand && <p>New actions are on hold. Check the saved state, or retry the original request with the same identity. Do not start another generation.</p>}
      </div>
      <button className="fl-btn fl-btn--ghost fl-btn--sm" disabled={busy} onClick={() => run(() => atHome ? controller.refreshProjects() : state.phase === 'error' ? controller.start(initialProjectId) : controller.refresh())}>Check saved state</button>
      {state.uncertainCommand && <button className="fl-btn fl-btn--ghost fl-btn--sm" disabled={busy} onClick={() => run(() => controller.retryUncertain())}>Retry original request</button>}
    </div>}

    {atHome ? <WorkspaceHome projects={state.projects} phase={state.phase} query={projectQuery} message={homeMessage} held={held} onQuery={setProjectQuery} onCreate={() => setCreating('project')} onOpen={(id, intent) => navigate(() => run(() => openProject(id, intent)))}
      drawer={openDrawer === 'projects' ? <Drawer key={openDrawer} id={drawerId} title="Projects" onClose={() => setDrawer(null)}><ProjectsDrawer projects={projects} activeProjectId={project?.id ?? null} dataState={dataState} disabled={held || state.phase === 'loading'} onOpen={id => navigate(() => run(() => openProject(id)))} onCreate={() => navigate(() => setCreating('project'))} /></Drawer> : undefined} /> : <div className="fl-workspace__app" data-slate={!!(project && shot) || undefined}>
      <main id="fl-canvas" className="fl-workspace__stage" tabIndex={-1} aria-label="Stage" data-drawer={openDrawer ? true : undefined}>
        {shot && workspace && project && <div className="fl-workspace__stagebar">
          <div className="fl-seg" role="group" aria-label="Stage view">
            <button type="button" aria-pressed={view === 'frames'} onClick={() => setStage({ shotId: shot.id, view: 'frames' })}>Frames</button>
            <button type="button" aria-pressed={view === 'takes'} onClick={() => setStage({ shotId: shot.id, view: 'takes' })}>Takes <span className="fl-mono">{shotTakes(shot, workspace.takes).length}</span></button>
            <button type="button" aria-pressed={view === 'author'} onClick={() => setStage({ shotId: shot.id, view: 'author' })}>Author</button>
          </div>
          <button type="button" className="fl-workspace__jump" onClick={revealSaveAndReview}>Jump to save and review</button>
          <span className="fl-workspace__stagebar-mid fl-mono">{shot.selectedTakeId ? 'Selected take on the reel' : 'No selected take'}{draftPending ? ' · showing your unsaved draft' : state.dirtyShotIds.has(shot.id) ? ' · showing the saved shot' : ''}</span>
          <span className="fl-mono fl-dim">{shot.controls.aspectRatio} · {shot.controls.resolution}</span>
        </div>}
        <div className="fl-workspace__stagebody">
          {openDrawer && <Drawer key={openDrawer} id={drawerId} title={drawerTitles[openDrawer]} meta={openDrawer === 'library' && workspace ? `${workspace.assets.length} files` : undefined} onClose={() => setDrawer(null)}>
            {openDrawer === 'projects' ? <ProjectsDrawer projects={projects} activeProjectId={project?.id ?? null} dataState={dataState} disabled={held || state.phase === 'loading'} onOpen={id => navigate(() => run(() => openProject(id)))} onCreate={() => navigate(() => setCreating('project'))} />
              : !workspace ? null
              : openDrawer === 'library' ? <LibraryDrawer workspace={workspace} shots={shots} held={held} onImport={file => run(() => controller.uploadAsset(file))} />
              : openDrawer === 'activity' ? <ActivityDrawer workspace={workspace} shots={shots} held={held} ActivityPanel={ActivityPanel} onResume={id => notify(() => controller.resume(id))} onOpenShot={id => openShot(id)} />
              : openDrawer === 'story' ? <AuthoringStoryboard controller={controller} state={state} workspace={workspace} />
              : <ExportDrawer workspace={workspace} shots={shots} held={held} onOpenTakes={id => openShot(id, 'takes')} />}
          </Drawer>}
          <div className="fl-workspace__stagescroll">
          {(state.phase === 'loading' || state.phase === 'idle') ? <div className="fl-empty" role="status"><div className="fl-workspace__loading-frame" aria-hidden="true" /><h1>Opening your workspace…</h1><p>Loading saved projects, shots and media.</p></div>
            : !project ? <div className="fl-empty fl-workspace__welcome fl-workspace__environment"><WelcomeLandscape /><div className="fl-workspace__welcome-copy"><p className="fl-eyebrow">Flume</p><h1>A place for your next film.</h1><p>Create a project, shape a shot, and give its first and last moments their own frames.</p><button className="fl-btn fl-btn--primary" disabled={held || state.phase === 'error'} onClick={() => setCreating('project')}>Create a project</button><p className="fl-mono fl-dim">Your work saves locally. Generation is reviewed before it is sent.</p><p className="fl-workspace__byline">by Mountain Meadow Systems</p></div></div>
            : !shot || !workspace ? <div className="fl-empty fl-workspace__first-shot fl-workspace__environment"><WelcomeLandscape /><div className="fl-workspace__welcome-copy"><p className="fl-eyebrow">Project</p><h1>{project.name}</h1><p>A shot holds your direction, its start and end frames and every take. Nothing is sent until you approve a request.</p><button className="fl-btn fl-btn--primary" disabled={held} onClick={() => setCreating('shot')}>Create a shot</button><p className="fl-workspace__byline">App by Mountain Meadow Systems</p></div></div>
            : <>
              <RunCard shot={shot} number={shotNumber(shotIndex)} workspace={workspace} onOpenActivity={() => setDrawer('activity')} />
              {view === 'frames' ? <FramePair key={shot.id} shot={shot} workspace={workspace} draft={draftForShot} onSaveDraft={() => draftSaveAction.current?.()} />
                : view === 'author' ? <FrameAuthoringSurface controller={controller} state={state} shot={shot} workspace={workspace} />
                : <section className="fl-workspace__takes" aria-label="Takes"><TakeReview shot={shot} takes={shotTakes(shot, workspace.takes)} assets={workspace.assets} exports={workspace.exports.filter(item => item.shotId === shot.id)} busy={held || state.dirtyShotIds.has(shot.id)} onInspect={id => notify(() => controller.inspectTake(id))} onSelect={(id, inspectionId) => notify(() => controller.selectTake(shot.id, id, shot.revision, shot.selectionRevision, inspectionId))} onExport={() => notify(() => controller.exportShot(shot.id, shot.revision, shot.selectionRevision))} recordedInputs={take => recordedInputsFor(state.references?.[referenceReadKey(take.projectId, take.attemptId)])} onReadRecordedInputs={take => { void controller.readReferenceReceipt(take.projectId, take.attemptId); }} /></section>}
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
        {blocker && <div className="fl-workspace__provider-blocker"><span className="fl-workspace__status-dot" aria-hidden="true" /><p><strong>Generation is blocked in this build.</strong> {blocker} <span>Editing and saving still work. Choose a model whose route is available, or ask whoever runs this Flume build to confirm provider access.</span></p><p className="fl-workspace__provider-help"><a className="fl-link" href={PROVIDER_SETUP_DOC.href} target="_blank" rel="noopener noreferrer">{PROVIDER_SETUP_DOC.label}</a><span> (opens in a new tab)</span></p></div>}
        <section ref={composerRef} className="fl-workspace__composer" aria-label="Shot composer"><p className="fl-eyebrow fl-workspace__composer-label">Shot editor</p><EditorBoundary key={`${shot.id}:${discardEpoch}`} shot={shot} workspace={workspace} state={state} controller={controller} components={components} onDraftChange={onDraftChange} registerSaveAction={registerSaveAction} onPrepare={(revision, opener) => { reviewOpener.current = opener; return controller.prepare(shot.id, revision); }} /></section>
      </aside>}

      {(project || dataState !== 'ready') && <Reel project={project ?? null} shots={shots} workspace={workspace} dataState={dataState} activeShotId={state.activeShotId} disabled={held || state.phase === 'loading'}
        status={state.notice ?? 'Original media stays in your project. No generation starts automatically.'}
        onShotActivate={id => openShot(id)} onCreateShot={() => navigate(() => setCreating('shot'))} />}
    </div>}
    {atHome && <p className="fl-workspace__footer" role="status">{homeMessage ?? state.notice ?? 'Nothing is created or sent until you choose an action.'}</p>}
    {!atHome && homeMessage && <p className="fl-workspace__intent-note" role="status">{homeMessage}</p>}

    {!atHome && review && shot && workspace && <div ref={reviewRef} tabIndex={-1} className="fl-workspace__review" aria-label="Generation review"><GenerationReview review={review} assets={workspace.assets} busy={held || state.dirtyShotIds.has(shot.id) || review.shotRevision !== shot.revision} onApprove={limits => notify(() => controller.approve(review.id, limits))} onSubmit={() => notify(() => controller.submit(review.id))} onDismiss={() => { restoreReviewFocus.current = true; controller.dismissReview(); }} /></div>}
    {creating && <CreateDialog kind={creating} busy={held} onDismiss={() => setCreating(null)} onCreate={async (name, detail) => { const kind = creating; await notify(() => kind === 'project' ? controller.createProject(name, detail) : controller.createShot(name, detail)); setCreating(null); if (kind === 'project') { const id = controller.getSnapshot().workspace?.project?.id; if (id) { rememberProject(id); updateLocation(id); setHome(false); } } }} />}
    {leaving && <Modal label="Leave this shot?" onDismiss={() => setLeaving(null)}><h2>Keep your changes?</h2><p>This shot has unsaved edits. Stay to save them, or discard the draft before leaving. Saved media is not removed.</p><div className="fl-workspace__dialog-actions"><button className="fl-btn fl-btn--ghost" onClick={() => setLeaving(null)}>Stay here</button><button className="fl-btn fl-btn--ghost" onClick={finishNavigation}>Discard and continue</button></div></Modal>}
    {chatOpen && chatPort && project && <section className="fl-chat-shell" role="dialog" aria-modal="false" aria-label="Project chat"><div className="fl-chat-shell__head"><strong>Project assistant</strong><button className="fl-drawer__close" aria-label="Close project chat" onClick={() => setChatOpen(false)}>×</button></div><ChatPanel key={project.id} port={chatPort} project={project} shot={shot} dirty={!!shot && state.dirtyShotIds.has(shot.id)} blocked={!!state.busy || !!state.uncertainCommand || (!!shot && state.dirtyShotIds.has(shot.id))} assets={workspace?.assets ?? []} onApplied={async () => { await controller.refresh(); if (controller.getSnapshot().error) throw new Error('Applied proposal readback failed.'); }} onWorkspaceRefresh={async () => { if (controller.getSnapshot().workspace?.project?.id !== project.id) return; await controller.refresh(); const refreshed = controller.getSnapshot(); if (refreshed.workspace?.project?.id !== project.id) return; if (refreshed.error) throw new Error('The project library could not be refreshed.'); }} onUseReferenceFrame={async input => { const key = input.frame === 'first' ? 'firstFrameAssetId' : 'lastFrameAssetId'; await controller.saveShot(input.shotId, input.expectedRevision, { bindings: { [key]: input.assetId } }); }} /></section>}
  </div>;
}

function WorkspaceHome({ projects, phase, query, message, held, onQuery, onCreate, onOpen, drawer }: { projects: Project[]; phase: WorkspaceState['phase']; query: string; message: string | null; held: boolean; onQuery(value: string): void; onCreate(): void; onOpen(id: string, intent?: 'workspace' | 'shot' | 'chat' | 'takes' | 'library'): void; drawer?: ReactNode }) {
  const normalized = query.trim().toLocaleLowerCase();
  const shown = projects.filter(item => !normalized || `${item.name}\n${item.brief}`.toLocaleLowerCase().includes(normalized));
  let resumeId: string | null = null;
  try { resumeId = window.localStorage.getItem('flume.resumeProjectId'); } catch { /* Storage is optional. */ }
  const resume = projects.find(item => item.id === resumeId);
  return <main id="fl-canvas" className="fl-home" tabIndex={-1}>
    {drawer && <div className="fl-home__selector">{drawer}</div>}
    <section className="fl-home__hero">
      <div className="fl-home__hero-copy"><p className="fl-eyebrow">Workspace home</p><h1>Make room for the next scene.</h1><p>Open a project to shape its shots, references, takes, and assets, or start something new. Nothing is generated, uploaded, or sent from this page.</p><div className="fl-home__hero-actions"><button className="fl-btn fl-btn--primary" disabled={held} onClick={onCreate}>Create project</button>{resume && <button className="fl-btn fl-btn--ghost" disabled={held} onClick={() => onOpen(resume.id)}>Continue editing <span>{resume.name}</span></button>}</div></div>
      <HomeShowreel />
    </section>
    <section className="fl-home__projects" aria-labelledby="fl-home-projects">
      <div className="fl-home__section-head"><div><p className="fl-eyebrow">In this workspace</p><h2 id="fl-home-projects">Your projects</h2></div><button className="fl-btn fl-btn--ghost fl-btn--sm" disabled={held} onClick={onCreate}>Create project</button></div>
      <label className="fl-home__search"><span className="fl-vh">Search your projects</span><input type="search" aria-label="Search your projects" value={query} onChange={event => onQuery(event.currentTarget.value)} placeholder="Search names and briefs" /></label>
      {phase === 'loading' || phase === 'idle' ? <div className="fl-home__state" role="status">Loading your projects…</div>
        : phase === 'error' ? <div className="fl-home__state" role="alert">Projects could not be loaded. Use Refresh to try again.</div>
        : projects.length === 0 ? <div className="fl-home__state"><h3>No projects yet</h3><p>Create a project to start shaping a shot.</p></div>
        : shown.length === 0 ? <div className="fl-home__state" role="status">No projects match “{query.trim()}”.</div>
        : <div className="fl-home__grid">{shown.map(project => <article className="fl-home-card" key={project.id}><button type="button" className="fl-home-card__open" disabled={held} aria-label={`Open ${project.name}`} onClick={() => onOpen(project.id)}><span className="fl-home-card__mark" aria-hidden="true">{project.name.trim().slice(0, 1).toLocaleUpperCase() || '·'}</span><span><strong>{project.name}</strong>{project.brief && <small>{project.brief}</small>}</span><span className="fl-home-card__open-label">Open <span aria-hidden="true">→</span></span></button><div className="fl-home-card__actions" role="group" aria-label={`${project.name} actions`}><button type="button" className="fl-home-card__subaction" aria-label={`Build a shot in ${project.name}`} disabled={held} onClick={() => onOpen(project.id, 'shot')}>Build a shot</button><button type="button" className="fl-home-card__subaction" aria-label={`Analyze references in ${project.name}`} disabled={held} onClick={() => onOpen(project.id, 'chat')}>Analyze references</button><button type="button" className="fl-home-card__subaction" aria-label={`Review takes in ${project.name}`} disabled={held} onClick={() => onOpen(project.id, 'takes')}>Review takes</button><button type="button" className="fl-home-card__subaction" aria-label={`Browse assets in ${project.name}`} disabled={held} onClick={() => onOpen(project.id, 'library')}>Browse assets</button></div></article>)}</div>}
      {message && <p className="fl-home__message" role="status">{message}</p>}
    </section>
  </main>;
}

function EditorBoundary({ shot, workspace, state, controller, components, onPrepare, onDraftChange, registerSaveAction }: { shot: Shot; workspace: Workspace; state: WorkspaceState; controller: WorkspaceController; components: WorkspaceComponents; onPrepare(revision: number, opener: HTMLElement | null): Promise<void>; onDraftChange(report: DraftFrameReport): void; registerSaveAction(action: (() => void) | null): void }) {
  const { ShotEditor } = components;
  const ref = useRef<HTMLDivElement>(null);
  const baseRevision = useRef(shot.revision);
  const onDirtyChange = useCallback((value:boolean) => value ? controller.markDirty(shot.id) : controller.clearDirty(shot.id), [controller,shot.id]);
  const dirty = state.dirtyShotIds.has(shot.id);
  useEffect(() => { if (!dirty) baseRevision.current = shot.revision; }, [shot.revision, dirty]);
  // Dirty authority comes from the canonical editor update, not DOM input:
  // capture-time store emissions can restore controlled text before onChange.
  return <div ref={ref}>
    <ShotEditor shot={shot} assets={workspace.assets} capabilities={workspace.capabilities} busy={!!state.busy || !!state.uncertainCommand} error={state.error} onDirtyChange={onDirtyChange} onDraftChange={onDraftChange} registerSaveAction={registerSaveAction} onSave={async (patch, revision = baseRevision.current) => { const saved = await controller.saveShot(shot.id, revision, patch); baseRevision.current = saved.revision; return saved; }} onUpload={file => controller.uploadAsset(file)} onPrepare={(revision = baseRevision.current) => {
      // Capture before the controller's busy update disables and blurs the trigger.
      const active = document.activeElement;
      return onPrepare(revision, active instanceof HTMLElement && ref.current?.contains(active) ? active : null);
    }} />
  </div>;
}

const frameCopy: Record<FrameKey, { label: string; verb: string; empty: string; hint: string }> = {
  firstFrameAssetId: { label: 'Start frame', verb: 'Opens on', empty: 'Your shot starts here.', hint: 'Choose a start frame in the shot editor.' },
  lastFrameAssetId: { label: 'End frame', verb: 'Lands on', empty: 'Give the shot an ending.', hint: 'Choose an end frame in the shot editor.' },
};

/** The saved shot's two frame roles and direction, with staged draft frames clearly marked. */
function FramePair({ shot, workspace, draft, onSaveDraft }: { shot: Shot; workspace: Workspace; draft?: DraftFrameReport | null; onSaveDraft?(): void }) {
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  // Each figure describes its own draft note, so the save action's scope is announced
  // as words next to the control rather than implied by a frame-only label.
  const noteId = useId();
  return <div className="fl-pair-wrap">
    <div className="fl-pair">
      {(['firstFrameAssetId', 'lastFrameAssetId'] as const).map(key => {
        const copy = frameCopy[key];
        const frame = frameState(shot, key, workspace);
        const draftRef = draft ? (key === 'firstFrameAssetId' ? draft.first : draft.last) : undefined;
        // A staged frame differs from the saved shot; the preview must say so and
        // never pass it to review, approval or generation.
        const staged = draftRef !== undefined && (draftRef?.assetId ?? null) !== shot.bindings[key];
        // Only an intentional null binding is a removal. A staged frame that is
        // still bound but whose media URL is absent or fails to load is a preview
        // problem: the reference, its filename and the dirty state all survive.
        const clearedInDraft = staged && draftRef === null;
        const savedUrl = frame.asset ? ownedMediaUrl(frame.asset) : null;
        // A staged frame is only previewed through the SAME owned-media policy as a
        // saved frame: same origin, no credentials, /api/media/. Anything else keeps
        // its draft identity but is never handed to an <img src>.
        const draftUrl = draftRef ? ownedMediaUrl(draftRef) : null;
        const url = staged ? draftUrl : savedUrl;
        const shown = !!(url && !failed[url]);
        const previewUnavailable = staged && !clearedInDraft && !shown;
        // Only an owned URL that was actually requested can be a failed load; a URL the
        // policy refused was never requested, so it must not be described as one.
        const draftLoadFailed = staged && !clearedInDraft && !!url && !!failed[url];
        const draftState = !staged ? null : clearedInDraft ? 'cleared' : previewUnavailable ? 'preview-unavailable' : 'previewed';
        const filename = staged ? draftRef?.filename ?? null : frame.asset?.filename ?? null;
        const kind = staged ? 'draft' : frame.kind;
        return <figure key={key} className="fl-frame" aria-label={copy.label}>
          <figcaption className="fl-frame__cap"><span className="fl-eyebrow">{copy.label} · {copy.verb}</span><span className="fl-chip" data-kind={kind}>{staged ? 'Unsaved draft' : frame.label}</span></figcaption>
          <div className="fl-gate" data-kind={kind} data-draft={draftState ?? undefined} data-media={shown || undefined}>
            {shown && <img key={url} src={url} alt={`${copy.label}: ${filename}`} onError={() => setFailed(previous => ({ ...previous, [url!]: true }))} />}
            {!shown && <div className="fl-gate__msg">{clearedInDraft
              ? <><b>Removed in your draft.</b><span>Not saved yet. Save changes to remove this frame from the shot.</span></>
              : staged
              ? draftLoadFailed
                ? <><b>Preview unavailable.</b><span>Your draft still points to <span className="fl-mono">{filename ?? draftRef?.assetId}</span>. Its media could not be loaded here, so the frame is still part of your draft and nothing was removed.</span></>
                : <><b>Preview unavailable.</b><span>Your draft still points to <span className="fl-mono">{filename ?? draftRef?.assetId}</span>, but this build only shows owned project media, so no image is shown here. The frame is still part of your draft and nothing was removed.</span></>
              : frame.kind === 'missing' ? <><b>File not found</b><span>This shot still points to <span className="fl-mono">{shot.bindings[key]}</span>. Choose a replacement or clear it in the shot editor.</span></>
              : frame.asset ? <><b>This preview could not load.</b><span>Refresh the project to check the owned media. Your shot settings are unchanged.</span></>
              : <><b>{copy.empty}</b><span>{copy.hint}</span></>}</div>}
            {!staged && frame.kind === 'unsupported' && shown && <span className="fl-gate__kept">Kept on the shot. This model doesn’t take {key === 'firstFrameAssetId' ? 'a start' : 'an end'} frame, so review stays blocked until you clear it or change the model.</span>}
            <i className="fl-cn fl-cn--tl" aria-hidden="true" /><i className="fl-cn fl-cn--tr" aria-hidden="true" /><i className="fl-cn fl-cn--bl" aria-hidden="true" /><i className="fl-cn fl-cn--br" aria-hidden="true" />
          </div>
          <div className="fl-frame__file"><span>{filename ?? (frame.kind === 'missing' && !staged ? 'Unavailable image' : 'No frame bound')}</span><span>{!staged && frame.asset ? `${frame.asset.width} × ${frame.asset.height}` : ''}</span></div>
          {staged && <div className="fl-frame__draft"><span className="fl-frame__draft-note" id={`${noteId}-${key}`}>{clearedInDraft ? 'Draft removal — not saved yet.' : 'Draft only — not saved yet.'}</span>{onSaveDraft && <button type="button" className="fl-btn fl-btn--ghost fl-btn--sm" aria-describedby={`${noteId}-${key}`} onClick={onSaveDraft}>Save shot changes</button>}</div>}
        </figure>;
      })}
      <div className="fl-pair__conn" aria-hidden="true"><svg viewBox="0 0 40 12" width="40" height="12" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M1 6h36M32 1.5 37 6l-5 4.5" /></svg><span className="fl-mono">{shot.controls.durationSeconds} s</span></div>
    </div>
    <p className="fl-script" data-empty={!shot.prompt.trim() || undefined}><span className="fl-eyebrow">Saved direction</span>{shot.prompt.trim() ? shot.prompt : 'No direction yet. Write it in the shot editor; it is sent exactly as written.'}</p>
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
