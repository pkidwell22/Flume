import React, { useRef, useState } from 'react';
import type {
  ContinuationRecovery, ContinueShotOutcome, ContinueShotPort, ContinueShotProps, ContinueShotPublicView,
  ContinueShotRequest, ContinueShotTake,
} from './continue-shot-types.ts';

/**
 * Continue from this take — explicit operator control.
 *
 * Contract: the coordinator supplies ONLY project-owned takes (already scoped by `service.getWorkspace`)
 * and a port that drives `createContinueShot` on the server. Nothing here generates, submits, spends,
 * selects a take or binds a frame on its own: the operator selects a take and presses the button.
 *
 * Recovery: a reopened project restores the continuation identity from browser storage and the
 * AUTHORITATIVE state from an authorized server read. The server view never carries the prompt,
 * title, command payloads or lease material, and a resume replays the frozen intent server-side, so
 * this component only ever sends identity.
 *
 * The contracts are declared in `continue-shot-types.ts`, a plain `.ts` module, so a type-only import
 * of this surface (the authoring API, the workspace controller and the server's cross-surface contract
 * test) never needs a JSX-enabled project. They are re-exported here so this component's public import
 * path is unchanged.
 */
export type {
  ContinuationRecovery, ContinueShotOutcome, ContinueShotPort, ContinueShotProps, ContinueShotPublicView,
  ContinueShotRequest, ContinueShotTake,
} from './continue-shot-types.ts';

const RECOVERY_TITLES: Record<ContinueShotPublicView['status'], string> = {
  completed: 'Completed continuation',
  partial: 'Partial continuation',
  blocked: 'Blocked continuation',
  in_progress: 'Continuation in progress',
  unknown: 'Continuation state unknown',
};

function defaultOperationId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  throw new Error('A UUID source is required to continue a take.');
}

type Phase = 'idle' | 'pending' | 'error' | 'partial' | 'success';

