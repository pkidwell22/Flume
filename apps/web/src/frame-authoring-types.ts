// Callback port for the native frame authoring panel. These callbacks map onto the
// dedicated Wave 2 image-authoring routes (/api/frame-reviews ...). They are NOT the
// video commands generation.prepare / generation.submit / take.inspect / attempt.resume,
// and no cancellation route exists for a still-image review. Nothing here reaches a
// provider: the component only renders operator intent and server-returned facts.

export type FrameRole = 'first_frame' | 'last_frame';
export const FRAME_ROLES: readonly FrameRole[] = ['first_frame', 'last_frame'];

export function roleLabel(role: FrameRole): string {
  return role === 'first_frame' ? 'Start frame' : 'End frame';
}

/** Lower-case noun used in sentences ("bind to start frame"). */
export function roleNoun(role: FrameRole): string {
  return role === 'first_frame' ? 'start frame' : 'end frame';
}

export type FrameAvailability = 'available' | 'blocked' | 'unknown';

/** Injected capability. Availability is authoritative; absence of an estimate is not zero. */
export interface FrameModel {
  modelId: string;
  name: string;
  aspectRatios: string[];
  frameRoles: FrameRole[];
  availability: FrameAvailability;
  blocker: string | null;
}

/** A project-owned image that may condition the generation (variation). */
export interface FrameSourceAsset {
  assetId: string;
  filename: string;
  width: number;
  height: number;
  mediaUrl: string;
  sha256?: string;
}

export interface FrameBindings {
  firstFrameAssetId: string | null;
  lastFrameAssetId: string | null;
}

export interface FrameAuthoringDraft {
  projectId: string;
  shotId: string;
  expectedRevision: number;
  role: FrameRole;
  prompt: string;
  modelId: string;
  aspectRatio: string;
  sourceAssetId: string | null;
}

export interface FrameBlocker {
  code: string;
  message: string;
}

export interface FrameReview {
  reviewId: string;
  projectId: string;
  shotId: string;
  expectedRevision: number;
  role: FrameRole;
  prompt: string;
  modelId: string;
  aspectRatio: string;
  sourceAssetId: string | null;
  requestHash: string;
  status: 'ready' | 'blocked';
  blockers: Array<FrameBlocker | string>;
  /** Server estimate. null means unknown, never free. */
  estimateUsd: number | null;
}

export type FrameSubmissionStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'acceptance_unknown'
  | 'cancelled';

export interface FrameSubmission {
  attemptId: string;
  reviewId: string;
  shotId: string;
  status: FrameSubmissionStatus;
  assetId: string | null;
  stage: string | null;
  progress: number | null;
  errorCode: string | null;
  message: string | null;
}

export interface FrameInspection {
  inspectionId: string;
  assetId: string;
  mimeType: string;
  width: number;
  height: number;
  sha256: string;
  /** Must be an owned /api/media/ route; anything else cannot be bound. */
  mediaUrl: string | null;
}

export interface FrameBindingReceipt {
  assetId: string;
  shotId: string;
  role: FrameRole;
  revision: number;
}

export interface FrameBindInput {
  projectId: string;
  shotId: string;
  role: FrameRole;
  assetId: string;
  inspectionId: string;
  expectedRevision: number;
}

export interface FrameApprovalLimits {
  maxAttempts: number;
  maxCostUsd: string;
}

/** Preparation is read-only; the signal lets the operator withdraw a pending review. */
export interface FramePrepareOptions {
  signal: AbortSignal;
}

export interface FrameAuthoringProps {
  projectId: string;
  shotId: string;
  expectedRevision: number;
  bindings: FrameBindings;
  models: FrameModel[];
  sourceAssets: FrameSourceAsset[];
  initialRole?: FrameRole;
  busy?: boolean;
  onPrepareReview(draft: FrameAuthoringDraft, options?: FramePrepareOptions): Promise<FrameReview>;
  /** One explicit operator action: approval plus the single submit that follows it. */
  onApproveAndGenerate(review: FrameReview, limits: FrameApprovalLimits): Promise<FrameSubmission>;
  onCheckSubmission(attemptId: string): Promise<FrameSubmission>;
  onCancelSubmission?(attemptId: string): Promise<FrameSubmission>;
  onInspectResult(assetId: string): Promise<FrameInspection>;
  onBindFrame(input: FrameBindInput): Promise<FrameBindingReceipt>;
}

/** Mirrors apps/web/src/shell.ts ownedMediaUrl: only same-origin project media is renderable. */
export function safeFrameMediaUrl(
  mediaUrl: string | null | undefined,
  origin = typeof window === 'undefined' ? 'http://flume.local' : window.location.origin,
): string | undefined {
  if (!mediaUrl) return undefined;
  try {
    const url = new URL(mediaUrl, origin);
    return url.origin === origin && !url.username && !url.password && url.pathname.startsWith('/api/media/')
      ? `${url.pathname}${url.search}`
      : undefined;
  } catch {
    return undefined;
  }
}

/** Non-negative USD digits with an optional decimal part; no exponent, sign or separators. */
export function isMoney(value: string): boolean {
  return /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(value);
}

export function blockerText(blocker: FrameBlocker | string): string {
  return typeof blocker === 'string' ? blocker : blocker.message;
}
