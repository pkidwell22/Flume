import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { WorkspaceComponents } from './ports.ts';
import type { Asset, Project, Shot, Workspace } from './types.ts';
import { originLabel, ownedMediaUrl, restoreOpener } from './shell.ts';
import { needsWatching, shotNumber } from './shot-status.ts';

export type DrawerKind = 'projects' | 'library' | 'activity' | 'export';

/** Non-modal: the slate and reel stay usable. Opening focuses the title; Esc or Close returns focus. */
export function Drawer({ id, title, meta, onClose, children }: { id: string; title: string; meta?: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const panel = ref.current;
    const opener = document.activeElement;
    titleRef.current?.focus({ preventScroll: true });
    return () => { if (panel) restoreOpener(opener, panel); };
  }, []);
  function key(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault(); onClose();
  }
  return <section ref={ref} id={id} className="fl-drawer" role="dialog" aria-modal="false" aria-labelledby={`${id}-title`} onKeyDown={key}>
    <header className="fl-drawer__head">
      <h2 ref={titleRef} id={`${id}-title`} className="fl-drawer__title" tabIndex={-1}>{title}</h2>
      {meta && <span className="fl-mono fl-dim">{meta}</span>}
      <button type="button" className="fl-drawer__close" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
      </button>
    </header>
    <div className="fl-drawer__body">{children}</div>
  </section>;
}

export function ProjectsDrawer({ projects, activeProjectId, dataState, disabled, onOpen, onCreate }: { projects: readonly Project[]; activeProjectId: string | null; dataState: 'ready' | 'loading' | 'error'; disabled: boolean; onOpen(id: string): void; onCreate(): void }) {
  return <>
    <ul className="fl-drawer__list">
      {projects.map((project, index) => <li key={project.id}>
        <button type="button" className="fl-drawer__project" title={project.name} aria-current={project.id === activeProjectId ? 'true' : undefined} aria-disabled={disabled || undefined}
          aria-label={`Open project: ${project.name}${projects.some(other => other.id !== project.id && other.name === project.name) ? ` (project ${index + 1} of ${projects.length})` : ''}`}
          onClick={() => { if (!disabled) onOpen(project.id); }}>
          <span className="fl-drawer__monogram" aria-hidden="true">{Array.from(project.name.trim())[0] ?? '—'}</span>
          <span className="fl-drawer__project-copy"><strong>{project.name}</strong>{project.brief && <span>{project.brief}</span>}</span>
        </button>
      </li>)}
    </ul>
    {dataState !== 'ready' ? <p className="fl-hint" role="status">{dataState === 'loading' ? 'Loading projects…' : 'Projects unavailable. Check saved state.'}</p>
      : !projects.length && <p className="fl-hint">No projects yet.</p>}
    <button type="button" className="fl-btn fl-btn--ghost" aria-disabled={disabled || undefined} onClick={() => { if (!disabled) onCreate(); }}>New project</button>
  </>;
}

