import { useEffect, useId, useRef, useState } from 'react';
import type { GenerationReviewProps } from './types.ts';
import { blockerText } from './presentation.ts';

export function GenerationReview(props: GenerationReviewProps) {
  if (!props.review) return null;
  return <ReviewDrawer key={`${props.review.id}:${props.review.requestHash}`} {...props} review={props.review} />;
}

function ReviewDrawer({ review, assets, busy = false, onApprove, onSubmit, onDismiss }: GenerationReviewProps & { review: NonNullable<GenerationReviewProps['review']> }) {
  const [limit, setLimit] = useState(review.estimatedCostUsd ?? '');
  const [requestedApproval, setRequestedApproval] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [frameStates, setFrameStates] = useState<Record<string, 'loaded' | 'failed'>>({});
  const frames = ([['Start frame', review.bindings.firstFrameAssetId], ['End frame', review.bindings.lastFrameAssetId]] as const).map(([role, assetId]) => {
    const asset = assets.find(item => item.id === assetId && item.projectId === review.projectId && item.kind === 'image' && /^\/api\/media\/[^?#\\]+$/.test(item.mediaUrl));
    const key = JSON.stringify([role, asset?.id, asset?.sha256, asset?.mediaUrl]);
    return { role, assetId, asset, key, state: frameStates[key] };
  });
  const framesReady = frames.every(frame => frame.assetId === null || (frame.asset && frame.state === 'loaded'));
  const lock = useRef(false);
  const limitId = useId();
  const validLimit = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(limit);
  const blocked = review.blockers.length > 0 || !framesReady || review.estimatedCostUsd === null;
  const approveDisabled = blocked || busy || pending || submitted || requestedApproval || review.approved || !validLimit;
  const submitDisabled = blocked || busy || pending || submitted || !review.approved;
  async function approve() {
    if (approveDisabled || lock.current) return;
    lock.current = true;
    setPending(true);
    setRequestedApproval(true);
    try {
      await onApprove(review.id, { maxAttempts: 1, maxCostUsd: limit });
      setNotice('Approval requested. Waiting for confirmation from the workspace.');
    } catch {
      setNotice('Approval could not be confirmed. Close this review and refresh the workspace to check approval before continuing.');
    } finally { lock.current = false; setPending(false); }
  }
  async function submit() {
    if (submitDisabled || lock.current) return;
    lock.current = true;
    setPending(true);
    setSubmitted(true);
    try {
      await onSubmit(review.id);
      setNotice('Submission requested. Check Activity for its confirmed status.');
    } catch {
      setNotice('Submission could not be confirmed. The provider may have received it. Check Activity before trying again; another request could create another charge.');
    } finally { lock.current = false; setPending(false); }
  }
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement;
    if (dialog && !dialog.open) dialog.showModal();
    dialog?.querySelector<HTMLElement>('h2')?.focus();
    return () => {
      if (dialog?.open) dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected && !document.querySelector('dialog[open]')) opener.focus();
    };
  }, []);
  return <dialog ref={dialogRef} aria-labelledby={titleId} className="fl-review" onCancel={event => { event.preventDefault(); onDismiss(); }}>
    <header className="fl-review__header">
      <div><h2 id={titleId} tabIndex={-1}>Review generation</h2><p>This exact version will be sent. Editing the shot requires a new review.</p></div>
      <button type="button" className="fl-review__close" aria-label="Close review" onClick={onDismiss}>Close</button>
    </header>
    <div className="fl-review__content">
    <div className="fl-review__frames">
      {frames.map(({ role, assetId, asset, key, state }) => <figure aria-label={role} key={role} className="fl-review__frame">
        <figcaption>{role}</figcaption>
        <div className="fl-review__image">
          {asset && state !== 'failed' ? <img key={key} src={asset.mediaUrl} alt={`${role}: ${asset.filename}`} onLoad={() => setFrameStates(previous => ({ ...previous, [key]: 'loaded' }))} onError={() => setFrameStates(previous => ({ ...previous, [key]: 'failed' }))} /> : <p>{assetId === null ? 'No image assigned' : state === 'failed' ? 'Image could not be loaded' : 'Image unavailable'}</p>}
        </div>
        {asset && <><p className="fl-review__filename">{asset.filename}</p><span className="fl-review__origin">{asset.origin === 'sample' ? 'Sample' : asset.origin === 'imported' ? 'Imported' : 'Generated'}</span><span className="fl-review__dimensions">{asset.width} × {asset.height}</span></>}
      </figure>)}
    </div>
    <h3>Prompt</h3>
    <p data-testid="fl-review-prompt" className="fl-review__prompt">{review.prompt}</p>
    <dl className="fl-review__controls">
      <dt>Model</dt><dd>{review.controls.modelId}</dd>
      <dt>Length</dt><dd>{review.controls.durationSeconds} seconds</dd>
      <dt>Resolution</dt><dd>{review.controls.resolution}</dd>
      <dt>Frame shape</dt><dd>{review.controls.aspectRatio}</dd>
      <dt>Audio</dt><dd>{review.controls.generateAudio ? 'On' : 'Off'}</dd>
      <dt>Seed</dt><dd>{review.controls.seed ?? 'Not specified'}</dd>
    </dl>
    {!framesReady && <p className="fl-review__warning" role="status">Both assigned images must be visible before you can approve or generate. If an image is unavailable, return to the shot and prepare a new review.</p>}
    {review.blockers.length > 0 && <section className="fl-review__blockers" aria-label="Generation blocked">
      <h3>Generation is blocked</h3>
      <ul>{review.blockers.map((blocker, index) => <li key={index}>{blockerText(blocker)}</li>)}</ul>
      <p>You can keep editing. Choose a compatible available model, then prepare a new review. Repeating this request will not fix a provider block.</p>
    </section>}
    <section className="fl-review__cost">
      <h3>{review.estimatedCostUsd === null ? 'Cost not available' : `Estimated cost: $${review.estimatedCostUsd} USD`}</h3>
      <p>{review.estimatedCostUsd === null ? 'The provider has not supplied an estimate. Unknown does not mean free.' : 'This is an estimate, not a final charge.'}</p>
      {review.estimatedCostUsd === null ? <p>Approval is on hold until a reliable estimate is available. No dollar limit can be checked for an unknown price.</p> : !review.approved ? <>
        <label htmlFor={limitId}>Spending limit (USD)</label>
        <input id={limitId} type="text" inputMode="decimal" value={limit} onChange={event => setLimit(event.target.value)} disabled={busy || pending || requestedApproval || submitted} aria-invalid={limit !== '' && !validLimit} aria-describedby={`${limitId}-help`} />
        <p id={`${limitId}-help`}>{limit !== '' && !validLimit ? 'Enter a non-negative USD amount using digits and a decimal point. ' : ''}Approve at most one attempt with an estimated cost within this allowance. This is not a provider-enforced billing cap; the final charge can differ. No automatic paid retries.</p>
      </> : <p>Approved spending limits are enforced by the workspace. This estimate is not your allowance.</p>}
    </section>
    <details className="fl-review__details"><summary>Review details</summary><dl>
      <dt>Review</dt><dd>{review.id}</dd>
      <dt>Shot</dt><dd>{review.shotId}</dd>
      <dt>Shot revision</dt><dd>{review.shotRevision}</dd>
      <dt>Request hash</dt><dd>{review.requestHash}</dd>
      <dt>Start frame ID</dt><dd>{review.bindings.firstFrameAssetId ?? 'None'}</dd>
      <dt>End frame ID</dt><dd>{review.bindings.lastFrameAssetId ?? 'None'}</dd>
    </dl></details>
    </div>
    <footer className="fl-review__footer" aria-busy={busy || pending}>
      <p>{review.approved ? 'Approval confirmed by the workspace.' : 'Approval is required before generation.'} Approving does not send this request.</p>
      <div className="fl-review__actions">
        <button type="button" disabled={approveDisabled} onClick={() => void approve()}>Approve this generation</button>
        <button type="button" disabled={submitDisabled} onClick={() => void submit()}>Generate once</button>
      </div>
      <p role="status">{notice}</p>
    </footer>
  </dialog>;
}
