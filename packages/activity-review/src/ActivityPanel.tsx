import { useId, useRef, useState } from 'react';
import { blockerText } from './presentation.ts';
import type { ActivityPanelProps, Attempt } from './types.ts';

const states: Record<Attempt['status'], { title: string; description: string }> = {
  queued: { title: 'Waiting to start', description: 'This attempt is queued. Its place in the queue is not a progress estimate.' },
  running: { title: 'Confirming submission', description: 'Submission has started, but acceptance is not confirmed yet. There is no reliable completion time.' },
  retrieving: { title: 'Saving your video', description: 'The video is being copied into your project. It is not ready to inspect yet.' },
  ready: { title: 'Check Takes', description: 'This attempt is marked ready, but that status alone does not confirm a playable result here. Open Takes to inspect the saved video. Nothing is selected automatically.' },
  blocked: { title: 'Generation blocked', description: 'This request cannot continue with the current provider or settings. You can keep editing; resolve the block and prepare a new review.' },
  failed: { title: 'Attempt stopped', description: 'This attempt stopped before a usable result was confirmed. A new generation needs a new review and approval; the previous attempt may still have incurred a charge.' },
  acceptance_unknown: { title: 'Waiting for confirmation', description: 'The provider may have accepted this request, but we could not confirm it. This is not a failed generation. Sending it again could create another video and another charge.' },
};

export function ActivityPanel({ attempts, busy = false, onResume }: ActivityPanelProps) {
  const titleId = useId();
  return <section className="fl-activity" aria-labelledby={titleId}>
    <header className="fl-activity__header"><h2 id={titleId}>Activity</h2><p>What is happening with your generations</p></header>
    {attempts.length === 0 && <div className="fl-activity__empty"><h3>No generations yet</h3><p>Choose a shot, set its frames and prompt, then prepare a generation review.</p></div>}
    <ol className="fl-activity__list">
      {attempts.map(attempt => <AttemptRow key={attempt.id} attempt={attempt} busy={busy} onResume={onResume} />)}
    </ol>
  </section>;
}

function AttemptRow({ attempt, busy, onResume }: { attempt: Attempt; busy: boolean; onResume: ActivityPanelProps['onResume'] }) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const headingId = useId();
  const helpId = useId();
  const hasReceipt = typeof attempt.providerJobId === 'string' && attempt.providerJobId.length > 0;
  const presentation = attempt.status === 'running' && hasReceipt ? {title:'Awaiting result',description:'The provider accepted this attempt. Its result is not available yet; execution and completion time are not confirmed.'} : states[attempt.status];
  const canResume = attempt.status === 'queued' || (hasReceipt && !['blocked', 'ready'].includes(attempt.status));
  async function resume() {
    if (busy || lock.current || !canResume) return;
    lock.current = true;
    setPending(true);
    setNotice('');
    try {
      await onResume(attempt.id);
      setNotice('Check requested. Waiting for the workspace to confirm what happened.');
    } catch {
      setNotice('The check could not be confirmed. This is still the same attempt; no new generation was requested.');
    } finally { lock.current = false; setPending(false); }
  }
  return <li className="fl-activity__item" data-state={attempt.status} aria-labelledby={headingId}>
    <span className="fl-activity__mark" aria-hidden="true" />
    <div className="fl-activity__body">
      <h3 id={headingId} aria-live="polite">{presentation.title}</h3>
      <p>{presentation.description}</p>
      {attempt.status === 'blocked' && attempt.errorCode && <p className="fl-activity__warning">{blockerText({ code: attempt.errorCode, message: attempt.message ?? 'The provider cannot accept this request with the current settings.' })}</p>}
      {attempt.status === 'acceptance_unknown' && !hasReceipt && <p className="fl-activity__warning">No provider receipt is available for a safe lookup. Keep this attempt on hold; do not resubmit it.</p>}
      {canResume && <div className="fl-activity__recovery">
        <button type="button" disabled={busy || pending} aria-describedby={helpId} onClick={() => void resume()}>Check existing attempt</button>
        <p id={helpId}>Checks or resumes this attempt only. Does not authorize a new generation.</p>
      </div>}
      <p role="status" className="fl-activity__notice">{notice}</p>
      <details className="fl-activity__details"><summary>Attempt details</summary><dl>
        <dt>Shot</dt><dd>{attempt.shotId}</dd>
        <dt>Shot revision</dt><dd>{attempt.shotRevision}</dd>
        <dt>Attempt</dt><dd>{attempt.id}</dd>
        <dt>Provider receipt</dt><dd>{attempt.providerJobId ?? 'Not available'}</dd>
        {attempt.errorCode !== null && <><dt>Reason code</dt><dd>{attempt.errorCode}</dd></>}
        {attempt.message !== null && <><dt>Details</dt><dd>{attempt.message}</dd></>}
      </dl></details>
    </div>
  </li>;
}
