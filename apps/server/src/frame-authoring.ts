/**
 * Review / approval / submission / result / bind service for image frame authoring.
 *
 * Invariants enforced here (not by callers):
 *  - a review is created once and never rewritten; approval re-verifies its exact hash;
 *  - approval and submission are operator actions; agents may draft and read only;
 *  - one submission per approved review, no retry after an unknown acceptance;
 *  - a result enters owned media only through an explicit call that re-verifies bytes;
 *  - binding is explicit, role-checked, optimistically revision-checked and never clears the
 *    opposite frame or auto-binds.
 *
 * Ports (store/media/provider) are injected. Nothing here reads env, URLs or provider credentials.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const FRAME_AUTHORING_STATUSES = ['pending', 'blocked', 'approved', 'submitting', 'submitted', 'result_ready', 'bound', 'failed', 'acceptance_unknown'] as const;
export type FrameReviewStatus = typeof FRAME_AUTHORING_STATUSES[number];
export const FRAME_ROLES = ['first_frame', 'last_frame'] as const;
export type FrameRole = typeof FRAME_ROLES[number];
export const FRAME_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type FrameImageMime = typeof FRAME_IMAGE_MIME_TYPES[number];
export const MAX_FRAME_PROMPT_CHARS = 8000;
export const MAX_FRAME_REFERENCE_BYTES = 10 * 1024 * 1024;
export const MAX_FRAME_RESULT_BYTES = 12 * 1024 * 1024;
export const MAX_FRAME_RESULT_PIXELS = 40_000_000;

export class FrameAuthoringError extends Error {
  readonly code: string;
  readonly status: number;
  readonly currentRevision?: number;
  readonly details?: unknown;
  constructor(code: string, message: string, status = 409, currentRevision?: number, details?: unknown) {
    super(message);
    this.name = 'FrameAuthoringError';
    this.code = code;
    this.status = status;
    this.currentRevision = currentRevision;
    this.details = details;
  }
}

const Id = z.string().uuid();
/** Shot revision. Mirrors the durable CHECK (shot_revision > 0): revision 0 is never a valid shot. */
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ModelId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/);
const AspectRatio = z.string().regex(/^\d{1,2}:\d{1,2}$/);
const Sha256 = /^[0-9a-f]{64}$/;
const CODE = /^[a-z0-9_]{1,64}$/;

const ActorSchema = z.strictObject({
  id: Id, kind: z.enum(['operator', 'agent']), projectIds: z.union([z.literal('*'), z.array(Id).max(1000)]),
});
export type Actor = z.infer<typeof ActorSchema>;

const DraftSchema = z.strictObject({
  projectId: Id, shotId: Id, expectedRevision: Revision, role: z.enum(FRAME_ROLES),
  prompt: z.string().min(1).max(MAX_FRAME_PROMPT_CHARS).refine(value => value.trim().length > 0),
  modelId: ModelId, aspectRatio: AspectRatio, sourceAssetId: Id.nullable().optional(),
}).strict();
export type FrameDraftInput = z.infer<typeof DraftSchema>;

export interface FrameBlocker { code: string; message: string }
export interface FrameEnvelope { provider: 'openrouter'; modelId: string; body: string; bodySha256: string }
export interface FrameCapability {
  modelId: string; name: string; aspectRatios?: string[];
  availability: 'available' | 'blocked' | 'unknown'; blocker: string | null;
}
export interface FrameOutput { mimeType: FrameImageMime; width: number; height: number; sha256: string; byteSize: number }
export interface FrameImageContent { mimeType: FrameImageMime; width: number; height: number; sha256: string; bytes: Uint8Array }

export interface FrameReviewView {
  reviewId: string; projectId: string; shotId: string; expectedRevision: number; role: FrameRole;
  prompt: string; modelId: string; aspectRatio: string; sourceAssetId: string | null;
  requestHash: string; status: FrameReviewStatus; blockers: FrameBlocker[]; estimateUsd: number | null;
}
export interface FrameResultView {
  assetId: string; projectId: string; reviewId: string; mimeType: FrameImageMime; width: number; height: number; sha256: string;
}
export interface FrameBindings { firstFrameAssetId: string | null; lastFrameAssetId: string | null }
export interface FrameBindingView {
  projectId: string; shotId: string; revision: number; role: FrameRole; assetId: string; bindings: FrameBindings;
}
export interface FrameReviewRecord extends FrameReviewView {
  sourceAssetSha256: string | null;
  envelope: FrameEnvelope | null;
  createdBy: string; createdByKind: 'operator' | 'agent';
  approvedBy: string | null;
  /** Operator-approved spend ceiling for this exact review; null means no ceiling was approved. */
  approvedMaxCostUsd?: number | null;
  resultAssetId: string | null; output: FrameOutput | null;
  providerModelId: string | null; providerReceiptId: string | null; errorCode: string | null;
}
export interface FrameResultRow extends FrameResultView {
  shotId: string; byteSize: number; sourceAssetId: string | null;
  providerModelId: string; providerReceiptId: string | null; importedBy: string;
}
export interface FrameShotSnapshot { id: string; revision: number; bindings: FrameBindings }
export interface FrameOwnedAsset {
  id: string; projectId: string; kind: 'image' | 'video'; sha256: string; mimeType: string; byteSize: number;
}

export interface FrameTransitionPatch {
  approvedBy?: string; approvedMaxCostUsd?: number | null; errorCode?: string | null; output?: FrameOutput | null;
  providerModelId?: string | null; providerReceiptId?: string | null; resultAssetId?: string | null;
}

/**
 * Durable result-import claim. `claimed` means this exact import intent owns the write for the
 * review; `in_progress` means a different intent already owns it and this caller must not write
 * owned media; `already_imported` carries the recorded result; `unavailable` means the claim
 * state could not be read (fail closed rather than guessing).
 */
export interface FrameImportClaim {
  status: 'claimed' | 'in_progress' | 'already_imported' | 'unavailable';
  assetId: string | null;
  result: FrameResultView | null;
}