export function LibraryDrawer({ workspace, shots, held, onImport }: { workspace: Workspace; shots: readonly Shot[]; held: boolean; onImport(file: File): void }) {
  const searchId = useId();
  const upload = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [origin, setOrigin] = useState<'all' | Asset['origin']>('all');
  const [inspected, setInspected] = useState<string | null>(null);
  const assets = workspace.assets.filter(asset => asset.projectId === workspace.project?.id);
  const visible = assets.filter(asset => (origin === 'all' || asset.origin === origin) && asset.filename.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const current = assets.find(asset => asset.id === inspected);
  const sameName = (asset: Asset) => assets.filter(other => other.id !== asset.id && other.filename === asset.filename).length;
  const usage = (asset: Asset) => shots.flatMap((shot, index) => [
    ...(shot.bindings.firstFrameAssetId === asset.id ? [`Shot ${shotNumber(index)} · start frame`] : []),
    ...(shot.bindings.lastFrameAssetId === asset.id ? [`Shot ${shotNumber(index)} · end frame`] : []),
  ]);
  const origins = (['all', 'imported', 'generated', 'sample'] as const).filter(item => item === 'all' || assets.some(asset => asset.origin === item));
  return <>
    <p className="fl-hint">Looking at an image never changes a shot. To use one, choose it as the start or end frame in the slate.</p>
    <div className="fl-drawer__row">
      <button type="button" className="fl-btn fl-btn--ghost fl-btn--sm" disabled={held} onClick={() => upload.current?.click()}>Import image</button>
      <input ref={upload} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => { const file = event.target.files?.[0]; if (file) onImport(file); event.currentTarget.value = ''; }} />
      <span className="fl-mono fl-dim">PNG, JPEG or WebP you own</span>
    </div>
    <div><label className="fl-vh" htmlFor={searchId}>Search project media</label><input id={searchId} className="fl-drawer__search" type="search" value={query} placeholder="Search by file name" onChange={event => setQuery(event.target.value)} /></div>
    {origins.length > 2 && <div className="fl-chips" role="group" aria-label="Filter by origin">
      {origins.map(item => <button key={item} type="button" className="fl-chipbtn" aria-pressed={origin === item} onClick={() => setOrigin(item)}>{item === 'all' ? 'All' : originLabel({ origin: item } as Asset).replace(' media', '')}</button>)}
    </div>}
    {current && <LibraryInspector asset={current} sameName={sameName(current)} usage={usage(current)} />}
    {visible.length ? <ul className="fl-libgrid">{visible.map(asset => {
      const url = ownedMediaUrl(asset); const used = usage(asset).length; const dup = sameName(asset) > 0;
      return <li key={asset.id}><button type="button" className="fl-libtile" aria-pressed={asset.id === inspected} onClick={() => setInspected(asset.id === inspected ? null : asset.id)} aria-label={`Inspect ${asset.filename}${dup ? ', same name as another file' : ''}${used ? `, used in ${used} ${used === 1 ? 'place' : 'places'}` : ''}`}>
        <span className="fl-libtile__img">{url && asset.kind === 'image' ? <img src={url} alt="" loading="lazy" /> : <span className="fl-libtile__na">{asset.kind === 'video' ? 'Video' : 'No preview'}</span>}
          {used > 0 && <span className="fl-libtile__tag">In use</span>}{dup && <span className="fl-libtile__tag fl-libtile__tag--dup">Same name</span>}</span>
        <span className="fl-libtile__meta"><span className="fl-libtile__name">{asset.filename}</span><span className="fl-mono fl-dim">{asset.width} × {asset.height}</span></span>
      </button></li>;
    })}</ul> : <p className="fl-drawer__empty">{assets.length ? `No media matches “${query}”. Search looks at file names.` : 'No media yet. Import your first image to begin.'}</p>}
  </>;
}

function LibraryInspector({ asset, sameName, usage }: { asset: Asset; sameName: number; usage: string[] }) {
  const url = ownedMediaUrl(asset);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [asset.id]);
  return <div className="fl-insp" aria-label={`Inspecting ${asset.filename}`} role="group">
    <div className="fl-insp__prev">{url && !failed ? asset.kind === 'image' ? <img src={url} alt={asset.filename} onError={() => setFailed(true)} /> : <video src={url} controls preload="metadata" playsInline onError={() => setFailed(true)} /> : <span className="fl-libtile__na">{url ? 'This preview could not load.' : 'No owned preview for this file.'}</span>}</div>
    <div className="fl-insp__body">
      <p className="fl-insp__name">{asset.filename}</p>
      <dl className="fl-meta">
        <dt>Origin</dt><dd>{originLabel(asset)}</dd>
        <dt>Size</dt><dd>{asset.width} × {asset.height}{asset.durationSeconds !== undefined ? ` · ${asset.durationSeconds} s` : ''}</dd>
        <dt>Used in</dt><dd>{usage.length ? usage.join(', ') : 'Not used by a shot'}</dd>
        {sameName > 0 && <><dt>Same name</dt><dd>{sameName} other {sameName === 1 ? 'file has' : 'files have'} this name. Check the ID before choosing.</dd></>}
        <dt>ID</dt><dd>{asset.id}</dd>
        <dt>SHA-256</dt><dd>{asset.sha256}</dd>
      </dl>
    </div>
  </div>;
}

