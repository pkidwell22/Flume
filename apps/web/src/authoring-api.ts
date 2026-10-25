/**
 * Browser adapter for the fixed Wave 2 authoring routes.
 *
 * Deliberately separate from the video command port: frame authoring is NOT
 * `generation.prepare` / `generation.submit` / `take.inspect` / `attempt.resume`.
 * Nothing here invents an id, price, progress value or result. Every value in a
 * returned view comes from the server response, and every unknown stays unknown:
 *
 *  - a null estimate stays null (unknown is not free, and never 0);
 *  - an unrecognised review status becomes `acceptance_unknown`, which offers no
 *    retry, rather than a hopeful `running` or `succeeded`;
 *  - an image review has no provider attempt id, so the stored review id is the
 *    only status handle exposed to the panel (documented below, not invented).
 */
import type {
  FrameAuthoringDraft,
  FrameBindInput,
  FrameBindingReceipt,
  FrameInspection,
  FrameModel,
  FrameReview,
  FrameRole,
  FrameSubmission,
} from './frame-authoring-types.ts';
import type { ComposerItemInput, ComposerProposal } from './storyboard-types.ts';
import type { ContinueShotOutcome, ContinueShotPublicView, ContinueShotRequest } from './continue-shot-types.ts';

export interface AuthoringCapabilities {
  imageModels: FrameModel[];
  storyboard: { available: boolean; blocker: string | null };
}

export interface FrameSubmissionResult {
  review: FrameReview;
  submission: FrameSubmission;
}

export interface AuthoringPort {
  capabilities(): Promise<AuthoringCapabilities>;
  createFrameReview(draft: FrameAuthoringDraft): Promise<FrameReview>;
  readFrameReview(reviewId: string, projectId: string): Promise<FrameSubmissionResult>;
  generateFrame(reviewId: string, input: { projectId: string; expectedRevision: number; maxCostUsd: string }): Promise<FrameSubmissionResult>;
  importFrameResult(reviewId: string, projectId: string): Promise<FrameInspection>;
  bindFrame(reviewId: string, input: FrameBindInput): Promise<FrameBindingReceipt>;
  createProposal(input: { projectId: string; brief: string }): Promise<ComposerProposal>;
  readProposal(proposalId: string, projectId: string): Promise<ComposerProposal>;
  reviseProposal(proposalId: string, input: { projectId: string; expectedRevision: number; items: ComposerItemInput[] }): Promise<ComposerProposal>;
  acceptProposal(proposalId: string, input: { projectId: string; expectedRevision: number }): Promise<ComposerProposal>;
  resumeProposal(proposalId: string, input: { projectId: string; retryFailed: boolean }): Promise<ComposerProposal>;
  cancelProposal(proposalId: string, input: { projectId: string }): Promise<ComposerProposal>;
  continueShot(input: ContinueShotRequest): Promise<ContinueShotOutcome>;
  /** Authorized, project-scoped read of the durable continuation. Performs no mutation. */
  readContinuation(operationId: string, projectId: string): Promise<ContinueShotPublicView>;
  /** Explicit resume of the stored operation; the server replays its frozen intention. */
  resumeContinuation(operationId: string, projectId: string): Promise<ContinueShotOutcome>;
}

/** Safe server error. Mirrors ApiError so the workspace controller reports it unchanged. */
export class AuthoringApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly currentRevision?: number;
  /** True when a mutating request may already have reached the provider. */
  readonly outcomeUnknown: boolean;
  constructor(code: string, message: string, options: { status?: number; currentRevision?: number; outcomeUnknown?: boolean } = {}) {
    super(message);
    this.name = 'AuthoringApiError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.currentRevision !== undefined) this.currentRevision = options.currentRevision;
    this.outcomeUnknown = options.outcomeUnknown === true;
  }
}

const ROLES: readonly FrameRole[] = ['first_frame', 'last_frame'];
const REVIEW_STATUSES = ['pending', 'blocked', 'approved', 'submitting', 'submitted', 'result_ready', 'bound', 'failed', 'acceptance_unknown'] as const;
/** Only these server statuses may be presented to the operator as sendable. */
const SENDABLE = new Set(['pending', 'approved']);

function malformed(what: string): AuthoringApiError {
  return new AuthoringApiError('MALFORMED_RESPONSE', `The server returned an unreadable ${what}. Nothing was assumed.`);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function blockersOf(value: unknown): FrameReview['blockers'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Array<{ code: string; message: string } | string> => {
    if (typeof item === 'string') return [item];
    const entry = record(item);
    return typeof entry.code === 'string' && typeof entry.message === 'string' ? [{ code: entry.code, message: entry.message }] : [];
  });
}

