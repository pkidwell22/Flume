import { useEffect, useId, useRef, useState } from 'react';
import {
  blockerText,
  isMoney,
  roleLabel,
  roleNoun,
  safeFrameMediaUrl,
} from './frame-authoring-types.ts';
import type {
  FrameAuthoringDraft,
  FrameAuthoringProps,
  FrameBindingReceipt,
  FrameInspection,
  FrameModel,
  FrameReview,
  FrameRole,
  FrameSubmission,
  FrameSubmissionStatus,
} from './frame-authoring-types.ts';

export { safeFrameMediaUrl } from './frame-authoring-types.ts';

// The panel never talks to a provider and never invents a result. Every state below
// is either operator input or a value returned by the injected callbacks.

interface DraftState {
  role: FrameRole;
  prompt: string;
  modelId: string;
  aspectRatio: string;
  sourceAssetId: string | null;
}

const OTHER_ROLE: Record<FrameRole, FrameRole> = { first_frame: 'last_frame', last_frame: 'first_frame' };

function preferredModel(models: FrameModel[]): FrameModel | null {
  return models.find(model => model.availability === 'available') ?? models[0] ?? null;
}

function submissionTitle(status: FrameSubmissionStatus): string {
  if (status === 'queued' || status === 'running') return 'Generating';
  if (status === 'succeeded') return 'Generation finished';
  if (status === 'failed') return 'Generation failed';
  if (status === 'acceptance_unknown') return 'Acceptance unknown';
  return 'Generation cancelled';
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'The workspace did not return a reason.';
}

export function FrameAuthoring(props: FrameAuthoringProps) {
  // A different shot is a different session: no draft, review or inspection leaks across.
  return <FrameAuthoringSession key={`${props.projectId}:${props.shotId}`} {...props} />;
}