/** Durable port. Implementations must make each call atomic; reviews are insert-only in identity. */
export interface FrameAuthoringStore {
  getShot(projectId: string, shotId: string): Promise<FrameShotSnapshot | null>;
  getAsset(projectId: string, assetId: string): Promise<FrameOwnedAsset | null>;
  insertReview(record: FrameReviewRecord): Promise<void>;
  getReview(projectId: string, reviewId: string): Promise<FrameReviewRecord | null>;
  findResult(projectId: string, reviewId: string): Promise<FrameResultView | null>;
  /** Compare-and-set on status. Returns the updated review or null when the precondition failed. */
  transition(args: { projectId: string; reviewId: string; from: FrameReviewStatus[]; to: FrameReviewStatus; patch?: FrameTransitionPatch }): Promise<FrameReviewRecord | null>;
  /** False when a result already exists for this review. */
  insertResult(row: FrameResultRow): Promise<boolean>;
  /**
   * Atomically claim the single import for a review before any owned-media write. The claim is
   * durable so a process loss cannot silently authorize a second asset: only an identical intent
   * (same derived asset id and sha256) may resume, anything else is refused.
   */
  claimResultImport(args: {
    projectId: string; reviewId: string; assetId: string; sha256: string; actorId: string;
  }): Promise<FrameImportClaim>;
  /** Mark a claim imported once the result row and review transition are durable. Best effort. */
  completeResultImport(args: { projectId: string; reviewId: string; assetId: string }): Promise<void>;
  /** Atomic shot bind + review transition + audit append. Null when revision/state preconditions failed. */
  bindFrame(args: {
    projectId: string; shotId: string; expectedRevision: number; role: FrameRole;
    assetId: string; reviewId: string; actorId: string;
  }): Promise<{ revision: number; bindings: FrameBindings; review: FrameReviewRecord } | null>;
}

/** Media boundary: owned bytes only; this service never resolves or accepts URLs. */
export interface FrameMediaPort {
  readOwned(input: { projectId: string; assetId: string }): Promise<Uint8Array>;
  importOwned(input: { id: string; projectId: string; filename: string; mimeType: FrameImageMime; bytes: Uint8Array }): Promise<FrameOwnedAsset & { width: number; height: number }>;
}

/**
 * Durable result-byte staging. Implementations must persist the exact accepted provider bytes
 * bound to one project/review identity before a review reports success, and verify the recorded
 * hash again on read. Staging references never leave the server.
 */
export interface FrameResultStagingPort {
  stage(input: { projectId: string; reviewId: string; mimeType: FrameImageMime; sha256: string; bytes: Uint8Array }): Promise<{ ref: string }>;
  read(input: { projectId: string; reviewId: string; mimeType: FrameImageMime; sha256: string; byteSize: number }): Promise<Uint8Array>;
  discard?(input: { projectId: string; reviewId: string }): Promise<void>;
}

export interface FrameReference { assetId: string; sha256: string; mimeType: FrameImageMime; bytes: Uint8Array }
export interface FramePrepared {
  envelope: FrameEnvelope | null; estimateUsd: string | null; blockers: FrameBlocker[];
}
export type FrameSubmission =
  | { status: 'accepted'; receipt: { providerModelId: string; providerReceiptId: string | null; costUsd: string | null }; image: { mimeType: string; width: number; height: number; sha256: string; bytes: Uint8Array } }
  | { status: 'blocked' | 'failed' | 'acceptance_unknown'; error: { code: string; message?: string } };
export interface FrameProviderPort {
  capabilities(): Promise<FrameCapability[]>;
  prepare(input: { role: FrameRole; prompt: string; modelId: string; aspectRatio: string; reference: FrameReference | null }): Promise<FramePrepared>;
  submit(envelope: FrameEnvelope, call?: { signal?: AbortSignal }): Promise<FrameSubmission>;
}

export interface FrameAuthoringServiceOptions {
  store: FrameAuthoringStore;
  media: FrameMediaPort;
  provider: FrameProviderPort;
  /** Required in production wiring: accepted bytes are staged before success is reported. */
  staging?: FrameResultStagingPort;
  ids?: { reviewId?: () => string; assetId?: () => string };
  clock?: () => Date;
}

export interface FrameSubmitOutcome {
  review: FrameReviewView;
  image: FrameImageContent | null;
  error: { code: string; status: 'failed' | 'acceptance_unknown' | 'blocked' } | null;
}

const sha256Bytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value as Record<string, unknown>).sort()
      .map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function frameAuthoringRequestHash(input: {
  role: FrameRole; prompt: string; modelId: string; aspectRatio: string;
  sourceAssetId: string | null; sourceAssetSha256: string | null; envelopeSha256: string | null;
}): string {
  return createHash('sha256').update(canonicalJson({
    aspectRatio: input.aspectRatio, envelopeSha256: input.envelopeSha256 ?? null, modelId: input.modelId,
    prompt: input.prompt, role: input.role, sourceAssetId: input.sourceAssetId ?? null,
    sourceAssetSha256: input.sourceAssetSha256 ?? null,
  })).digest('hex');
}

/**
 * Stable owned-media identity for one review result. The id is derived from the immutable review
 * identity plus the verified output hash, so a replayed import of the same bytes targets the same
 * asset row instead of allocating a second, unreferenced one.
 */
export function frameResultAssetId(input: { projectId: string; reviewId: string; sha256: string }): string {
  const digest = createHash('sha256')
    .update(`frame-result\u0000${input.projectId.toLowerCase()}\u0000${input.reviewId.toLowerCase()}\u0000${input.sha256}`)
    .digest('hex')
    .split('');
  digest[12] = '4';
  digest[16] = '89ab'[Number.parseInt(digest[16]!, 16) & 0x3]!;
  const hex = digest.slice(0, 32).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function toReviewView(record: FrameReviewRecord): FrameReviewView {
  return Object.freeze({
    reviewId: record.reviewId, projectId: record.projectId, shotId: record.shotId,
    expectedRevision: record.expectedRevision, role: record.role, prompt: record.prompt,
    modelId: record.modelId, aspectRatio: record.aspectRatio, sourceAssetId: record.sourceAssetId,
    requestHash: record.requestHash, status: record.status,
    blockers: record.blockers.map(({ code, message }) => ({ code, message })), estimateUsd: record.estimateUsd,
  });
}
const toResultView = (row: FrameResultView): FrameResultView => Object.freeze({
  assetId: row.assetId, projectId: row.projectId, reviewId: row.reviewId,
  mimeType: row.mimeType, width: row.width, height: row.height, sha256: row.sha256,
});

function authorize(actor: Actor, projectId: string) {
  if (actor.projectIds !== '*' && !actor.projectIds.some(id => id.toLowerCase() === projectId.toLowerCase())) {
    throw new FrameAuthoringError('FORBIDDEN', 'Project access is not granted.', 403);
  }
}
function requireOperator(actor: Actor, code: string) {
  if (actor.kind !== 'operator') throw new FrameAuthoringError(code, 'This action requires an explicit operator decision.', 403);
}
function parseOr<T>(schema: z.ZodType<T>, value: unknown, code: string, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new FrameAuthoringError(code, message, 400);
  return parsed.data;
}

/** Magic-byte inspection. Dimensions from bytes only; caller metadata is never trusted. */
function inspectImage(bytes: Uint8Array): { mimeType: FrameImageMime; width: number; height: number } | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_FRAME_RESULT_BYTES) return null;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG' && buffer.toString('ascii', 12, 16) === 'IHDR') {
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
    return width > 0 && height > 0 && width * height <= MAX_FRAME_RESULT_PIXELS ? { mimeType: 'image/png', width, height } : null;
  }
  if (buffer.length >= 12 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    for (let offset = 2; offset + 9 < buffer.length && offset < 1024 * 1024; offset++) {
      if (buffer[offset] !== 0xff) continue;
      const marker = buffer[offset + 1]!;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        const height = buffer.readUInt16BE(offset + 5), width = buffer.readUInt16BE(offset + 7);
        return width > 0 && height > 0 && width * height <= MAX_FRAME_RESULT_PIXELS ? { mimeType: 'image/jpeg', width, height } : null;
      }
    }
    return null;
  }
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16);
    let width = 0, height = 0;
    if (chunk === 'VP8X') { width = 1 + buffer.readUIntLE(24, 3); height = 1 + buffer.readUIntLE(27, 3); }
    else if (chunk === 'VP8 ') { width = buffer.readUInt16LE(26) & 0x3fff; height = buffer.readUInt16LE(28) & 0x3fff; }
    else if (chunk === 'VP8L' && buffer[20] === 0x2f) { const bits = buffer.readUInt32LE(21); width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff); }
    return width > 0 && height > 0 && width * height <= MAX_FRAME_RESULT_PIXELS ? { mimeType: 'image/webp', width, height } : null;
  }
  return null;
}