/**
 * The panel's review view only distinguishes "sendable" from "blocked". A status the
 * operator cannot act on (submitting/submitted/result_ready/bound/failed) is blocked
 * with the real status named, so it can never be sent twice.
 */
export function frameReviewFromWire(value: unknown): FrameReview {
  const view = record(value);
  const reviewId = text(view.reviewId);
  const projectId = text(view.projectId);
  const shotId = text(view.shotId);
  if (!reviewId || !projectId || !shotId) throw malformed('frame review');
  const status = text(view.status);
  if (!(REVIEW_STATUSES as readonly string[]).includes(status)) throw malformed('frame review status');
  const role = text(view.role) as FrameRole;
  if (!ROLES.includes(role)) throw malformed('frame review role');
  const blockers = blockersOf(view.blockers);
  const sendable = SENDABLE.has(status) && blockers.length === 0;
  return {
    reviewId, projectId, shotId,
    expectedRevision: typeof view.expectedRevision === 'number' ? view.expectedRevision : 0,
    role,
    prompt: text(view.prompt),
    modelId: text(view.modelId),
    aspectRatio: text(view.aspectRatio),
    sourceAssetId: typeof view.sourceAssetId === 'string' ? view.sourceAssetId : null,
    requestHash: text(view.requestHash),
    status: sendable ? 'ready' : 'blocked',
    blockers: sendable ? blockers : blockers.length ? blockers : [`The server reports “${status}”; this review cannot be sent again.`],
    // Unknown stays null. Never coerced to 0 or a made-up quote.
    estimateUsd: typeof view.estimateUsd === 'number' && Number.isFinite(view.estimateUsd) && view.estimateUsd >= 0 ? view.estimateUsd : null,
  };
}

export function frameResultFromWire(value: unknown): { assetId: string; projectId: string; reviewId: string; mimeType: string; width: number; height: number; sha256: string } {
  const view = record(value);
  const assetId = text(view.assetId);
  const projectId = text(view.projectId);
  const reviewId = text(view.reviewId);
  const sha256 = text(view.sha256);
  if (!assetId || !projectId || !reviewId || !sha256) throw malformed('frame result');
  return {
    assetId, projectId, reviewId,
    mimeType: text(view.mimeType),
    width: typeof view.width === 'number' ? view.width : 0,
    height: typeof view.height === 'number' ? view.height : 0,
    sha256,
  };
}

/**
 * Derives the panel's submission state from the server's review status plus the
 * returned result view. No progress percentage, stage label or asset id is invented.
 */
export function submissionFromWire(review: FrameReview, result: { assetId: string } | null): FrameSubmission {
  const base: FrameSubmission = {
    // A still-image review has no provider attempt id. The stored review id is the
    // only real handle the routes expose, so the panel's "Check status" re-reads it.
    attemptId: review.reviewId,
    reviewId: review.reviewId,
    shotId: review.shotId,
    status: 'acceptance_unknown',
    assetId: null,
    stage: null,
    progress: null,
    errorCode: null,
    message: null,
  };
  if (result) return { ...base, status: 'succeeded', assetId: result.assetId };
  const blocked = review.blockers.map(blocker => typeof blocker === 'string' ? blocker : blocker.message).join(' ');
  const code = review.blockers.flatMap(blocker => typeof blocker === 'string' ? [] : [blocker.code])[0] ?? null;
  // A review the panel may not send again carries the server's own status inside the
  // blocker frameReviewFromWire synthesised, so the real status is never discarded.
  const declared = (review as { status: string }).status;
  const reported = /“([a-z_]+)”/.exec(blocked)?.[1]
    // A caller holding the raw wire view reports the server status directly.
    ?? (declared !== 'ready' && declared !== 'blocked' ? declared : null);
  if (reported === 'submitting' || reported === 'submitted') return { ...base, status: 'running', stage: reported };
  if (reported === 'acceptance_unknown') {
    return { ...base, status: 'acceptance_unknown', errorCode: 'ACCEPTANCE_UNKNOWN', message: 'The server could not confirm whether the provider accepted this request. Nothing is retried automatically.' };
  }
  if (reported === 'failed') return { ...base, status: 'failed', errorCode: code ?? 'GENERATION_FAILED', message: blocked || 'Generation failed.' };
  if (reported) {
    // "result_ready"/"bound" with no result view, or any status this client cannot act
    // on: fail closed and offer no retry rather than claim success or progress.
    return {
      ...base,
      status: 'acceptance_unknown',
      errorCode: 'RESULT_NOT_RETURNED',
      message: `The server reports “${reported}” but returned no result. Nothing was retried; check the stored state.`,
    };
  }
  if (review.status === 'blocked') {
    return { ...base, status: 'failed', errorCode: code ?? 'REQUEST_BLOCKED', message: blocked || 'The server blocked this request.' };
  }
  // pending/approved: not submitted, so no state is claimed.
  return base;
}