function FrameAuthoringSession({
  projectId,
  shotId,
  expectedRevision,
  bindings,
  models,
  sourceAssets,
  initialRole,
  busy = false,
  onPrepareReview,
  onApproveAndGenerate,
  onCheckSubmission,
  onCancelSubmission,
  onInspectResult,
  onBindFrame,
}: FrameAuthoringProps) {
  const uid = useId();
  const [draft, setDraft] = useState<DraftState>(() => {
    const model = preferredModel(models);
    return {
      role: initialRole ?? 'first_frame',
      prompt: '',
      modelId: model?.modelId ?? '',
      aspectRatio: model?.aspectRatios[0] ?? '',
      sourceAssetId: null,
    };
  });
  const [stage, setStage] = useState<'draft' | 'preparing' | 'review' | 'submitted'>('draft');
  const [review, setReview] = useState<FrameReview | null>(null);
  const [submission, setSubmission] = useState<FrameSubmission | null>(null);
  const [inspection, setInspection] = useState<FrameInspection | null>(null);
  const [receipt, setReceipt] = useState<FrameBindingReceipt | null>(null);
  const [limit, setLimit] = useState('');
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');

  const prepared = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const model = models.find(option => option.modelId === draft.modelId) ?? preferredModel(models);
  const aspectRatio =
    model && !model.aspectRatios.includes(draft.aspectRatio) ? (model.aspectRatios[0] ?? '') : draft.aspectRatio;

  const issues: string[] = [];
  if (!model) issues.push('No generation model is available for this frame.');
  else if (model.availability === 'blocked') issues.push(model.blocker ?? 'This model route is not available for this account.');
  else if (model.availability === 'unknown') issues.push('Model availability has not been reported. Nothing can be sent until the server confirms it.');
  if (model && !model.frameRoles.includes(draft.role)) issues.push(`This model cannot generate the ${roleNoun(draft.role)}.`);
  if (!draft.prompt.trim()) issues.push('Describe the frame before preparing a review.');
  const prepareDisabled = issues.length > 0 || busy || stage !== 'draft';

  const reviewStale = review !== null && review.expectedRevision !== expectedRevision;
  const reviewBlocked = review !== null && (review.status === 'blocked' || review.blockers.length > 0);
  const estimate = review?.estimateUsd ?? null;

  const generateIssues: string[] = [];
  if (reviewStale) generateIssues.push(`This review is out of date: the shot changed after it was prepared (now revision ${expectedRevision}). Prepare a new review.`);
  if (reviewBlocked) generateIssues.push('The server blocked this request. Address the blockers and prepare a new review.');
  if (estimate === null) generateIssues.push('The price is not quoted. Unknown is not free, so generation stays disabled.');
  else if (!isMoney(limit)) generateIssues.push('Enter a spending limit in USD, for example 0.42.');
  else if (Number(limit) < estimate) generateIssues.push(`The spending limit is below the quoted estimate of $${estimate.toFixed(2)}.`);
  if (busy) generateIssues.push('The workspace is busy.');
  const generateDisabled = stage !== 'review' || submission !== null || generateIssues.length > 0;

  const running = submission?.status === 'queued' || submission?.status === 'running';
  const phase = stage === 'draft'
    ? 'draft'
    : stage === 'preparing'
      ? 'preparing'
      : stage === 'review'
        ? 'review'
        : submission
          ? submission.status
          : 'submitting';
  const inspectedUrl = inspection ? safeFrameMediaUrl(inspection.mediaUrl) : undefined;
  const otherRole: FrameRole = review ? OTHER_ROLE[review.role] : 'last_frame';

  async function prepare() {
    if (prepareDisabled || lock.current) return;
    const controller = new AbortController();
    prepared.current = controller;
    const token = ++epoch.current;
    setStage('preparing');
    setFailure('');
    setNotice('');
    setReview(null);
    setSubmission(null);
    setInspection(null);
    setReceipt(null);
    setLimit('');
    const request: FrameAuthoringDraft = {
      projectId,
      shotId,
      expectedRevision,
      role: draft.role,
      prompt: draft.prompt,
      modelId: model?.modelId ?? draft.modelId,
      aspectRatio,
      sourceAssetId: draft.sourceAssetId,
    };
    try {
      const next = await onPrepareReview(request, { signal: controller.signal });
      if (!mounted.current || token !== epoch.current) return;
      setReview(next);
      setStage('review');
      setLimit(next.estimateUsd === null ? '' : next.estimateUsd.toFixed(2));
    } catch (error) {
      if (!mounted.current || token !== epoch.current) return;
      setStage('draft');
      setFailure(`The review could not be prepared. ${errorMessage(error)}`);
    } finally {
      if (prepared.current === controller) prepared.current = null;
    }
  }

  function cancelPreparation() {
    const controller = prepared.current;
    if (!controller) return;
    prepared.current = null;
    controller.abort();
    epoch.current += 1;
    setStage('draft');
    setNotice('Preparation cancelled. No review was created and nothing was sent.');
  }

  async function generate() {
    if (!review || generateDisabled || lock.current || estimate === null) return;
    lock.current = true;
    const token = ++epoch.current;
    setStage('submitted');
    setNotice('');
    setFailure('');
    try {
      const next = await onApproveAndGenerate(review, { maxAttempts: 1, maxCostUsd: limit.trim() });
      if (!mounted.current || token !== epoch.current) return;
      setSubmission(next);
    } catch (error) {
      if (!mounted.current || token !== epoch.current) return;
      // An unconfirmed submit may already have reached the provider: never invent a
      // failure (which invites a retry) and never invent success.
      setSubmission({
        attemptId: '',
        reviewId: review.reviewId,
        shotId,
        status: 'acceptance_unknown',
        assetId: null,
        stage: null,
        progress: null,
        errorCode: 'ACCEPTANCE_UNCONFIRMED',
        message: `The request could not be confirmed. ${errorMessage(error)}`,
      });
    } finally {
      lock.current = false;
    }
  }

  async function checkAttempt(attemptId: string) {
    if (!attemptId || lock.current) return;
    lock.current = true;
    const token = epoch.current;
    setNotice('Checking the stored attempt status…');
    try {
      const next = await onCheckSubmission(attemptId);
      if (!mounted.current || token !== epoch.current) return;
      if (next.assetId !== submission?.assetId) {
        setInspection(null);
        setReceipt(null);
      }
      setSubmission(next);
      setNotice(next.status === 'acceptance_unknown' ? 'Still unknown. Nothing was retried; check again once the server records an outcome.' : '');
    } catch (error) {
      if (token !== epoch.current) return;
      setNotice(`The attempt status could not be checked. ${errorMessage(error)}`);
    } finally {
      lock.current = false;
    }
  }

  async function cancelGeneration() {
    const attemptId = submission?.attemptId ?? '';
    if (!attemptId || !onCancelSubmission || lock.current) return;
    lock.current = true;
    const token = ++epoch.current;
    try {
      const next = await onCancelSubmission(attemptId);
      if (!mounted.current || token !== epoch.current) return;
      setSubmission(next);
      setInspection(null);
      setReceipt(null);
      setNotice(next.status === 'cancelled' ? 'Cancellation confirmed.' : 'Cancellation requested; the attempt is still running. Check status to confirm.');
    } catch (error) {
      if (token !== epoch.current) return;
      setNotice(`Cancellation could not be confirmed. Check status before assuming the attempt stopped. ${errorMessage(error)}`);
    } finally {
      lock.current = false;
    }
  }

  async function inspectResult() {
    const assetId = submission?.assetId ?? '';
    if (!assetId || lock.current) return;
    lock.current = true;
    const token = epoch.current;
    setNotice('Inspecting the stored result. This reads the asset; it does not spend.');
    try {
      const next = await onInspectResult(assetId);
      if (!mounted.current || token !== epoch.current) return;
      setInspection(next);
      setNotice('');
    } catch (error) {
      if (token !== epoch.current) return;
      setNotice(`The returned image could not be inspected, so binding stays unavailable. ${errorMessage(error)}`);
    } finally {
      lock.current = false;
    }
  }

  async function bindFrame() {
    if (!review || !inspection || !inspectedUrl || receipt || reviewStale || lock.current) return;
    lock.current = true;
    const token = epoch.current;
    setNotice('Binding the inspected image to the shot…');
    try {
      const next = await onBindFrame({
        projectId,
        shotId,
        role: review.role,
        assetId: inspection.assetId,
        inspectionId: inspection.inspectionId,
        expectedRevision,
      });
      if (!mounted.current || token !== epoch.current) return;
      setReceipt(next);
      setNotice('');
    } catch (error) {
      if (token !== epoch.current) return;
      setNotice(`Binding could not be confirmed, so nothing is reported as bound. Check the shot before trying again. ${errorMessage(error)}`);
    } finally {
      lock.current = false;
    }
  }

  function startNewReview(note: string) {
    epoch.current += 1;
    setStage('draft');
    setReview(null);
    setSubmission(null);
    setInspection(null);
    setReceipt(null);
    setLimit('');
    setFailure('');
    setNotice(note);
  }

  function referenceName(assetId: string | null) {
    if (!assetId) return 'None — text only';
    return sourceAssets.find(asset => asset.assetId === assetId)?.filename ?? assetId;
  }

  function modelName(modelId: string) {
    return models.find(option => option.modelId === modelId)?.name ?? modelId;
  }

  return (
    <section
      className="fl-frame-authoring"
      aria-labelledby={`${uid}-title`}
      aria-busy={stage === 'preparing' || (stage === 'submitted' && !submission) || running}
      data-frame-phase={phase}
    >
      <header className="fl-fa__head">
        <p className="fl-eyebrow">Frame authoring</p>
        <h2 id={`${uid}-title`}>Author a frame</h2>
        <p className="fl-hint">
          A reference image steers a new frame. Editing, choosing a reference and preparing a review spend nothing;
          only “Approve and generate once” sends work to a model.
        </p>
      </header>

      <p className="fl-fa__notice" role="status" aria-live="polite">{notice}</p>
      {failure && <p className="fl-fa__alert" role="alert">{failure}</p>}

      {(stage === 'draft' || stage === 'preparing') && (
        <div className="fl-fa__composer">
          <fieldset className="fl-fa__roles" disabled={busy || stage === 'preparing'}>
            <legend>Target frame</legend>
            <div className="fl-fa__role-row">
              {(['first_frame', 'last_frame'] as const).map(role => (
                <label key={role} className="fl-fa__role" data-selected={draft.role === role}>
                  <input
                    type="radio"
                    name={`${uid}-role`}
                    value={role}
                    checked={draft.role === role}
                    onChange={() => setDraft(current => ({ ...current, role }))}
                  />
                  <span>{roleLabel(role)}</span>
                </label>
              ))}
            </div>
            <p className="fl-hint">
              {`Start frame: ${bindings.firstFrameAssetId ? 'holds an image' : 'empty'}. End frame: ${bindings.lastFrameAssetId ? 'holds an image' : 'empty'}. Binding a new frame never clears the other one.`}
            </p>
          </fieldset>

          <div className="fl-fa__field">
            <label htmlFor={`${uid}-prompt`}>Prompt</label>
            <textarea
              id={`${uid}-prompt`}
              rows={3}
              value={draft.prompt}
              disabled={busy || stage === 'preparing'}
              onChange={event => setDraft(current => ({ ...current, prompt: event.target.value }))}
              aria-describedby={`${uid}-prompt-hint`}
            />
            <p id={`${uid}-prompt-hint`} className="fl-hint">Describe the frame you want. Drafting is free.</p>
          </div>

          <div className="fl-fa__grid">
            <div className="fl-fa__field">
              <label htmlFor={`${uid}-model`}>Model</label>
              <select
                id={`${uid}-model`}
                value={model?.modelId ?? ''}
                disabled={busy || stage === 'preparing'}
                onChange={event => {
                  const value = event.target.value;
                  const next = models.find(option => option.modelId === value);
                  setDraft(current => ({ ...current, modelId: value, aspectRatio: next?.aspectRatios[0] ?? current.aspectRatio }));
                }}
              >
                {models.map(option => (
                  <option key={option.modelId} value={option.modelId}>
                    {option.name}
                    {option.availability === 'blocked' ? ' (unavailable)' : option.availability === 'unknown' ? ' (unconfirmed)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="fl-fa__field">
              <label htmlFor={`${uid}-aspect`}>Aspect ratio</label>
              <select
                id={`${uid}-aspect`}
                value={aspectRatio}
                disabled={busy || stage === 'preparing' || !model}
                onChange={event => setDraft(current => ({ ...current, aspectRatio: event.target.value }))}
              >
                {(model?.aspectRatios ?? []).map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}
              </select>
            </div>
          </div>

          <div className="fl-fa__field">
            <label htmlFor={`${uid}-reference`}>Reference image (optional)</label>
            <select
              id={`${uid}-reference`}
              value={draft.sourceAssetId ?? ''}
              disabled={busy || stage === 'preparing'}
              onChange={event => setDraft(current => ({ ...current, sourceAssetId: event.target.value || null }))}
              aria-describedby={`${uid}-reference-hint`}
            >
              <option value="">No reference — text only</option>
              {sourceAssets.map(asset => <option key={asset.assetId} value={asset.assetId}>{asset.filename}</option>)}
            </select>
            <p id={`${uid}-reference-hint`} className="fl-hint">
              Variation uses this project image as a reference. Choosing it sends nothing, spends nothing and binds nothing.
            </p>
          </div>

          <div className="fl-fa__actions">
            <button
              type="button"
              className="fl-btn fl-btn--primary"
              onClick={() => void prepare()}
              disabled={prepareDisabled}
              aria-describedby={issues.length ? `${uid}-prepare-issues` : undefined}
            >
              Prepare review
            </button>
            {stage === 'preparing' && (
              <button type="button" className="fl-btn fl-btn--ghost" onClick={cancelPreparation}>
                Cancel preparation
              </button>
            )}
          </div>
          {stage === 'preparing' && <p className="fl-hint" aria-live="polite">Preparing review… no generation has been requested.</p>}
          {issues.length > 0 && (
            <ul id={`${uid}-prepare-issues`} className="fl-fa__issues">
              {issues.map(issue => <li key={issue}>{issue}</li>)}
            </ul>
          )}
        </div>
      )}

      {review && stage !== 'draft' && stage !== 'preparing' && (
        <section className="fl-fa__review" aria-labelledby={`${uid}-review`}>
          <div className="fl-fa__section-head">
            <h3 id={`${uid}-review`}>Review request</h3>
            {stage === 'review' && (
              <button
                type="button"
                className="fl-link"
                onClick={() => startNewReview('The previous review is closed. Editing sends nothing; prepare a new review when ready.')}
              >
                Edit the draft
              </button>
            )}
          </div>
          <dl className="fl-fa__meta">
            <div><dt>Target</dt><dd>{roleLabel(review.role)}</dd></div>
            <div><dt>Prompt</dt><dd className="fl-fa__prompt">{review.prompt}</dd></div>
            <div><dt>Model</dt><dd>{modelName(review.modelId)}</dd></div>
            <div><dt>Aspect ratio</dt><dd>{review.aspectRatio}</dd></div>
            <div><dt>Reference</dt><dd>{referenceName(review.sourceAssetId)}</dd></div>
            <div><dt>Shot revision</dt><dd>{review.expectedRevision}</dd></div>
            <div><dt>Request hash</dt><dd className="fl-mono">{review.requestHash}</dd></div>
            <div><dt>Estimated cost</dt><dd>{review.estimateUsd === null ? 'Not quoted' : `$${review.estimateUsd.toFixed(2)} USD`}</dd></div>
          </dl>

          {(reviewStale || reviewBlocked) && (
            <div className="fl-fa__alert" role="alert">
              {reviewStale && (
                <p>
                  {`This review is out of date: the shot changed after it was prepared (now revision ${expectedRevision}). The old approval cannot be used; prepare a new review.`}
                </p>
              )}
              {reviewBlocked && (
                <>
                  <p>The server blocked this request.</p>
                  <ul>{review.blockers.map((blocker, index) => <li key={index}>{blockerText(blocker)}</li>)}</ul>
                </>
              )}
            </div>
          )}

          {review.estimateUsd === null && (
            <p className="fl-fa__caution">No price estimate was supplied. Unknown is not free, so generation stays disabled.</p>
          )}

          {stage === 'review' && !submission && (
            <div className="fl-fa__spend">
              <label htmlFor={`${uid}-limit`}>Spending limit (USD)</label>
              <input
                id={`${uid}-limit`}
                type="text"
                inputMode="decimal"
                value={limit}
                disabled={estimate === null || busy}
                onChange={event => setLimit(event.target.value)}
                aria-invalid={estimate !== null && limit !== '' && !isMoney(limit)}
                aria-describedby={`${uid}-spend-hint`}
              />
              <p id={`${uid}-spend-hint`} className="fl-hint">
                One attempt within this allowance. The final charge can differ; this is not a provider billing cap.
              </p>
              <button
                type="button"
                className="fl-btn fl-btn--primary"
                onClick={() => void generate()}
                disabled={generateDisabled}
                aria-describedby={generateIssues.length ? `${uid}-generate-issues` : undefined}
              >
                Approve and generate once
              </button>
              <p className="fl-hint">Nothing is submitted until you press this button. There are no automatic retries.</p>
              {generateIssues.length > 0 && (
                <ul id={`${uid}-generate-issues`} className="fl-fa__issues">
                  {generateIssues.map(issue => <li key={issue}>{issue}</li>)}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {stage === 'submitted' && !submission && (
        <section className="fl-fa__attempt" aria-labelledby={`${uid}-sending`}>
          <h3 id={`${uid}-sending`}>Sending request</h3>
          <p>Waiting for the server to confirm whether the provider accepted this attempt. Nothing is retried automatically.</p>
        </section>
      )}

      {submission && (
        <section className="fl-fa__attempt" aria-labelledby={`${uid}-attempt`} aria-busy={running}>
          <h3 id={`${uid}-attempt`}>{submissionTitle(submission.status)}</h3>

          {running && (
            <>
              <div
                className="fl-fa__progress"
                role="progressbar"
                aria-label="Generation progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={typeof submission.progress === 'number' ? submission.progress : undefined}
              >
                <span style={{ width: `${typeof submission.progress === 'number' ? submission.progress : 30}%` }} />
              </div>
              <p className="fl-mono">
                {submission.stage ?? 'Waiting for the provider'}
                {typeof submission.progress === 'number' ? ` · ${submission.progress}%` : ''}
              </p>
              <p>Progress is reported by the server. Checking status reads the stored attempt; it does not send another request.</p>
              <div className="fl-fa__actions">
                <button type="button" className="fl-btn fl-btn--ghost" onClick={() => void checkAttempt(submission.attemptId)}>
                  Check status
                </button>
                {onCancelSubmission && (
                  <button type="button" className="fl-btn fl-btn--ghost" onClick={() => void cancelGeneration()}>
                    Cancel generation
                  </button>
                )}
              </div>
            </>
          )}

          {submission.status === 'acceptance_unknown' && (
            <>
              <div className="fl-fa__alert" role="alert">
                <p>
                  Acceptance unknown. The provider may have received this request, so it is not retried automatically and
                  no retry button is offered.
                </p>
                {submission.errorCode && <p className="fl-mono">{submission.errorCode}</p>}
                {submission.message && <p>{submission.message}</p>}
              </div>
              {submission.attemptId && (
                <button type="button" className="fl-btn fl-btn--ghost" onClick={() => void checkAttempt(submission.attemptId)}>
                  Check acceptance
                </button>
              )}
            </>
          )}

          {submission.status === 'failed' && (
            <>
              <div className="fl-fa__alert" role="alert">
                <p>Generation failed.</p>
                {submission.errorCode && <p className="fl-mono">{submission.errorCode}</p>}
                {submission.message && <p>{submission.message}</p>}
              </div>
              <p>A retry needs a new review and a new approval. The spent review is closed; nothing is resubmitted from here.</p>
              <button
                type="button"
                className="fl-btn fl-btn--primary"
                onClick={() => startNewReview('The previous attempt is closed. Prepare and approve a new review before generating.')}
              >
                Prepare a new review
              </button>
            </>
          )}

          {submission.status === 'cancelled' && (
            <>
              <p>Generation cancelled. This attempt is closed and is not retried automatically.</p>
              <button
                type="button"
                className="fl-btn fl-btn--primary"
                onClick={() => startNewReview('The cancelled attempt is closed. Prepare and approve a new review to try again.')}
              >
                Prepare a new review
              </button>
            </>
          )}

          {submission.status === 'succeeded' && review && (
            <div data-frame-result className="fl-fa__result">
              <h4>Returned image</h4>
              {!inspection ? (
                <>
                  <p>Inspect the stored image before binding it. Inspection reads the asset; it does not spend.</p>
                  <button
                    type="button"
                    className="fl-btn fl-btn--primary"
                    onClick={() => void inspectResult()}
                    disabled={!submission.assetId || busy}
                  >
                    Inspect returned image
                  </button>
                </>
              ) : (
                <>
                  {inspectedUrl ? (
                    <figure aria-label="Returned image" className="fl-fa__figure">
                      <img
                        src={inspectedUrl}
                        alt={`Returned ${roleNoun(review.role)} from ${modelName(review.modelId)}`}
                        width={inspection.width}
                        height={inspection.height}
                      />
                      <figcaption className="fl-mono">
                        {inspection.mimeType} · {inspection.width} × {inspection.height}
                      </figcaption>
                    </figure>
                  ) : (
                    <p className="fl-fa__alert" role="alert">
                      The returned image is not served from this project’s media route, so it cannot be bound.
                    </p>
                  )}
                  <dl className="fl-fa__meta fl-fa__meta--tight">
                    <div><dt>Asset</dt><dd className="fl-mono">{inspection.assetId}</dd></div>
                    <div><dt>SHA-256</dt><dd className="fl-mono">{inspection.sha256}</dd></div>
                    <div><dt>Inspection</dt><dd className="fl-mono">{inspection.inspectionId}</dd></div>
                  </dl>
                  {inspectedUrl && (
                    receipt ? (
                      <p data-frame-bound role="status">
                        {`Bound to ${roleNoun(receipt.role)} at shot revision ${receipt.revision}. The ${roleNoun(OTHER_ROLE[receipt.role])} was not changed.`}
                      </p>
                    ) : (
                      <>
                        <p>{`The ${roleNoun(otherRole)} will not change. Binding writes one frame and leaves the rest of the shot alone.`}</p>
                        <button
                          type="button"
                          className="fl-btn fl-btn--primary"
                          onClick={() => void bindFrame()}
                          disabled={reviewStale || busy}
                        >
                          {`Bind to ${roleNoun(review.role)}`}
                        </button>
                      </>
                    )
                  )}
                </>
              )}
            </div>
          )}
        </section>
      )}
    </section>
  );
}