function sanitizeBlocker(value: unknown, fallbackCode = 'provider_blocked'): FrameBlocker {
  const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const code = typeof record.code === 'string' && CODE.test(record.code) ? record.code : fallbackCode;
  const raw = typeof record.message === 'string' ? record.message : 'This image request is blocked. Review the configuration before retrying.';
  const message = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) || 'This image request is blocked.';
  return { code, message };
}

function sanitizeCapability(value: unknown): FrameCapability | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.modelId !== 'string' || !ModelId.safeParse(record.modelId).success) return null;
  const availability = record.availability === 'available' || record.availability === 'blocked' || record.availability === 'unknown' ? record.availability : 'unknown';
  const ratios = Array.isArray(record.aspectRatios)
    ? [...new Set(record.aspectRatios.filter(ratio => typeof ratio === 'string' && AspectRatio.safeParse(ratio).success) as string[])].slice(0, 24)
    : undefined;
  return {
    modelId: record.modelId,
    name: typeof record.name === 'string' && record.name.length > 0 ? record.name.slice(0, 200) : record.modelId,
    ...(ratios ? { aspectRatios: ratios } : {}),
    availability,
    blocker: typeof record.blocker === 'string' ? record.blocker.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) : null,
  };
}

/** Availability blockers come only from injected capability facts; absence is unknown, not available. */
function capabilityBlockers(modelId: string, aspectRatio: string, capabilities: FrameCapability[]): FrameBlocker[] {
  const capability = capabilities.find(candidate => candidate.modelId === modelId);
  if (!capability) return [{ code: 'model_unavailable', message: 'This image model is not configured as available on this server. No capability was inferred.' }];
  if (capability.availability === 'blocked') return [{ code: 'provider_blocked', message: 'The configured image route is blocked for this account. Editing remains available.' }];
  if (capability.availability !== 'available') return [{ code: 'model_availability_unknown', message: 'Image model availability is not confirmed. Nothing was submitted.' }];
  if (capability.aspectRatios && !capability.aspectRatios.includes(aspectRatio)) {
    return [{ code: 'unsupported_aspect_ratio', message: 'The selected image model does not declare this aspect ratio. Choose a supported ratio and review again.' }];
  }
  return [];
}