export function proposalFromWire(value: unknown): ComposerProposal {
  const view = record(value);
  const id = text(view.id);
  if (!id) throw malformed('storyboard proposal');
  const status = text(view.status);
  if (!['draft', 'applying', 'applied', 'partial', 'unknown', 'cancelled'].includes(status)) throw malformed('storyboard proposal status');
  const items = Array.isArray(view.items) ? view.items.map(item => {
    const entry = record(item);
    const itemId = text(entry.itemId);
    if (!itemId) throw malformed('storyboard cut');
    const state = text(entry.state);
    return {
      itemId,
      title: text(entry.title),
      direction: text(entry.direction),
      startDescription: text(entry.startDescription),
      endDescription: text(entry.endDescription),
      durationSeconds: typeof entry.durationSeconds === 'number' ? entry.durationSeconds : 0,
      continuityNotes: text(entry.continuityNotes),
      state: (['pending', 'created', 'failed', 'unknown'].includes(state) ? state : 'unknown') as ComposerProposal['items'][number]['state'],
      shotId: typeof entry.shotId === 'string' ? entry.shotId : null,
    };
  }) : [];
  const failure = record(view.failure);
  return {
    id,
    status: status as ComposerProposal['status'],
    revision: typeof view.revision === 'number' ? view.revision : 0,
    items,
    failure: typeof failure.message === 'string' ? { itemId: text(failure.itemId), code: text(failure.code), message: failure.message } : null,
  };
}

export function continueShotFromWire(value: unknown): ContinueShotOutcome {
  const view = record(value);
  const operationId = text(view.operationId);
  const projectId = text(view.projectId);
  const status = text(view.status);
  if (!operationId || !projectId || !['completed', 'partial', 'blocked'].includes(status)) throw malformed('continue-shot outcome');
  const ids = record(view.commandIds);
  const lineage = record(view.lineage);
  return {
    operationId, projectId,
    status: status as ContinueShotOutcome['status'],
    resumed: view.resumed === true,
    sourceTakeId: text(view.sourceTakeId),
    sourceShotId: text(view.sourceShotId),
    sourceAssetId: text(view.sourceAssetId),
    sourceAssetSha256: text(view.sourceAssetSha256),
    extractedAssetId: typeof view.extractedAssetId === 'string' ? view.extractedAssetId : null,
    shotId: typeof view.shotId === 'string' ? view.shotId : null,
    shotRevision: typeof view.shotRevision === 'number' ? view.shotRevision : null,
    firstFrameAssetId: typeof view.firstFrameAssetId === 'string' ? view.firstFrameAssetId : null,
    lastFrameAssetId: typeof view.lastFrameAssetId === 'string' ? view.lastFrameAssetId : null,
    nextStep: (['extract', 'create', 'bind', 'done'].includes(text(view.nextStep)) ? text(view.nextStep) : 'done') as ContinueShotOutcome['nextStep'],
    commandIds: { shotCreate: text(ids.shotCreate), shotBind: text(ids.shotBind) },
    lineage: {
      sourceTakeId: text(lineage.sourceTakeId), sourceShotId: text(lineage.sourceShotId),
      sourceAssetId: text(lineage.sourceAssetId), sourceAssetSha256: text(lineage.sourceAssetSha256),
      extractedAssetId: text(lineage.extractedAssetId),
    },
    code: typeof view.code === 'string' ? view.code : null,
    message: typeof view.message === 'string' ? view.message : null,
    resumable: view.resumable === true,
  };
}

const CONTINUATION_STATUSES = ['completed', 'partial', 'blocked', 'in_progress', 'unknown'] as const;
const CONTINUATION_STEPS = ['extract', 'create', 'bind', 'done', 'reconcile'] as const;

/**
 * Strict decoder for the minimal public continuation view. A status, identity or availability flag
 * this client does not understand is malformed, not "probably fine": the panel never guesses
 * completion or offers a resume the server did not authorize.
 */
