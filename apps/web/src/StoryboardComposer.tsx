/**
 * StoryboardComposer — review and edit a planner's proposed shot list, then explicitly create the
 * shots it describes.
 *
 * Boundaries the UI must make obvious:
 *  - proposing and reviewing create nothing; the only write is "create N shots", which creates
 *    shot records through the server's command port;
 *  - no image or video generation and no spend approval exists on this surface, and no control
 *    here can imply it — a storyboard is never authorization to spend;
 *  - an accepted proposal is read-only. Interrupted application is resumed with the same server
 *    command IDs, so the component never offers a second "create" for the same cut list.
 *
 * All I/O goes through the props callbacks: the coordinator wires them to
 * `apps/server/src/storyboard-proposals.ts` over HTTP.
 */
import { useState } from 'react';
import type { ComposerBounds, ComposerItem, ComposerItemInput, ComposerProposal, ComposerStatus } from './storyboard-types.ts';

/**
 * The composer contracts are declared in `storyboard-types.ts`, a plain `.ts` module, so a
 * type-only import of this surface (the authoring API, the workspace controller and the
 * server's cross-surface contract test) never needs a JSX-enabled project. Re-exported here
 * so this component's public import path is unchanged.
 */
export type {
  ComposerBounds, ComposerItem, ComposerItemInput, ComposerItemState, ComposerProposal, ComposerStatus,
} from './storyboard-types.ts';

/** Mirrors the server's editorial bounds so the operator sees a blocked edit before any request. */
export const DEFAULT_COMPOSER_BOUNDS: ComposerBounds = Object.freeze({ minSeconds: 1, maxSeconds: 60, maxShots: 12, maxTotalSeconds: 600 });

export interface StoryboardComposerProps {
  projectId: string;
  proposal: ComposerProposal | null;
  bounds?: ComposerBounds;
  busy?: boolean;
  error?: string | null;
  /** Ask the injected planner for a structured shot list. Creates nothing. */
  onPropose(brief: string): Promise<void>;
  onRevise(items: ComposerItemInput[], expectedRevision: number): Promise<void>;
  /** Explicit operator acceptance: creates shot records only. */
  onAccept(expectedRevision: number): Promise<void>;
  onCancel(): Promise<void>;
  onResume(retryFailed?: boolean): Promise<void>;
}

const toInput = (item: ComposerItem): ComposerItemInput => ({
  itemId: item.itemId, title: item.title, direction: item.direction, startDescription: item.startDescription,
  endDescription: item.endDescription, durationSeconds: item.durationSeconds, continuityNotes: item.continuityNotes,
});
const sameItems = (left: ComposerItemInput[], right: ComposerItemInput[]) => JSON.stringify(left) === JSON.stringify(right);

/** Field-level blockers, in the operator's language, with the cut ordinal they refer to. */
export function composerBlockers(items: ComposerItemInput[], bounds: ComposerBounds): string[] {
  const blockers: string[] = [];
  if (items.length === 0) blockers.push('A proposal needs at least one cut.');
  if (items.length > bounds.maxShots) blockers.push(`A proposal is limited to ${bounds.maxShots} cuts.`);
  items.forEach((item, index) => {
    const cut = `Cut ${index + 1}`;
    if (!item.title.trim()) blockers.push(`${cut} needs a title.`);
    if (!item.direction.trim()) blockers.push(`${cut} needs direction.`);
    if (!item.startDescription.trim()) blockers.push(`${cut} needs a start description.`);
    if (!item.endDescription.trim()) blockers.push(`${cut} needs an end description.`);
    if (!Number.isInteger(item.durationSeconds) || item.durationSeconds < bounds.minSeconds || item.durationSeconds > bounds.maxSeconds) {
      blockers.push(`${cut} must be between ${bounds.minSeconds} and ${bounds.maxSeconds} seconds.`);
    }
  });
  const total = items.reduce((sum, item) => sum + (Number.isFinite(item.durationSeconds) ? item.durationSeconds : 0), 0);
  if (total > bounds.maxTotalSeconds) blockers.push(`A proposal is limited to ${bounds.maxTotalSeconds} seconds.`);
  return blockers;
}

const STATUS_COPY: Record<ComposerStatus, string> = {
  draft: 'Draft — nothing exists yet',
  applying: 'Creating shots…',
  applied: 'All shots created',
  partial: 'Partly created — some cuts were refused',
  unknown: 'Creation outcome unknown — resume to reconcile',
  cancelled: 'Cancelled — no further shots will be created',
};