function estimateFrom(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Re-derive the review identity from persisted bytes before any spend or bind. */
function verifyReviewIntegrity(review: FrameReviewRecord): FrameEnvelope {
  if (!review.envelope || review.envelope.provider !== 'openrouter' || review.envelope.modelId !== review.modelId) {
    throw new FrameAuthoringError('REVIEW_INTEGRITY', 'The reviewed provider request is missing or inconsistent. Review this draft again.', 409);
  }
  const envelopeSha = sha256Bytes(Buffer.from(review.envelope.body, 'utf8'));
  if (envelopeSha !== review.envelope.bodySha256 || !Sha256.test(envelopeSha)) {
    throw new FrameAuthoringError('REVIEW_INTEGRITY', 'The reviewed provider bytes no longer match their hash. Review this draft again.', 409);
  }
  const recomputed = frameAuthoringRequestHash({
    role: review.role, prompt: review.prompt, modelId: review.modelId, aspectRatio: review.aspectRatio,
    sourceAssetId: review.sourceAssetId, sourceAssetSha256: review.sourceAssetSha256, envelopeSha256: envelopeSha,
  });
  if (recomputed !== review.requestHash) {
    throw new FrameAuthoringError('REVIEW_INTEGRITY', 'This review no longer matches its approved request. Create a new review.', 409);
  }
  return review.envelope;
}

export function createFrameAuthoringService(options: FrameAuthoringServiceOptions) {
  const { store, media, provider, staging } = options;
  const newReviewId = options.ids?.reviewId ?? (() => randomUUID());
  // Result asset ids are NOT injectable: they are derived from the review identity and verified
  // output hash (see frameResultAssetId) so a replayed import cannot allocate a second asset.
  void options.ids?.assetId;
  void options.clock;

  async function capabilities(): Promise<FrameCapability[]> {
    const raw = await provider.capabilities();
    if (!Array.isArray(raw)) throw new FrameAuthoringError('CAPABILITIES_UNAVAILABLE', 'Image model capabilities are unavailable.', 502);
    return raw.map(sanitizeCapability).filter((capability): capability is FrameCapability => capability !== null);
  }

  async function requireReview(actor: Actor, projectId: string, reviewId: string): Promise<FrameReviewRecord> {
    authorize(actor, projectId);
    const review = await store.getReview(projectId, reviewId);
    if (!review) throw new FrameAuthoringError('REVIEW_NOT_FOUND', 'Review not found.', 404);
    return review;
  }

  const service = {
    capabilities,

    async createReview(input: { actor: Actor; draft: unknown }): Promise<FrameReviewView> {
      const actor = parseOr(ActorSchema, input?.actor, 'FORBIDDEN', 'A valid actor is required.');
      const draft = parseOr(DraftSchema, input?.draft, 'INVALID_DRAFT', 'The frame draft is not valid. Provide project, shot, revision, role, prompt, model and aspect ratio.');
      authorize(actor, draft.projectId);
      const sourceAssetId = draft.sourceAssetId ?? null;
      const shot = await store.getShot(draft.projectId, draft.shotId);
      if (!shot) throw new FrameAuthoringError('SHOT_NOT_FOUND', 'Shot not found in this project.', 404);
      if (shot.revision !== draft.expectedRevision) {
        throw new FrameAuthoringError('REVISION_CONFLICT', 'This shot changed. Reload before drafting a frame.', 409, shot.revision);
      }

      const capabilityList = await capabilities();
      const blockers: FrameBlocker[] = capabilityBlockers(draft.modelId, draft.aspectRatio, capabilityList);

      let reference: FrameReference | null = null;
      let sourceSha256: string | null = null;
      if (sourceAssetId !== null) {
        const asset = await store.getAsset(draft.projectId, sourceAssetId);
        if (!asset) throw new FrameAuthoringError('SOURCE_ASSET_NOT_FOUND', 'Referenced source asset was not found in this project.', 404);
        if (asset.kind !== 'image') throw new FrameAuthoringError('SOURCE_ASSET_NOT_IMAGE', 'Only a project-owned image can condition frame generation.', 400);
        if (!FRAME_IMAGE_MIME_TYPES.includes(asset.mimeType as FrameImageMime)) throw new FrameAuthoringError('SOURCE_ASSET_UNSUPPORTED_MIME', 'The source asset encoding is not accepted.', 400);
        if (asset.byteSize <= 0 || asset.byteSize > MAX_FRAME_REFERENCE_BYTES) throw new FrameAuthoringError('SOURCE_ASSET_TOO_LARGE', 'The source image exceeds the reference byte limit.', 413);
        let bytes: Uint8Array;
        try { bytes = await media.readOwned({ projectId: draft.projectId, assetId: sourceAssetId }); }
        catch { throw new FrameAuthoringError('SOURCE_ASSET_UNAVAILABLE', 'Owned source bytes could not be read safely.', 409); }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== asset.byteSize || sha256Bytes(bytes) !== asset.sha256) {
          throw new FrameAuthoringError('SOURCE_ASSET_INTEGRITY', 'The source asset no longer matches its recorded hash. Re-import it before drafting.', 409);
        }
        const inspected = inspectImage(bytes);
        if (!inspected || inspected.mimeType !== asset.mimeType) {
          throw new FrameAuthoringError('SOURCE_ASSET_INTEGRITY', 'The source asset failed image inspection.', 409);
        }
        reference = { assetId: asset.id, sha256: asset.sha256, mimeType: asset.mimeType as FrameImageMime, bytes };
        sourceSha256 = asset.sha256;
      }

      let envelope: FrameEnvelope | null = null;
      let estimateUsd: number | null = null;
      if (blockers.length === 0) {
        let prepared: FramePrepared;
        try {
          prepared = await provider.prepare({ role: draft.role, prompt: draft.prompt, modelId: draft.modelId, aspectRatio: draft.aspectRatio, reference });
        } catch {
          prepared = { envelope: null, estimateUsd: null, blockers: [{ code: 'provider_request_unavailable', message: 'The reviewed request could not be compiled safely. Adjust the draft and review again.' }] };
        }
        for (const blocker of Array.isArray(prepared.blockers) ? prepared.blockers : []) blockers.push(sanitizeBlocker(blocker));
        estimateUsd = blockers.length === 0 ? estimateFrom(prepared.estimateUsd) : null;
        if (blockers.length === 0) {
          const candidate = prepared.envelope;
          if (!candidate || candidate.provider !== 'openrouter' || candidate.modelId !== draft.modelId) {
            blockers.push({ code: 'provider_envelope_unavailable', message: 'The provider did not return a reviewable request. Nothing was submitted.' });
          } else if (sha256Bytes(Buffer.from(candidate.body, 'utf8')) !== candidate.bodySha256 || !Sha256.test(candidate.bodySha256)) {
            blockers.push({ code: 'provider_envelope_integrity', message: 'The compiled provider request failed integrity checks. Nothing was submitted.' });
          } else {
            envelope = { provider: 'openrouter', modelId: candidate.modelId, body: candidate.body, bodySha256: candidate.bodySha256 };
          }
        }
      }

      const status: FrameReviewStatus = blockers.length > 0 ? 'blocked' : 'pending';
      const reviewId = newReviewId();
      const record: FrameReviewRecord = {
        reviewId, projectId: draft.projectId, shotId: draft.shotId, expectedRevision: draft.expectedRevision,
        role: draft.role, prompt: draft.prompt, modelId: draft.modelId, aspectRatio: draft.aspectRatio,
        sourceAssetId, sourceAssetSha256: sourceSha256,
        requestHash: frameAuthoringRequestHash({
          role: draft.role, prompt: draft.prompt, modelId: draft.modelId, aspectRatio: draft.aspectRatio,
          sourceAssetId, sourceAssetSha256: sourceSha256, envelopeSha256: envelope?.bodySha256 ?? null,
        }),
        status, blockers, estimateUsd, envelope,
        createdBy: actor.id, createdByKind: actor.kind,
        approvedBy: null, approvedMaxCostUsd: null, resultAssetId: null, output: null,
        providerModelId: null, providerReceiptId: null, errorCode: null,
      };
      await store.insertReview(record);
      return toReviewView(record);
    },

    async approve(input: { actor: Actor; projectId: string; reviewId: string }): Promise<FrameReviewView> {
      // A plain approval carries no spend ceiling; only approveAndSubmit records one.
      return toReviewView(await approveReview({ actor: input?.actor, projectId: input?.projectId, reviewId: input?.reviewId, approvedMaxCostUsd: null }));
    },

    async submit(input: { actor: Actor; projectId: string; reviewId: string }): Promise<FrameSubmitOutcome> {
      const actor = parseOr(ActorSchema, input?.actor, 'FORBIDDEN', 'A valid actor is required.');
      const projectId = parseOr(Id, input?.projectId, 'INVALID_REQUEST', 'A project id is required.');
      const reviewId = parseOr(Id, input?.reviewId, 'INVALID_REQUEST', 'A review id is required.');
      requireOperator(actor, 'SUBMISSION_REQUIRES_OPERATOR');
      const review = await requireReview(actor, projectId, reviewId);
      const envelope = verifyReviewIntegrity(review);
      const claimed = await store.transition({ projectId, reviewId, from: ['approved'], to: 'submitting' });
      if (!claimed) {
        const current = await store.getReview(projectId, reviewId);
        if (!current) throw new FrameAuthoringError('REVIEW_NOT_FOUND', 'Review not found.', 404);
        if (current.status === 'submitting') throw new FrameAuthoringError('SUBMISSION_IN_PROGRESS', 'This review is already being submitted. Wait for that submission to finish.', 409);
        if (current.status === 'acceptance_unknown') throw new FrameAuthoringError('ACCEPTANCE_UNKNOWN_NO_RETRY', 'Provider acceptance is unknown. Reconcile the original request; do not submit again.', 409);
        if (['submitted', 'result_ready', 'bound'].includes(current.status)) throw new FrameAuthoringError('REVIEW_ALREADY_SUBMITTED', 'This review already has a submission.', 409);
        if (current.status === 'blocked') throw new FrameAuthoringError('REVIEW_BLOCKED', 'Blocked reviews cannot be submitted.', 409);
        throw new FrameAuthoringError('REVIEW_NOT_APPROVED', 'Explicit operator approval is required before submission.', 409);
      }

      let submission: FrameSubmission;
      try { submission = await provider.submit(envelope); }
      catch { submission = { status: 'acceptance_unknown', error: { code: 'provider_acceptance_unknown' } }; }

      if (submission.status !== 'accepted') {
        const failure = submission.status;
        const code = typeof submission.error?.code === 'string' && CODE.test(submission.error.code) ? submission.error.code : 'provider_failed';
        const nextStatus: FrameReviewStatus = failure === 'acceptance_unknown' ? 'acceptance_unknown' : 'failed';
        const updated = await store.transition({ projectId, reviewId, from: ['submitting'], to: nextStatus, patch: { errorCode: code } });
        if (!updated) throw new FrameAuthoringError('REVIEW_STATE_LOST', 'The submission outcome could not be recorded. Hold this review and inspect it before any further action.', 409);
        return { review: toReviewView(updated), image: null, error: { code, status: failure } };
      }

      const image = submission.image;
      const inspected = image && image.bytes instanceof Uint8Array ? inspectImage(image.bytes) : null;
      const mimeOk = inspected !== null && FRAME_IMAGE_MIME_TYPES.includes(image.mimeType as FrameImageMime) && inspected.mimeType === image.mimeType;
      const dimsOk = inspected !== null && image.width === inspected.width && image.height === inspected.height && Number.isSafeInteger(image.width) && Number.isSafeInteger(image.height);
      const hashOk = image && typeof image.sha256 === 'string' && Sha256.test(image.sha256) && image.sha256 === sha256Bytes(image.bytes);
      if (!inspected || !mimeOk || !dimsOk || !hashOk || image.bytes.byteLength > MAX_FRAME_RESULT_BYTES) {
        const updated = await store.transition({ projectId, reviewId, from: ['submitting'], to: 'failed', patch: { errorCode: 'provider_output_invalid' } });
        if (!updated) throw new FrameAuthoringError('REVIEW_STATE_LOST', 'The submission outcome could not be recorded. Hold this review and inspect it before any further action.', 409);
        return { review: toReviewView(updated), image: null, error: { code: 'provider_output_invalid', status: 'failed' } };
      }
      const output: FrameOutput = { mimeType: inspected.mimeType, width: inspected.width, height: inspected.height, sha256: image.sha256, byteSize: image.bytes.byteLength };
      // Durable staging happens before any successful status is reported. If the exact bytes cannot
      // be staged, the review fails closed rather than promising an import that cannot happen.
      if (staging) {
        try {
          await staging.stage({ projectId, reviewId, mimeType: inspected.mimeType, sha256: image.sha256, bytes: image.bytes });
        } catch {
          const lost = await store.transition({ projectId, reviewId, from: ['submitting'], to: 'failed', patch: { errorCode: 'result_staging_failed' } });
          if (!lost) throw new FrameAuthoringError('REVIEW_STATE_LOST', 'The accepted image could not be staged durably and the review state changed. Hold this review and inspect it.', 409);
          return { review: toReviewView(lost), image: null, error: { code: 'result_staging_failed', status: 'failed' } };
        }
      }
      const receiptModel = typeof submission.receipt.providerModelId === 'string' && ModelId.safeParse(submission.receipt.providerModelId).success ? submission.receipt.providerModelId : envelope.modelId;
      const receiptId = typeof submission.receipt.providerReceiptId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(submission.receipt.providerReceiptId) ? submission.receipt.providerReceiptId : null;
      const updated = await store.transition({
        projectId, reviewId, from: ['submitting'], to: 'submitted',
        patch: { output, providerModelId: receiptModel, providerReceiptId: receiptId, errorCode: null },
      });
      if (!updated) throw new FrameAuthoringError('REVIEW_STATE_LOST', 'An accepted image could not be recorded against this review. Hold and inspect before any further action.', 409, undefined, { providerReceiptId: receiptId });
      return {
        review: toReviewView(updated),
        image: { mimeType: inspected.mimeType, width: inspected.width, height: inspected.height, sha256: image.sha256, bytes: image.bytes },
        error: null,
      };
    },

    async importResult(input: { actor: Actor; projectId: string; reviewId: string; mimeType: string; bytes: Uint8Array }): Promise<FrameResultView> {
      const actor = parseOr(ActorSchema, input?.actor, 'FORBIDDEN', 'A valid actor is required.');
      const projectId = parseOr(Id, input?.projectId, 'INVALID_REQUEST', 'A project id is required.');
      const reviewId = parseOr(Id, input?.reviewId, 'INVALID_REQUEST', 'A review id is required.');
      requireOperator(actor, 'IMPORT_REQUIRES_OPERATOR');
      const mimeType = input?.mimeType;
      if (typeof mimeType !== 'string' || !FRAME_IMAGE_MIME_TYPES.includes(mimeType as FrameImageMime)) {
        throw new FrameAuthoringError('INVALID_RESULT_IMPORT', 'A supported image mime type is required.', 400);
      }
      if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_FRAME_RESULT_BYTES) {
        throw new FrameAuthoringError('INVALID_RESULT_IMPORT', 'Result bytes must be a non-empty bounded image.', 400);
      }
      const review = await requireReview(actor, projectId, reviewId);
      const existing = await store.findResult(projectId, reviewId);
      if (existing) {
        const ownedExisting = await store.getAsset(projectId, existing.assetId);
        if (!(ownedExisting && ownedExisting.kind === 'image' && ownedExisting.sha256 === existing.sha256 && ownedExisting.mimeType === existing.mimeType)) {
          throw new FrameAuthoringError('RESULT_IMPORT_STATE_UNKNOWN', 'A result is recorded for this review but its owned media cannot be verified. Inspect the project media before any further action.', 409);
        }
        // Crash recovery: the result row is durable but the review never reached result_ready. The
        // asset is the recorded one, so finishing the transition cannot duplicate owned media.
        if (review.status === 'submitted' && review.output !== null && review.output.sha256 === existing.sha256) {
          const recovered = await store.transition({ projectId, reviewId, from: ['submitted'], to: 'result_ready', patch: { resultAssetId: existing.assetId } });
          if (recovered) return toResultView(existing);
        }
        throw new FrameAuthoringError('RESULT_ALREADY_IMPORTED', 'This review already has an imported result.', 409);
      }
      if (review.status !== 'submitted' || !review.output) throw new FrameAuthoringError('REVIEW_NOT_SUBMITTED', 'Only a submitted review with a verified provider image can be imported.', 409);

      const inspected = inspectImage(input.bytes);
      if (!inspected || inspected.mimeType !== mimeType) throw new FrameAuthoringError('RESULT_MIME_MISMATCH', 'The result bytes are not a valid image of the declared mime type.', 409);
      if (input.bytes.byteLength !== review.output.byteSize || sha256Bytes(input.bytes) !== review.output.sha256
        || inspected.width !== review.output.width || inspected.height !== review.output.height || inspected.mimeType !== review.output.mimeType) {
        throw new FrameAuthoringError('RESULT_INTEGRITY_MISMATCH', 'The result bytes do not match the verified provider output. Import refused.', 409);
      }
      // Stable identity: the asset id is derived from this review and its verified output hash, so a
      // repeated or resumed import of the same bytes can only ever address one owned asset.
      const assetId = frameResultAssetId({ projectId, reviewId, sha256: review.output.sha256 });
      // Durable claim before any media write. A concurrent or earlier import of a different intent
      // is refused here, so it can never leave an unreferenced asset behind.
      const claim = await store.claimResultImport({ projectId, reviewId, assetId, sha256: review.output.sha256, actorId: actor.id });
      if (claim.status === 'already_imported') throw new FrameAuthoringError('RESULT_ALREADY_IMPORTED', 'This review already has an imported result.', 409);
      if (claim.status === 'in_progress') {
        throw new FrameAuthoringError('RESULT_IMPORT_IN_PROGRESS', 'Another import for this review already owns the owned-media write. Nothing was written by this call; inspect the review before retrying.', 409);
      }
      if (claim.status !== 'claimed' || claim.assetId !== assetId) {
        throw new FrameAuthoringError('RESULT_IMPORT_STATE_UNKNOWN', 'The durable import claim for this review could not be established or read. Nothing was written; inspect before retrying.', 409);
      }
      const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'webp';
      let owned: FrameOwnedAsset & { width: number; height: number };
      try {
        owned = await media.importOwned({ id: assetId, projectId, filename: `frame-${review.role}.${extension}`, mimeType: mimeType as FrameImageMime, bytes: input.bytes });
      } catch {
        // A resumed import may find the asset already written by the claimed intent; that is the same
        // immutable identity, not a second asset. Anything else fails closed.
        const settled = await store.getAsset(projectId, assetId);
        if (settled && settled.kind === 'image' && settled.sha256 === review.output.sha256
          && settled.mimeType === mimeType && settled.byteSize === review.output.byteSize) {
          owned = { ...settled, width: review.output.width, height: review.output.height };
        } else {
          throw new FrameAuthoringError('RESULT_IMPORT_FAILED', 'Owned media could not store the result. Nothing was recorded.', 502);
        }
      }
      if (owned.id !== assetId || owned.projectId !== projectId || owned.kind !== 'image' || owned.sha256 !== review.output.sha256
        || owned.byteSize !== review.output.byteSize || owned.mimeType !== mimeType || owned.width !== review.output.width || owned.height !== review.output.height) {
        throw new FrameAuthoringError('RESULT_IMPORT_MISMATCH', 'Owned media disagreed with the verified image identity. Nothing was recorded.', 502);
      }
      const row: FrameResultRow = {
        assetId, projectId, reviewId, mimeType: review.output.mimeType, width: review.output.width,
        height: review.output.height, sha256: review.output.sha256, shotId: review.shotId,
        byteSize: review.output.byteSize, sourceAssetId: review.sourceAssetId,
        providerModelId: review.providerModelId ?? review.modelId, providerReceiptId: review.providerReceiptId,
        importedBy: actor.id,
      };
      if (!(await store.insertResult(row))) throw new FrameAuthoringError('RESULT_ALREADY_IMPORTED', 'This review already has an imported result.', 409);
      const updated = await store.transition({ projectId, reviewId, from: ['submitted'], to: 'result_ready', patch: { resultAssetId: assetId } });
      if (!updated) {
        const current = await store.getReview(projectId, reviewId);
        if (current?.status === 'result_ready' && current.resultAssetId === assetId) return toResultView(row);
        throw new FrameAuthoringError('REVIEW_STATE_LOST', 'The result was stored but the review state changed. Inspect before binding.', 409, undefined, { assetId });
      }
      try { await store.completeResultImport({ projectId, reviewId, assetId }); } catch { /* claim stays 'importing'; the result row is authoritative */ }
      return toResultView(row);
    },

    async    bind(input: { actor: Actor; projectId: string; shotId: string; expectedRevision: number; role: FrameRole; reviewId: string; assetId?: string }): Promise<FrameBindingView> {
      const actor = parseOr(ActorSchema, input?.actor, 'FORBIDDEN', 'A valid actor is required.');
      const requestSchema = z.strictObject({
        projectId: Id, shotId: Id, expectedRevision: Revision, role: z.enum(FRAME_ROLES), reviewId: Id, assetId: Id.optional(),
      }).strict();
      const request = parseOr(requestSchema, {
        projectId: input?.projectId, shotId: input?.shotId, expectedRevision: input?.expectedRevision, role: input?.role,
        reviewId: input?.reviewId, assetId: input?.assetId,
      }, 'INVALID_BIND', 'Binding requires project, shot, expected revision, role and review.');
      requireOperator(actor, 'BIND_REQUIRES_OPERATOR');
      const review = await requireReview(actor, request.projectId, request.reviewId);
      if (review.shotId !== request.shotId) throw new FrameAuthoringError('REVIEW_SHOT_MISMATCH', 'This review belongs to a different shot.', 409);
      if (review.role !== request.role) throw new FrameAuthoringError('ROLE_MISMATCH', 'The review was created for a different frame role. Draft the intended role explicitly.', 409);
      const shot = await store.getShot(request.projectId, request.shotId);
      if (!shot) throw new FrameAuthoringError('SHOT_NOT_FOUND', 'Shot not found in this project.', 404);
      if (shot.revision !== request.expectedRevision) {
        throw new FrameAuthoringError('REVISION_CONFLICT', 'This shot changed. Reload before binding a frame.', 409, shot.revision);
      }
      // The frozen review revision must match the live shot as well: echoing the current client
      // revision is not enough to bind a review that was drafted against an older revision.
      if (review.expectedRevision !== request.expectedRevision || review.expectedRevision !== shot.revision) {
        throw new FrameAuthoringError('REVIEW_REVISION_MISMATCH', 'This review was created for a different shot revision than the one being bound. Create a new review for the current revision.', 409, shot.revision);
      }
      if (review.status !== 'result_ready') throw new FrameAuthoringError('REVIEW_NOT_READY', 'A verified imported result is required before binding.', 409);
      const result = await store.findResult(request.projectId, request.reviewId);
      if (!result) throw new FrameAuthoringError('RESULT_NOT_FOUND', 'No imported result exists for this review.', 409);
      if (request.assetId !== undefined && request.assetId !== result.assetId) {
        throw new FrameAuthoringError('ASSET_REVIEW_MISMATCH', 'The supplied asset is not the imported result of this review. Nothing was bound.', 409);
      }
      const asset = await store.getAsset(request.projectId, result.assetId);
      if (!asset || asset.kind !== 'image' || asset.sha256 !== result.sha256) throw new FrameAuthoringError('RESULT_NOT_OWNED', 'The imported result is not an owned image in this project.', 409);
      const bound = await store.bindFrame({
        projectId: request.projectId, shotId: request.shotId, expectedRevision: request.expectedRevision,
        role: request.role, assetId: result.assetId, reviewId: request.reviewId, actorId: actor.id,
      });
      if (!bound) {
        const current = await store.getShot(request.projectId, request.shotId);
        throw new FrameAuthoringError('REVISION_CONFLICT', 'This shot changed before the bind could be applied.', 409, current?.revision);
      }
      return Object.freeze({
        projectId: request.projectId, shotId: request.shotId, revision: bound.revision,
        role: request.role, assetId: result.assetId,
        bindings: { firstFrameAssetId: bound.bindings.firstFrameAssetId, lastFrameAssetId: bound.bindings.lastFrameAssetId },
      });
    },

    async getReview(input: { actor: Actor; projectId: string; reviewId: string }): Promise<FrameReviewView> {
      const actor = parseOr(ActorSchema, input?.actor, 'FORBIDDEN', 'A valid actor is required.');
      const projectId = parseOr(Id, input?.projectId, 'INVALID_REQUEST', 'A project id is required.');
      const reviewId = parseOr(Id, input?.reviewId, 'INVALID_REQUEST', 'A review id is required.');
      const review = await requireReview(actor, projectId, reviewId);
      return toReviewView(review);
    },
  };

  const MONEY = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/;
  const microUsd = (value: number) => Math.round(value * 1_000_000);
  /** Strict, non-coerced approved maximum. A browser cannot widen it later. */
  function parseApprovedCap(value: unknown): number {
    if (typeof value !== 'string' || !MONEY.test(value)) {
      throw new FrameAuthoringError('INVALID_COST_CAP', 'An explicit approved maximum cost in USD is required.', 400);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new FrameAuthoringError('INVALID_COST_CAP', 'The approved maximum cost must be a finite positive USD amount.', 400);
    }
    return parsed;
  }

  /**
   * Operator approval with an optional durable spend ceiling. Both the approving actor and the
   * approved maximum are written in the same compare-and-set, so the audit trail carries the cap
   * that authorized the spend rather than only the fact of approval.
   */
  async function approveReview(input: {
    actor: unknown; projectId: unknown; reviewId: unknown; approvedMaxCostUsd: number | null;
  }): Promise<FrameReviewRecord> {
    const actor = parseOr(ActorSchema, input?.actor, 'FORBIDDEN', 'A valid actor is required.');
    const projectId = parseOr(Id, input?.projectId, 'INVALID_REQUEST', 'A project id is required.');
    const reviewId = parseOr(Id, input?.reviewId, 'INVALID_REQUEST', 'A review id is required.');
    requireOperator(actor, 'APPROVAL_REQUIRES_OPERATOR');
    const review = await requireReview(actor, projectId, reviewId);
    if (review.status === 'blocked' || review.blockers.length > 0) {
      throw new FrameAuthoringError('REVIEW_BLOCKED', 'Blocked reviews cannot be approved. Resolve the blockers in a new review.', 409, undefined, { blockers: review.blockers.map(blocker => blocker.code) });
    }
    if (review.status !== 'pending') throw new FrameAuthoringError('REVIEW_NOT_APPROVABLE', `This review is ${review.status} and cannot be approved again.`, 409);
    verifyReviewIntegrity(review);
    const shot = await store.getShot(projectId, review.shotId);
    if (!shot) throw new FrameAuthoringError('SHOT_NOT_FOUND', 'Shot not found in this project.', 404);
    if (shot.revision !== review.expectedRevision) {
      throw new FrameAuthoringError('STALE_REVIEW', 'The shot changed after this review. Create a new review for the current revision.', 409, shot.revision);
    }
    const patch: FrameTransitionPatch = { approvedBy: actor.id };
    if (input.approvedMaxCostUsd !== null) patch.approvedMaxCostUsd = input.approvedMaxCostUsd;
    const updated = await store.transition({ projectId, reviewId, from: ['pending'], to: 'approved', patch });
    if (!updated) throw new FrameAuthoringError('REVIEW_NOT_APPROVABLE', 'This review changed before approval could be recorded.', 409);
    return updated;
  }

  /**
   * One operator action: verify the immutable review, enforce the approved maximum against the
   * server estimate, record approval, then submit exactly once. An unknown estimate blocks: the
   * server never guesses a quote to allow spending. A prior approval for the same immutable review
   * is reused so a process loss between approval and submission cannot strand the review, while the
   * single-flight claim still guarantees at most one provider request.
   */
  async function approveAndSubmit(input: {
    actor: Actor; projectId: string; reviewId: string; expectedRevision: number; maxCostUsd: string;
  }): Promise<FrameSubmitOutcome> {
    const actor = parseOr(ActorSchema, input?.actor, 'FORBIDDEN', 'A valid actor is required.');
    const projectId = parseOr(Id, input?.projectId, 'INVALID_REQUEST', 'A project id is required.');
    const reviewId = parseOr(Id, input?.reviewId, 'INVALID_REQUEST', 'A review id is required.');
    const expectedRevision = parseOr(Revision, input?.expectedRevision, 'INVALID_REQUEST', 'The reviewed shot revision is required.');
    requireOperator(actor, 'APPROVAL_REQUIRES_OPERATOR');
    const approvedMax = parseApprovedCap(input?.maxCostUsd);
    const review = await requireReview(actor, projectId, reviewId);
    if (review.status === 'blocked' || review.blockers.length > 0) {
      throw new FrameAuthoringError('REVIEW_BLOCKED', 'Blocked reviews cannot be submitted. Resolve the blockers in a new review.', 409, undefined, { blockers: review.blockers.map(blocker => blocker.code) });
    }
    if (review.expectedRevision !== expectedRevision) {
      throw new FrameAuthoringError('STALE_REVIEW', 'This review belongs to a different shot revision. Create a new review for the current revision.', 409, review.expectedRevision);
    }
    if (review.estimateUsd === null || !Number.isFinite(review.estimateUsd) || review.estimateUsd < 0) {
      throw new FrameAuthoringError('ESTIMATE_UNKNOWN', 'No server estimate exists for this review. Spending cannot be approved without one; nothing was submitted.', 409);
    }
    if (microUsd(review.estimateUsd) > microUsd(approvedMax)) {
      throw new FrameAuthoringError('COST_CAP_EXCEEDED', 'The approved maximum is below the server estimate for this review. Nothing was submitted.', 409, undefined, { estimateUsd: review.estimateUsd, maxCostUsd: approvedMax });
    }
    if (review.status === 'pending') {
      await approveReview({ actor, projectId, reviewId, approvedMaxCostUsd: approvedMax });
    } else if (review.status === 'approved') {
      // Reused approval: the stored ceiling must exist and still cover this estimate. An approval
      // recorded without a ceiling (or one now below the estimate) may not authorize a spend.
      const storedCap = review.approvedMaxCostUsd;
      if (typeof storedCap !== 'number' || !Number.isFinite(storedCap) || storedCap <= 0) {
        throw new FrameAuthoringError('APPROVAL_CAP_MISSING', 'This review was approved without a recorded spend ceiling. Approve it again with an explicit maximum. Nothing was submitted.', 409);
      }
      if (microUsd(storedCap) < microUsd(review.estimateUsd)) {
        throw new FrameAuthoringError('COST_CAP_EXCEEDED', 'The recorded approval ceiling is below the server estimate for this review. Nothing was submitted.', 409, undefined, { estimateUsd: review.estimateUsd, maxCostUsd: storedCap });
      }
    }
    // Submission itself re-checks the immutable review and claims the single-flight transition, so
    // an already submitted, in-flight or unknown review is refused with its precise code and no
    // provider request is made.
    return service.submit({ actor, projectId, reviewId });
  }

  /** Safe read of one review and its verified result. Reading never resubmits or imports. */
  async function readReview(input: { actor: Actor; projectId: string; reviewId: string }): Promise<{ review: FrameReviewView; result: FrameResultView | null }> {
    const actor = parseOr(ActorSchema, input?.actor, 'FORBIDDEN', 'A valid actor is required.');
    const projectId = parseOr(Id, input?.projectId, 'INVALID_REQUEST', 'A project id is required.');
    const reviewId = parseOr(Id, input?.reviewId, 'INVALID_REQUEST', 'A review id is required.');
    const review = await requireReview(actor, projectId, reviewId);
    const row = await store.findResult(projectId, reviewId);
    let result: FrameResultView | null = null;
    if (row) {
      const asset = await store.getAsset(projectId, row.assetId);
      if (asset && asset.kind === 'image' && asset.sha256 === row.sha256 && asset.mimeType === row.mimeType) result = toResultView(row);
    }
    return { review: toReviewView(review), result };
  }

  /**
   * Explicit operator import of the exact staged bytes for this review. Idempotent for a review
   * whose result is already recorded; an unknown or unverifiable result state fails closed and is
   * never auto-retried against the provider.
   */
  async function importStagedResult(input: { actor: Actor; projectId: string; reviewId: string }): Promise<FrameResultView> {
    const actor = parseOr(ActorSchema, input?.actor, 'FORBIDDEN', 'A valid actor is required.');
    const projectId = parseOr(Id, input?.projectId, 'INVALID_REQUEST', 'A project id is required.');
    const reviewId = parseOr(Id, input?.reviewId, 'INVALID_REQUEST', 'A review id is required.');
    requireOperator(actor, 'IMPORT_REQUIRES_OPERATOR');
    const review = await requireReview(actor, projectId, reviewId);

    const existing = await store.findResult(projectId, reviewId);
    if (existing) {
      const owned = await store.getAsset(projectId, existing.assetId);
      if (owned && owned.kind === 'image' && owned.sha256 === existing.sha256 && owned.mimeType === existing.mimeType) return toResultView(existing);
      throw new FrameAuthoringError('RESULT_IMPORT_STATE_UNKNOWN', 'A result is recorded for this review but its owned media cannot be verified. Inspect the project media before any further action.', 409);
    }
    if (review.status === 'submitting') {
      throw new FrameAuthoringError('RESULT_IMPORT_IN_PROGRESS', 'The provider submission is still in progress. Wait for it to finish; no image is imported yet.', 409);
    }
    if (!review.output) {
      throw new FrameAuthoringError('REVIEW_NOT_SUBMITTED', 'Only a submitted review with a verified provider image can be imported.', 409);
    }
    if (!staging) {
      throw new FrameAuthoringError('RESULT_STAGING_UNAVAILABLE', 'Durable result staging is not configured on this server. Nothing was imported.', 503);
    }
    let bytes: Uint8Array;
    try {
      bytes = await staging.read({ projectId, reviewId, mimeType: review.output.mimeType, sha256: review.output.sha256, byteSize: review.output.byteSize });
    } catch {
      throw new FrameAuthoringError('RESULT_STAGING_UNAVAILABLE', 'The staged result bytes are missing or failed integrity verification. Import refused; do not resubmit the provider request.', 409);
    }
    try {
      return await service.importResult({ actor, projectId, reviewId, mimeType: review.output.mimeType, bytes });
    } catch (error) {
      if (error instanceof FrameAuthoringError && error.code === 'RESULT_ALREADY_IMPORTED') {
        const raced = await store.findResult(projectId, reviewId);
        const owned = raced ? await store.getAsset(projectId, raced.assetId) : null;
        if (raced && owned && owned.kind === 'image' && owned.sha256 === raced.sha256) return toResultView(raced);
        throw new FrameAuthoringError('RESULT_IMPORT_STATE_UNKNOWN', 'The result state changed during import and cannot be verified. Inspect the review before any further action.', 409);
      }
      throw error;
    }
  }

  return { ...service, approveAndSubmit, importStagedResult, readReview };
}
export type FrameAuthoringService = ReturnType<typeof createFrameAuthoringService>;