export function continuationFromWire(value: unknown): ContinueShotPublicView {
  const view = record(value);
  const operationId = text(view.operationId);
  const projectId = text(view.projectId);
  if (!operationId || !projectId) throw malformed('continuation identity');
  const status = text(view.status);
  if (!(CONTINUATION_STATUSES as readonly string[]).includes(status)) throw malformed('continuation status');
  const nextStep = text(view.nextStep);
  if (!(CONTINUATION_STEPS as readonly string[]).includes(nextStep)) throw malformed('continuation step');
  if (typeof view.resumable !== 'boolean' || typeof view.active !== 'boolean') throw malformed('continuation availability');
  const sourceTakeId = text(view.sourceTakeId);
  const sourceShotId = text(view.sourceShotId);
  const sourceAssetId = text(view.sourceAssetId);
  if (!sourceTakeId || !sourceShotId || !sourceAssetId) throw malformed('continuation lineage');
  const blockers = Array.isArray(view.blockers) && view.blockers.every((item): item is string => typeof item === 'string')
    ? [...view.blockers] : [];
  return {
    operationId, projectId,
    status: status as ContinueShotPublicView['status'],
    resumable: view.resumable,
    active: view.active,
    sourceTakeId, sourceShotId, sourceAssetId,
    extractedAssetId: typeof view.extractedAssetId === 'string' ? view.extractedAssetId : null,
    shotId: typeof view.shotId === 'string' ? view.shotId : null,
    shotRevision: typeof view.shotRevision === 'number' && Number.isInteger(view.shotRevision) && view.shotRevision >= 0 ? view.shotRevision : null,
    nextStep: nextStep as ContinueShotPublicView['nextStep'],
    blockers,
    message: typeof view.message === 'string' ? view.message : null,
    updatedAt: text(view.updatedAt),
  };
}