export function ActivityDrawer({ workspace, shots, held, ActivityPanel, onResume, onOpenShot }: { workspace: Workspace; shots: readonly Shot[]; held: boolean; ActivityPanel: WorkspaceComponents['ActivityPanel']; onResume(id: string): Promise<void>; onOpenShot(id: string): void }) {
  const groups = shots.map((shot, index) => ({ shot, index, attempts: workspace.attempts.filter(item => item.shotId === shot.id && item.projectId === shot.projectId) })).filter(group => group.attempts.length);
  if (!groups.length) return <ActivityPanel attempts={[]} busy={held} onResume={onResume} />;
  return <>{groups.map(({ shot, index, attempts }) => <section key={shot.id} className="fl-drawer__group" aria-label={`Shot ${shotNumber(index)} activity`}>
    <div className="fl-drawer__group-head"><h3>Shot {shotNumber(index)} · {shot.title}</h3>{attempts.some(needsWatching) && <span className="fl-mono fl-dim">{attempts.filter(needsWatching).length} to watch</span>}
      <button type="button" className="fl-link" aria-disabled={held || undefined} onClick={() => { if (!held) onOpenShot(shot.id); }}>Open shot {shotNumber(index)}</button></div>
    <ActivityPanel attempts={attempts} busy={held} onResume={onResume} />
  </section>)}</>;
}

export function ExportDrawer({ workspace, shots, held, onOpenTakes }: { workspace: Workspace; shots: readonly Shot[]; held: boolean; onOpenTakes(id: string): void }) {
  const gaps = shots.filter(shot => !shot.selectedTakeId).length;
  return <>
    <p className="fl-hint">An export is a frozen copy of one shot’s selected take. Later edits never change it. Exports start from each shot’s Takes view.</p>
    <div className="fl-drawer__unavailable" role="note"><strong>Whole-film export isn’t available in this build.</strong> Flume can’t join shots or mix sound into one file yet.</div>
    {gaps > 0 && <p className="fl-eyebrow">{gaps} of {shots.length} {shots.length === 1 ? 'shot has' : 'shots have'} no selected take</p>}
    <ul className="fl-exlist">{shots.map((shot, index) => {
      const exports = workspace.exports.filter(item => item.shotId === shot.id && item.projectId === shot.projectId);
      const current = exports.filter(item => !item.stale && item.takeId === shot.selectedTakeId && item.shotRevision === shot.revision && item.selectionRevision === shot.selectionRevision).at(-1);
      const output = current?.status === 'ready' ? workspace.assets.find(asset => asset.id === current.assetId && asset.projectId === shot.projectId && asset.kind === 'video') : undefined;
      const url = output && ownedMediaUrl(output);
      const state = !shot.selectedTakeId ? { tone: 'warn', text: 'No selected take' } : !current ? { tone: 'dim', text: exports.length ? 'Earlier exports are out of date' : 'Not exported' } : { tone: current.status === 'failed' ? 'err' : current.status === 'ready' ? 'ok' : 'run', text: { queued: 'Export queued', running: 'Exporting', ready: url ? 'Frozen copy ready' : 'File unavailable', failed: 'Export failed' }[current.status] };
      return <li key={shot.id}>
        <span className="fl-exlist__shot"><span className="fl-mono">{shotNumber(index)}</span> {shot.title}</span>
        <span className={`fl-mono fl-tone--${state.tone}`}>{state.text}</span>
        <span className="fl-exlist__actions">{url && <a className="fl-link" href={url} download={output?.filename || true}>Download</a>}
          <button type="button" className="fl-link" aria-disabled={held || undefined} onClick={() => { if (!held) onOpenTakes(shot.id); }}>Open takes</button></span>
      </li>;
    })}</ul>
  </>;
}