export function ContinueShot({ port, projectId, takes, sourceShot, disabled = false, blockedReason = null, onCompleted, recovery = null, onRetryRecovery, onResumeOperation, newOperationId = defaultOperationId }: ContinueShotProps) {
  const [takeId, setTakeId] = useState('');
  const [title, setTitle] = useState(sourceShot?.title ?? '');
  const [prompt, setPrompt] = useState(sourceShot?.prompt ?? '');
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ContinueShotOutcome | null>(null);
  const [retryable, setRetryable] = useState(false);
  const operationId = useRef<string | null>(null);
  // Synchronous guard: two clicks in one render turn must dispatch at most once.
  const dispatching = useRef(false);

  const busy = phase === 'pending';
  // A partial or failed attempt is continued through its explicit Resume/Retry control, never a fresh press.
  const recoverable = phase === 'partial' || phase === 'error';
  const ready = !busy && !recoverable && !disabled && takeId !== '' && prompt.trim().length > 0;
  const saved = recovery?.view ?? null;

  function edited() {
    // Changing the inputs means a different intention: the next press starts a new durable operation.
    operationId.current = null;
    setPhase('idle');
    setMessage(null);
    setOutcome(null);
  }

  async function settle(result: ContinueShotOutcome): Promise<void> {
    setOutcome(result);
    if (result.status === 'completed') {
      operationId.current = null; // the next explicit press starts a new operation
      setPhase('success');
      setMessage(null);
      try { await onCompleted?.(result); } catch { /* the saved outcome stays authoritative in the result region */ }
      return;
    }
    setRetryable(result.resumable);
    setMessage(result.message ?? (result.status === 'partial' ? 'The continuation is partly applied.' : 'The continuation could not finish.'));
    setPhase(result.status === 'partial' ? 'partial' : 'error');
  }

  async function run() {
    if (dispatching.current) return;
    // One intention, one operation id: a retry or resume must reuse it so the server journal dedupes.
    const current = operationId.current ?? newOperationId();
    operationId.current = current;
    dispatching.current = true;
    setPhase('pending');
    setMessage(null);
    try {
      const result = await port.continueShot({ operationId: current, projectId, sourceTakeId: takeId, title, prompt });
      await settle(result);
    } catch (error) {
      setRetryable(true); // the operation id is durable, so an unexpected transport failure can be retried safely
      setMessage(error instanceof Error && error.message ? error.message : 'The take could not be continued.');
      setPhase('error');
    } finally {
      dispatching.current = false;
    }
  }

  async function resumeSaved() {
    if (!saved || !saved.resumable || saved.active || disabled || busy || dispatching.current || !onResumeOperation) return;
    dispatching.current = true;
    setPhase('pending');
    setMessage(null);
    try {
      const result = await onResumeOperation(saved.operationId);
      if (result.projectId !== projectId) throw new Error('The resumed continuation belongs to another project.');
      await settle(result);
    } catch (error) {
      // The saved view remains visible; a resume refusal is not retried automatically.
      setRetryable(false);
      setMessage(error instanceof Error && error.message ? error.message : 'The saved continuation could not be resumed.');
      setPhase('error');
    } finally {
      dispatching.current = false;
    }
  }

  const hint = blockedReason ?? (!takeId ? 'Select one project-owned take to continue.' : !prompt.trim() ? 'Enter a prompt for the next shot.' : disabled ? 'Continuing is unavailable right now.' : null);

  return (
    <section className="continue-shot" aria-labelledby="continue-shot-heading">
      <h2 id="continue-shot-heading">Continue from this take</h2>
      <p className="continue-shot__intro">
        Creates the next shot with the last frame of one project-owned take as its first frame. No generation is
        submitted, the source shot is unchanged, and the new shot&rsquo;s last frame stays empty.
      </p>

      {recovery?.phase === 'loading' && <p className="continue-shot__status" role="status">Reading the saved continuation from the server…</p>}

      {saved && (
        <div className="continue-shot__recovery" role="status" aria-label="Saved continuation">
          <p><strong>{RECOVERY_TITLES[saved.status]}</strong></p>
          {saved.message && <p>{saved.message}</p>}
          <ul className="continue-shot__lineage">
            <li>Source shot: {saved.sourceShotId}</li>
            <li>Source take: {saved.sourceTakeId}</li>
            <li>Source video: {saved.sourceAssetId}</li>
            <li>Extracted last frame: {saved.extractedAssetId ?? 'not extracted'}</li>
            <li>Next shot: {saved.shotId ?? 'not created yet'}{saved.shotRevision !== null ? ` (revision ${saved.shotRevision})` : ''}</li>
          </ul>
          {saved.blockers.length > 0 && <p>Recorded blockers: {saved.blockers.join(', ')}</p>}
          {saved.active && <p>Another request is already continuing this operation. Nothing is resumed from here.</p>}
          {saved.status === 'unknown' && <p>This operation will not be resumed automatically. Inspect the project media before starting a new operation.</p>}
          {saved.resumable && !saved.active && !busy && onResumeOperation && (
            <button type="button" onClick={resumeSaved} disabled={disabled}>Resume saved continuation</button>
          )}
          {!saved.resumable && !saved.active && saved.status !== 'unknown' && saved.status !== 'completed' && (
            <p>This state has no safe resume; check the project before starting a new operation.</p>
          )}
          <p className="continue-shot__hint">Recovered from the server journal. Reading it extracted, created and generated nothing.</p>
        </div>
      )}

      {recovery?.phase === 'error' && (
        <div className="continue-shot__recovery-error" role="alert">
          <p>{recovery.message ?? 'The saved continuation could not be read.'}</p>
          {onRetryRecovery && <button type="button" onClick={() => void onRetryRecovery()} disabled={busy || disabled}>Check saved continuation</button>}
          <p className="continue-shot__hint">Checking reads the saved operation again. It does not create, resume or generate anything.</p>
        </div>
      )}

      <div className="continue-shot__field">
        <label htmlFor="continue-shot-take">Source take</label>
        <select
          id="continue-shot-take"
          aria-label="Source take"
          value={takeId}
          disabled={busy || disabled}
          onChange={event => { setTakeId(event.target.value); edited(); }}
        >
          <option value="">Select a take…</option>
          {takes.map(take => <option key={take.id} value={take.id}>{take.label}</option>)}
        </select>
      </div>
      {takes.length === 0 && <p className="continue-shot__empty" role="note">No project-owned takes are available yet. A completed take is required before a shot can be continued.</p>}

      <div className="continue-shot__field">
        <label htmlFor="continue-shot-title">Next shot title</label>
        <input id="continue-shot-title" aria-label="Next shot title" value={title} maxLength={500} disabled={busy || disabled} onChange={event => { setTitle(event.target.value); edited(); }} />
      </div>
      <div className="continue-shot__field">
        <label htmlFor="continue-shot-prompt">Next shot prompt</label>
        <textarea id="continue-shot-prompt" aria-label="Next shot prompt" rows={3} value={prompt} maxLength={100000} disabled={busy || disabled} onChange={event => { setPrompt(event.target.value); edited(); }} />
      </div>

      <button type="button" onClick={run} disabled={!ready}>Continue from this take</button>
      {hint && <p className="continue-shot__hint">{hint}</p>}

      {busy && <p className="continue-shot__status" role="status">Extracting the last frame and creating the next shot…</p>}

      {phase === 'partial' && outcome && (
        <div className="continue-shot__partial" role="status">
          <p><strong>Partial continuation</strong> — nothing was undone.</p>
          {message && <p>{message}</p>}
          <ul>
            <li>Last frame extracted: {outcome.extractedAssetId ?? 'not extracted'}</li>
            <li>Next shot: {outcome.shotId ?? 'not created yet'}</li>
            <li>Source take: {outcome.sourceTakeId}</li>
          </ul>
          <button type="button" onClick={run}>Resume continue</button>
        </div>
      )}

      {phase === 'error' && (
        <div className="continue-shot__error" role="alert">
          <p>{message}</p>
          {retryable
            ? <button type="button" onClick={run}>Retry continue</button>
            : <p>Operator action is required before this take can be continued.</p>}
        </div>
      )}

      {phase === 'success' && outcome && (
        <div className="continue-shot__success" role="status">
          <p>
            Continued from take {outcome.sourceTakeId}: shot {outcome.shotId} (revision {outcome.shotRevision}) now uses
            frame {outcome.firstFrameAssetId} as its first frame. Its last frame is empty.
          </p>
          <ul className="continue-shot__lineage">
            <li>Source shot: {outcome.lineage.sourceShotId}</li>
            <li>Source take: {outcome.lineage.sourceTakeId}</li>
            <li>Source video: {outcome.lineage.sourceAssetId}</li>
            <li>Extracted last frame: {outcome.lineage.extractedAssetId}</li>
            <li>Shot create command: {outcome.commandIds.shotCreate}</li>
            <li>First frame bind command: {outcome.commandIds.shotBind}</li>
          </ul>
        </div>
      )}
    </section>
  );
}