export function createAuthoringApi(fetcher: typeof fetch = globalThis.fetch.bind(globalThis)): AuthoringPort {
  async function call(path: string, init?: RequestInit, options: { unknownAcceptance?: boolean } = {}): Promise<unknown> {
    const unknownAcceptance = options.unknownAcceptance === true;
    let response: Response;
    try {
      response = await fetcher(path, {
        // Same-origin only: the existing actor/Host/Origin policy authorizes this call.
        // No bearer key, provider URL or raw provider body is ever added here.
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        ...init,
        headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
      });
    } catch {
      throw new AuthoringApiError('CONNECTION_LOST', 'Could not reach Flume. Check the local service, then try again.', { outcomeUnknown: unknownAcceptance });
    }
    let body: unknown = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      const error = record(body);
      throw new AuthoringApiError(
        typeof error.code === 'string' ? error.code : `HTTP_${response.status}`,
        typeof error.message === 'string' ? error.message : 'The authoring request was refused.',
        {
          status: response.status,
          ...(typeof error.currentRevision === 'number' ? { currentRevision: error.currentRevision } : {}),
          // A 5xx on a mutating request may have been applied before it failed.
          outcomeUnknown: unknownAcceptance && response.status >= 500,
        },
      );
    }
    if (body === null) throw new AuthoringApiError('EMPTY_RESPONSE', 'The server answered without a readable body.', { status: response.status, outcomeUnknown: unknownAcceptance });
    return body;
  }

  const post = (path: string, payload: unknown, options?: { unknownAcceptance?: boolean }) =>
    call(path, { method: 'POST', body: JSON.stringify(payload) }, options);
  const query = (projectId: string) => `?projectId=${encodeURIComponent(projectId)}`;

  return {
    async capabilities() {
      const body = record(await call('/api/authoring/capabilities'));
      const models = Array.isArray(body.imageModels) ? body.imageModels.map(entry => {
        const model = record(entry);
        const availability = text(model.availability);
        return {
          modelId: text(model.modelId),
          name: text(model.name),
          aspectRatios: Array.isArray(model.aspectRatios) ? model.aspectRatios.filter((ratio): ratio is string => typeof ratio === 'string') : [],
          frameRoles: (Array.isArray(model.frameRoles) ? model.frameRoles.filter((role): role is FrameRole => ROLES.includes(role as FrameRole)) : []),
          // An absent or unrecognised availability is unknown, never available.
          availability: (['available', 'blocked', 'unknown'].includes(availability) ? availability : 'unknown') as FrameModel['availability'],
          blocker: typeof model.blocker === 'string' ? model.blocker : null,
        };
      }).filter(model => model.modelId !== '') : [];
      const storyboard = record(body.storyboard);
      return {
        imageModels: models,
        storyboard: {
          // Availability is only true when the server says so.
          available: storyboard.available === true,
          blocker: typeof storyboard.blocker === 'string' ? storyboard.blocker : null,
        },
      };
    },

    async createFrameReview(draft) {
      return frameReviewFromWire(await post('/api/frame-reviews', draft));
    },

    async readFrameReview(reviewId, projectId) {
      const body = record(await call(`/api/frame-reviews/${encodeURIComponent(reviewId)}${query(projectId)}`));
      const review = frameReviewFromWire(body.review);
      const result = body.result ? frameResultFromWire(body.result) : null;
      return { review, submission: submissionFromWire(review, result) };
    },

    async generateFrame(reviewId, input) {
      const body = record(await post(`/api/frame-reviews/${encodeURIComponent(reviewId)}/generate`, input, { unknownAcceptance: true }));
      const review = frameReviewFromWire(body.review);
      const result = body.result ? frameResultFromWire(body.result) : null;
      return { review, submission: submissionFromWire(review, result) };
    },

    async importFrameResult(reviewId, projectId) {
      const result = frameResultFromWire(await post(`/api/frame-reviews/${encodeURIComponent(reviewId)}/import`, { projectId }, { unknownAcceptance: true }));
      return {
        // The import handle is the stored review; there is no video take inspection here.
        inspectionId: reviewId,
        assetId: result.assetId,
        mimeType: result.mimeType,
        width: result.width,
        height: result.height,
        sha256: result.sha256,
        // Owned media only. The panel re-validates same-origin before rendering.
        mediaUrl: `/api/media/${encodeURIComponent(result.assetId)}`,
      };
    },

    async bindFrame(reviewId, input) {
      const body = record(await post(`/api/frame-reviews/${encodeURIComponent(reviewId)}/bind`, {
        projectId: input.projectId, shotId: input.shotId, role: input.role, assetId: input.assetId, expectedRevision: input.expectedRevision,
      }, { unknownAcceptance: true }));
      const role = text(body.role) as FrameRole;
      const shotId = text(body.shotId);
      const assetId = text(body.assetId);
      if (!ROLES.includes(role) || !shotId || !assetId || typeof body.revision !== 'number') throw malformed('binding receipt');
      return { shotId, assetId, role, revision: body.revision };
    },

    async createProposal(input) {
      return proposalFromWire(await post('/api/storyboard-proposals', input));
    },

    async readProposal(proposalId, projectId) {
      const body = record(await call(`/api/storyboard-proposals/${encodeURIComponent(proposalId)}${query(projectId)}`));
      if (body.id !== proposalId || body.projectId !== projectId) throw malformed('storyboard proposal identity');
      return proposalFromWire(body);
    },

    async reviseProposal(proposalId, input) {
      return proposalFromWire(await post(`/api/storyboard-proposals/${encodeURIComponent(proposalId)}/edit`, input));
    },

    async acceptProposal(proposalId, input) {
      return proposalFromWire(await post(`/api/storyboard-proposals/${encodeURIComponent(proposalId)}/accept`, input, { unknownAcceptance: true }));
    },

    async resumeProposal(proposalId, input) {
      return proposalFromWire(await post(`/api/storyboard-proposals/${encodeURIComponent(proposalId)}/resume`, input, { unknownAcceptance: true }));
    },

    async cancelProposal(proposalId, input) {
      return proposalFromWire(await post(`/api/storyboard-proposals/${encodeURIComponent(proposalId)}/cancel`, input));
    },

    async continueShot(input) {
      return continueShotFromWire(await post('/api/continue-shot', input, { unknownAcceptance: true }));
    },

    async readContinuation(operationId, projectId) {
      // GET only: a recovery read must never fall back to the mutating route.
      const view = continuationFromWire(await call(`/api/continue-shot/${encodeURIComponent(operationId)}${query(projectId)}`));
      if (view.operationId !== operationId || view.projectId !== projectId) throw malformed('continuation identity');
      return view;
    },

    async resumeContinuation(operationId, projectId) {
      // Identity only; the server replays the frozen prompt/title/take from its journal.
      return continueShotFromWire(await post(`/api/continue-shot/${encodeURIComponent(operationId)}/resume`, { projectId }, { unknownAcceptance: true }));
    },
  };
}