export function StoryboardComposer({ proposal, bounds = DEFAULT_COMPOSER_BOUNDS, busy = false, error = null, onPropose, onRevise, onAccept, onCancel, onResume }: StoryboardComposerProps) {
  const [brief, setBrief] = useState('');
  const [edit, setEdit] = useState<{ id: string; revision: number; items: ComposerItemInput[] } | null>(null);
  const [saved, setSaved] = useState<{ id: string; revision: number; items: ComposerItemInput[] } | null>(null);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (!proposal) {
    return (
      <section className="storyboard-composer" aria-label="Storyboard proposal">
        <h2>Storyboard</h2>
        <p className="sb-lede">Describe the sequence. A planner proposes cuts you can edit; nothing is generated and no shot exists until you create them.</p>
        <label className="sb-field">
          <span>Brief</span>
          <textarea aria-label="Storyboard brief" rows={4} value={brief} maxLength={20_000} disabled={busy || working}
            onChange={event => setBrief(event.target.value)} />
        </label>
        {error ? <p className="sb-error" role="alert">{error}</p> : null}
        <div className="sb-actions">
          <button type="button" className="sb-primary" disabled={busy || working || brief.trim().length === 0}
            onClick={async () => { setWorking(true); setFailure(null); try { await onPropose(brief.trim()); } catch (thrown) { setFailure(thrown instanceof Error ? thrown.message : 'The planner request failed.'); } finally { setWorking(false); } }}>
            {working ? 'Drafting…' : 'Draft shot list'}
          </button>
          <span className="sb-hint">Proposing creates nothing.</span>
        </div>
        {failure ? <p className="sb-error" role="alert">{failure}</p> : null}
      </section>
    );
  }

  const source = proposal.items.map(toInput);
  const caughtUp = saved !== null && saved.id === proposal.id && saved.revision === proposal.revision + 1;
  const baseline = caughtUp ? saved!.items : source;
  const active = edit !== null && edit.id === proposal.id && edit.revision === proposal.revision;
  const items = active ? edit!.items : source;
  const editable = proposal.status === 'draft';
  const dirty = editable && !sameItems(items, baseline);
  const expectedRevision = caughtUp ? saved!.revision : proposal.revision;
  const blockers = composerBlockers(items, bounds);
  const created = proposal.items.filter(item => item.state === 'created');
  const total = items.reduce((sum, item) => sum + item.durationSeconds, 0);
  const disabled = busy || working;

  function patch(itemId: string, change: Partial<ComposerItemInput>) {
    setEdit({ id: proposal!.id, revision: proposal!.revision, items: items.map(item => item.itemId === itemId ? { ...item, ...change } : item) });
    setFailure(null);
  }

  async function run(action: () => Promise<void>) {
    setWorking(true); setFailure(null);
    try { await action(); } catch (thrown) { setFailure(thrown instanceof Error ? thrown.message : 'The storyboard request failed.'); }
    finally { setWorking(false); }
  }

  return (
    <section className="storyboard-composer" aria-label="Storyboard proposal">
      <header className="sb-head">
        <h2>Storyboard</h2>
        <p className="sb-status" data-status={proposal.status}>{STATUS_COPY[proposal.status]}</p>
        <p className="sb-meta">{items.length} cuts · {total}s total · reviewed revision {proposal.revision}</p>
      </header>

      {error ? <p className="sb-error" role="alert">{error}</p> : null}
      {failure ? <p className="sb-error" role="alert">{failure}</p> : null}
      {proposal.failure ? <p className="sb-error" role="alert">{proposal.failure.message}</p> : null}

      <ol className="sb-cuts">
        {items.map((item, index) => (
          <li key={item.itemId}>
            {editable ? (
              <fieldset className="sb-cut">
                <legend>Cut {index + 1}</legend>
                <label className="sb-field"><span>Title</span>
                  <input aria-label={`Title cut ${index + 1}`} value={item.title} maxLength={200} disabled={disabled} onChange={event => patch(item.itemId, { title: event.target.value })} />
                </label>
                <label className="sb-field"><span>Direction</span>
                  <textarea aria-label={`Direction cut ${index + 1}`} rows={2} value={item.direction} maxLength={2_000} disabled={disabled} onChange={event => patch(item.itemId, { direction: event.target.value })} />
                </label>
                <label className="sb-field"><span>Start</span>
                  <textarea aria-label={`Start description cut ${index + 1}`} rows={2} value={item.startDescription} maxLength={2_000} disabled={disabled} onChange={event => patch(item.itemId, { startDescription: event.target.value })} />
                </label>
                <label className="sb-field"><span>End</span>
                  <textarea aria-label={`End description cut ${index + 1}`} rows={2} value={item.endDescription} maxLength={2_000} disabled={disabled} onChange={event => patch(item.itemId, { endDescription: event.target.value })} />
                </label>
                <label className="sb-field sb-duration"><span>Seconds</span>
                  <input aria-label={`Duration seconds cut ${index + 1}`} type="number" inputMode="numeric" min={bounds.minSeconds} max={bounds.maxSeconds} step={1}
                    value={Number.isFinite(item.durationSeconds) ? item.durationSeconds : 0} disabled={disabled}
                    onChange={event => patch(item.itemId, { durationSeconds: Number(event.target.value) })} />
                </label>
                <label className="sb-field"><span>Continuity notes</span>
                  <textarea aria-label={`Continuity notes cut ${index + 1}`} rows={2} value={item.continuityNotes} maxLength={2_000} disabled={disabled} onChange={event => patch(item.itemId, { continuityNotes: event.target.value })} />
                </label>
              </fieldset>
            ) : (
              <article className="sb-cut sb-cut--readonly" data-state={proposal.items[index].state}>
                <h3>Cut {index + 1} · {item.title}</h3>
                <p>{item.direction}</p>
                <p className="sb-meta">{item.startDescription} → {item.endDescription} · {item.durationSeconds}s</p>
                {item.continuityNotes ? <p className="sb-meta">Continuity: {item.continuityNotes}</p> : null}
                {proposal.items[index].state === 'failed' ? <p className="sb-error">Refused — no shot was created for this cut.</p> : null}
                {proposal.items[index].state === 'unknown' ? <p className="sb-error">Outcome unknown — resume re-issues the same command.</p> : null}
              </article>
            )}
          </li>
        ))}
      </ol>

      {created.length > 0 ? (
        <section className="sb-created" aria-label="Created shots">
          <h3>{created.length} of {proposal.items.length} shots created</h3>
          <ul>{created.map(item => <li key={item.itemId}>{item.title} — shot <code>{item.shotId}</code></li>)}</ul>
          <p className="sb-hint">These shot IDs are ready to be placed on the storyboard timeline.</p>
        </section>
      ) : null}

      {blockers.length > 0 ? (
        <ul className="sb-blockers" role="alert">{blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul>
      ) : null}

      {editable ? (
        <div className="sb-actions">
          <button type="button" disabled={disabled || !dirty || blockers.length > 0}
            onClick={() => run(async () => { await onRevise(items, expectedRevision); setSaved({ id: proposal.id, revision: expectedRevision + 1, items }); })}>
            Save edits
          </button>
          <button type="button" className="sb-primary" disabled={disabled || dirty || blockers.length > 0}
            title={dirty ? 'Save your edits before creating shots.' : undefined}
            onClick={() => run(async () => { await onAccept(expectedRevision); })}>
            Create {items.length} shots
          </button>
          <button type="button" className="sb-quiet" disabled={disabled} onClick={() => run(async () => { await onCancel(); })}>Cancel proposal</button>
          <span className="sb-hint">Accepting creates shot records only. No image or video is generated and no spend is approved.</span>
          {dirty ? <span className="sb-hint">Save your edits before creating shots.</span> : null}
        </div>
      ) : null}

      {proposal.status === 'partial' || proposal.status === 'unknown' || proposal.status === 'applying' ? (
        <div className="sb-actions">
          <button type="button" className="sb-primary" disabled={disabled || proposal.status === 'applying'}
            onClick={() => run(async () => { await onResume(false); })}>Resume applying shots</button>
          {proposal.items.some(item => item.state === 'failed') ? (
            <button type="button" disabled={disabled} onClick={() => run(async () => { await onResume(true); })}>Retry refused cuts</button>
          ) : null}
          <button type="button" className="sb-quiet" disabled={disabled} onClick={() => run(async () => { await onCancel(); })}>Cancel proposal</button>
          <span className="sb-hint">Resuming re-issues the same command IDs, so shots that already exist are not created twice.</span>
        </div>
      ) : null}

      {proposal.status === 'cancelled' || proposal.status === 'applied' ? (
        <p className="sb-hint">
          {proposal.status === 'applied' ? 'Nothing further to do. Editing this list means proposing a new one.' : 'No shots will be created from this proposal.'}
        </p>
      ) : null}
    </section>
  );
}

export default StoryboardComposer;
