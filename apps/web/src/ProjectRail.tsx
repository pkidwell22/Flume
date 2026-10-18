import { useEffect, useId, useRef } from 'react';
import type { Project, Shot, Take } from './types.ts';

export interface ProjectRailProps {
  projects: readonly Project[];
  /** Supplied workspace shots; foreign-project entries are never rendered. */
  shots: readonly Shot[];
  /** Returned takes are availability only; selectedTakeId remains authoritative. */
  takes?: readonly Take[];
  /** A missing read is not an empty workspace; supplied rows may be cached. */
  dataState?: 'ready' | 'loading' | 'error';
  activeProjectId: string | null;
  activeShotId: string | null;
  collapsed: boolean;
  /** Parent's hold/loading policy. aria-disabled retains keyboard focus. */
  disabled?: boolean;
  onProjectActivate(projectId: string): void;
  onShotActivate(shotId: string): void;
  onCreateProject(): void;
  onCreateShot(): void;
  onCollapsedChange(collapsed: boolean): void;
}

/**
 * Presentation only: import project-rail.css once at the composition boundary.
 * Callbacks request intent; only new props acknowledge navigation or collapse.
 * The parent owns dirty guards, async errors, creation dialogs and commands.
 */
export function ProjectRail({
  projects, shots, takes = [], dataState = 'ready', activeProjectId, activeShotId, collapsed, disabled = false,
  onProjectActivate, onShotActivate, onCreateProject, onCreateShot, onCollapsedChange,
}: ProjectRailProps) {
  const bodyId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const activeProject = projects.find(project => project.id === activeProjectId);
  const visibleShots = activeProject ? shots.filter(shot => shot.projectId === activeProject.id) : [];
  const cannotCreateShot = disabled || !activeProject;
  const collapseLabel = collapsed ? 'Expand project rail' : 'Collapse project rail';

  useEffect(() => {
    const lists = bodyRef.current?.querySelectorAll<HTMLElement>('.fl-project-rail__list');
    if (!lists) return;
    // Scroll only the owned lists, never the page or keyboard focus. ResizeObserver
    // also covers container resizing and the desktop-to-horizontal phone layout.
    const reveal = () => lists.forEach(list => {
      const current = list.querySelector<HTMLElement>('button[aria-current]');
      if (!current || (list.contains(document.activeElement) && document.activeElement !== current)) return;
      const item = current.getBoundingClientRect();
      const box = list.getBoundingClientRect();
      if (item.top < box.top || item.height > box.height) list.scrollTop += item.top - box.top - 4;
      else if (item.bottom > box.bottom) list.scrollTop += item.bottom - box.bottom + 4;
      if (item.left < box.left || item.width > box.width) list.scrollLeft += item.left - box.left - 4;
      else if (item.right > box.right) list.scrollLeft += item.right - box.right + 4;
    });
    reveal();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reveal);
    lists.forEach(list => {
      observer?.observe(list);
      const current = list.querySelector<HTMLElement>('button[aria-current]');
      if (current) observer?.observe(current);
    });
    return () => observer?.disconnect();
  }, [activeProjectId, activeShotId, collapsed, projects.length, visibleShots.length]);

  return <aside className="fl-project-rail" aria-label="Project and shot navigation" data-collapsed={collapsed}>
    <header className="fl-project-rail__header">
      <h2 className="fl-project-rail__heading">Workspace</h2>
      <button type="button" className="fl-project-rail__icon-button fl-project-rail__collapse" aria-label={collapseLabel} title={collapseLabel} aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => onCollapsedChange(!collapsed)}>
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><rect x="2.5" y="3.5" width="15" height="13" rx="1.5" /><path d="M7 4v12" /><path d={collapsed ? 'm10 7 3 3-3 3' : 'm14 7-3 3 3 3'} /></svg>
      </button>
    </header>
    <div className="fl-project-rail__body" id={bodyId} ref={bodyRef}>
      <nav className="fl-project-rail__group" aria-label="Projects" aria-busy={dataState === 'loading' || undefined}>
        <div className="fl-project-rail__group-heading">
          <h3>Projects <span className="fl-project-rail__count" aria-label={dataState !== 'ready' ? 'Project count unavailable' : undefined}>{dataState === 'ready' ? projects.length : '—'}</span></h3>
          <button type="button" className="fl-project-rail__icon-button" aria-label="New project" title="New project" aria-disabled={disabled || undefined} onClick={() => { if (!disabled) onCreateProject(); }}><span aria-hidden="true">+</span></button>
        </div>
        <ul className="fl-project-rail__list fl-project-rail__projects">
          {projects.map((project, index) => <li key={project.id}>
            <button type="button" className="fl-project-rail__item fl-project-rail__project" title={project.name} aria-label={`Open project: ${project.name}${projects.some(other => other.id !== project.id && other.name === project.name) ? ` (project ${index + 1} of ${projects.length})` : ''}`} aria-current={project.id === activeProjectId ? 'true' : undefined} aria-disabled={disabled || undefined} onClick={() => { if (!disabled) onProjectActivate(project.id); }}>
              <span className="fl-project-rail__monogram" aria-hidden="true">{Array.from(project.name.trim())[0] ?? '—'}</span>
              <span className="fl-project-rail__copy"><span className="fl-project-rail__name">{project.name}</span></span>
            </button>
          </li>)}
        </ul>
        {dataState !== 'ready' ? <p className="fl-project-rail__empty" role="status">{dataState === 'loading' ? 'Loading projects…' : 'Projects unavailable. Check saved state.'}</p>
          : !projects.length && <p className="fl-project-rail__empty">No projects yet. Start with New project.</p>}
      </nav>
      <nav className="fl-project-rail__group fl-project-rail__shot-group" aria-label="Shots" aria-busy={dataState === 'loading' || undefined}>
        <div className="fl-project-rail__group-heading">
          <h3>Shots <span className="fl-project-rail__count" aria-label={dataState !== 'ready' ? 'Shot count unavailable' : undefined}>{dataState === 'ready' ? visibleShots.length : '—'}</span></h3>
          <button type="button" className="fl-project-rail__icon-button" aria-label="Add shot" title="Add shot" aria-disabled={cannotCreateShot || undefined} onClick={() => { if (!cannotCreateShot) onCreateShot(); }}><span aria-hidden="true">+</span></button>
        </div>
        {activeProject && <p className="fl-project-rail__context" title={activeProject.name}>{activeProject.name}</p>}
        <ol className="fl-project-rail__list fl-project-rail__shots">
          {visibleShots.map((shot, index) => <li key={shot.id}>
            <button type="button" className="fl-project-rail__item fl-project-rail__shot" title={shot.title} aria-label={`Open shot: ${shot.title}${visibleShots.some(other => other.id !== shot.id && other.title === shot.title) ? ` (shot ${index + 1} of ${visibleShots.length} in ${activeProject?.name})` : ''}`} aria-describedby={`${bodyId}-shot-${index}`} aria-current={shot.id === activeShotId ? 'page' : undefined} aria-disabled={disabled || undefined} onClick={() => { if (!disabled) onShotActivate(shot.id); }}>
              <span className="fl-project-rail__ordinal" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <span className="fl-project-rail__copy">
                <span className="fl-project-rail__name">{shot.title}</span>
                <span className="fl-project-rail__take" id={`${bodyId}-shot-${index}`}>{shot.selectedTakeId ? 'Take selected' : takes.some(take => take.projectId === shot.projectId && take.shotId === shot.id) ? 'Takes to review' : 'No take selected'}</span>
                {shot.id === activeShotId && <span className="fl-project-rail__current">Current shot</span>}
              </span>
            </button>
          </li>)}
        </ol>
        {dataState !== 'ready' ? <p className="fl-project-rail__empty" role="status">{dataState === 'loading' ? 'Loading shots…' : 'Shots unavailable. Check saved state.'}</p>
          : !visibleShots.length && <p className="fl-project-rail__empty">{activeProject ? 'No shots yet. Add a shot to this project.' : 'Choose a project to see its shots.'}</p>}
      </nav>
    </div>
  </aside>;
}
