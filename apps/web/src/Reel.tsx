import { useEffect, useId, useRef } from 'react';
import type { Project, Shot, Workspace } from './types.ts';
import { ownedMediaUrl } from './shell.ts';
import { frameState, reelStatus, shotNumber, timecode } from './shot-status.ts';

export interface ReelProps {
  project: Project | null;
  /** Supplied workspace shots; foreign-project entries are never rendered. */
  shots: readonly Shot[];
  workspace: Pick<Workspace, 'assets' | 'capabilities' | 'attempts' | 'takes'> | null;
  /** A missing read is not an empty film; counts stay unknown until a read succeeds. */
  dataState: 'ready' | 'loading' | 'error';
  activeShotId: string | null;
  /** Parent's hold policy. aria-disabled keeps the clips focusable and announced. */
  disabled: boolean;
  status: string;
  onShotActivate(shotId: string): void;
  onCreateShot(): void;
}

/** The film's spine: every saved shot in order, sized by its saved duration. Presentation only. */
export function Reel({ project, shots: supplied, workspace, dataState, activeShotId, disabled, status, onShotActivate, onCreateShot }: ReelProps) {
  const headingId = useId();
  const soundId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const shots = project ? supplied.filter(shot => shot.projectId === project.id) : [];
  const ready = dataState === 'ready';
  const total = shots.reduce((sum, shot) => sum + Math.max(0, shot.controls.durationSeconds || 0), 0);
  const columns = [...shots.map(shot => `minmax(var(--fl-clip-min), ${Math.max(1, shot.controls.durationSeconds || 1)}fr)`), 'var(--fl-addshot)'].join(' ');
  const cannotCreate = disabled || !project;
  let elapsed = 0;

  useEffect(() => {
    // Reveal the current clip inside the reel's own scroller; never move the page or focus.
    const box = scroller.current;
    const current = box?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!box || !current || (box.contains(document.activeElement) && document.activeElement !== current)) return;
    const item = current.getBoundingClientRect(); const view = box.getBoundingClientRect();
    if (item.left < view.left) box.scrollLeft += item.left - view.left - 8;
    else if (item.right > view.right) box.scrollLeft += item.right - view.right + 8;
  }, [activeShotId, shots.length]);

  return <section className="fl-reel" aria-labelledby={headingId}>
    <div className="fl-reel__bar">
      <h2 id={headingId} className="fl-eyebrow">Reel</h2>
      <span className="fl-mono" aria-label={ready ? undefined : 'Shot count unavailable'}>{ready ? `${shots.length} ${shots.length === 1 ? 'shot' : 'shots'} · ${timecode(total)}` : '—'}</span>
      <div className="fl-seg" role="group" aria-label="Reel view">
        <button type="button" aria-pressed="true">Shots</button>
        <button type="button" disabled aria-describedby={soundId}>Sound</button>
      </div>
      <span id={soundId} className="fl-reel__unavailable">Sound lanes aren’t available in this build.</span>
      <p className="fl-reel__status" role="status">{status}</p>
    </div>
    <nav className="fl-reel__nav" aria-label="Shots" aria-busy={dataState === 'loading' || undefined}>
      <div className="fl-reel__scroll" ref={scroller}>
        <ol className="fl-reel__track" style={{ gridTemplateColumns: columns }}>
          {shots.map((shot, index) => {
            const start = frameState(shot, 'firstFrameAssetId', workspace ?? { assets: [], capabilities: [] });
            const poster = start.kind !== 'missing' && start.asset ? ownedMediaUrl(start.asset) : undefined;
            const line = workspace ? reelStatus(shot, workspace) : { tone: 'dim' as const, text: '' };
            const duplicate = shots.some(other => other.id !== shot.id && other.title === shot.title);
            const current = shot.id === activeShotId;
            return <li key={shot.id}>
              <button type="button" className="fl-clip" data-empty={!poster || undefined} data-missing={line.text === 'Missing frame' || undefined}
                aria-label={`Open shot: ${shot.title}${duplicate ? ` (shot ${index + 1} of ${shots.length} in ${project?.name})` : ''}`}
                aria-describedby={`${headingId}-clip-${index}`} aria-current={current ? 'page' : undefined} aria-disabled={disabled || undefined}
                title={shot.title} onClick={() => { if (!disabled) onShotActivate(shot.id); }}>
                {poster && <img src={poster} alt="" />}
                <span className="fl-clip__shade" aria-hidden="true" />
                <span className="fl-clip__n" aria-hidden="true">{shotNumber(index)}</span>
                <span className="fl-clip__title" aria-hidden="true">{shot.title}</span>
                <span className={`fl-clip__status fl-tone--${line.tone}`} id={`${headingId}-clip-${index}`}>{line.text}</span>
                {current && <span className="fl-vh">Current shot</span>}
              </button>
            </li>;
          })}
          <li><button type="button" className="fl-reel__add" aria-label="Add shot" title="Add shot" aria-disabled={cannotCreate || undefined} onClick={() => { if (!cannotCreate) onCreateShot(); }}><span aria-hidden="true">+</span><span aria-hidden="true">Shot</span></button></li>
        </ol>
        {ready && shots.length > 0 && <div className="fl-reel__ruler" aria-hidden="true" style={{ gridTemplateColumns: columns }}>
          {shots.map(shot => { const at = elapsed; elapsed += Math.max(0, shot.controls.durationSeconds || 0); return <span key={shot.id}>{timecode(at)}</span>; })}
          <span>{timecode(total)}</span>
        </div>}
      </div>
      {!ready ? <p className="fl-reel__empty" role="status">{dataState === 'loading' ? 'Loading shots…' : 'Shots unavailable. Check saved state.'}</p>
        : !shots.length && <p className="fl-reel__empty">{project ? 'No shots yet. Add a shot to start the reel.' : 'Choose a project to see its shots.'}</p>}
    </nav>
  </section>;
}
