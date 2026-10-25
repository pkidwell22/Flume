/**
 * Frame authoring contracts shared by the image lane's server, provider adapter and UI.
 * Draft -> immutable review -> operator approval -> one submit -> verified result -> explicit bind.
 * Public DTOs deliberately exclude provider envelopes, receipts, credentials and raw failures.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const FRAME_AUTHORING_STATUSES = Object.freeze([
  'pending', 'blocked', 'approved', 'submitting', 'submitted', 'result_ready', 'bound', 'failed', 'acceptance_unknown',
] as const);
export const FrameReviewStatusSchema = z.enum(FRAME_AUTHORING_STATUSES);
export type FrameAuthoringStatus = z.infer<typeof FrameReviewStatusSchema>;

export const FRAME_ROLES = Object.freeze(['first_frame', 'last_frame'] as const);
export const FrameRoleSchema = z.enum(FRAME_ROLES);
export type FrameAuthoringRole = z.infer<typeof FrameRoleSchema>;

export const FRAME_IMAGE_MIME_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp'] as const);
export const FrameImageMimeSchema = z.enum(FRAME_IMAGE_MIME_TYPES);
export type FrameImageMime = z.infer<typeof FrameImageMimeSchema>;

export const MAX_FRAME_PROMPT_CHARS = 8000;
export const MAX_FRAME_REFERENCE_BYTES = 10 * 1024 * 1024;
export const MAX_FRAME_RESULT_BYTES = 12 * 1024 * 1024;
export const MAX_FRAME_RESULT_PIXELS = 40_000_000;

/** Provider/model identifiers are opaque catalog keys; only a conservative literal form is accepted. */
export const FrameModelIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/);
export const FrameAspectRatioSchema = z.string().regex(/^\d{1,2}:\d{1,2}$/);

const IdSchema = z.string().uuid();
const RevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const FrameBlockerSchema = z.strictObject({ code: z.string().min(1), message: z.string().min(1) });
export type FrameBlocker = z.infer<typeof FrameBlockerSchema>;

export const FrameReviewDraftSchema = z.strictObject({
  projectId: IdSchema,
  shotId: IdSchema,
  expectedRevision: RevisionSchema,
  role: FrameRoleSchema,
  /** Literal author intent. Never trimmed, normalized or truncated. */
  prompt: z.string().min(1).max(MAX_FRAME_PROMPT_CHARS).refine(value => value.trim().length > 0, 'Prompt must contain visible characters.'),
  modelId: FrameModelIdSchema,
  aspectRatio: FrameAspectRatioSchema,
  /** Only a project-owned asset id may reference a source image; arbitrary URLs are unrepresentable. */
  sourceAssetId: IdSchema.nullable().optional(),
}).strict().transform(draft => ({ ...draft, sourceAssetId: draft.sourceAssetId ?? null }));
export type FrameReviewDraft = z.infer<typeof FrameReviewDraftSchema>;

/** Exactly the coordinator-facing review contract; server is authoritative for every field. */
export const FrameReviewViewSchema = z.strictObject({
  reviewId: IdSchema, projectId: IdSchema, shotId: IdSchema, expectedRevision: RevisionSchema,
  role: FrameRoleSchema, prompt: z.string(), modelId: z.string(), aspectRatio: z.string(),
  sourceAssetId: IdSchema.nullable(), requestHash: Sha256Schema, status: FrameReviewStatusSchema,
  blockers: z.array(FrameBlockerSchema), estimateUsd: z.number().finite().nonnegative().nullable(),
}).strict();
export type FrameReviewView = z.infer<typeof FrameReviewViewSchema>;

export const FrameResultViewSchema = z.strictObject({
  assetId: IdSchema, projectId: IdSchema, reviewId: IdSchema,
  mimeType: FrameImageMimeSchema, width: z.number().int().positive(), height: z.number().int().positive(),
  sha256: Sha256Schema,
}).strict();
export type FrameResultView = z.infer<typeof FrameResultViewSchema>;

export const FrameBindingsSchema = z.strictObject({
  firstFrameAssetId: IdSchema.nullable(), lastFrameAssetId: IdSchema.nullable(),
}).strict();
export type FrameBindings = z.infer<typeof FrameBindingsSchema>;

export const FrameBindRequestSchema = z.strictObject({
  projectId: IdSchema, shotId: IdSchema, expectedRevision: RevisionSchema,
  role: FrameRoleSchema, reviewId: IdSchema,
}).strict();
export type FrameBindRequest = z.infer<typeof FrameBindRequestSchema>;

export const FrameBindingViewSchema = z.strictObject({
  projectId: IdSchema, shotId: IdSchema, revision: RevisionSchema,
  role: FrameRoleSchema, assetId: IdSchema, bindings: FrameBindingsSchema,
}).strict();
export type FrameBindingView = z.infer<typeof FrameBindingViewSchema>;

/** Caller-supplied metadata is only an assertion; sha256/dimensions are always recomputed from bytes. */
export const FrameResultImportRequestSchema = z.strictObject({
  projectId: IdSchema, reviewId: IdSchema, mimeType: FrameImageMimeSchema,
}).strict();
export type FrameResultImportRequest = z.infer<typeof FrameResultImportRequestSchema>;

export const FRAME_AUTHORING_TRANSITIONS: Readonly<Record<FrameAuthoringStatus, readonly FrameAuthoringStatus[]>> = Object.freeze({
  pending: Object.freeze(['approved', 'blocked'] as const),
  blocked: Object.freeze([] as const),
  approved: Object.freeze(['submitting', 'failed'] as const),
  submitting: Object.freeze(['submitted', 'failed', 'acceptance_unknown'] as const),
  submitted: Object.freeze(['result_ready'] as const),
  result_ready: Object.freeze(['bound'] as const),
  bound: Object.freeze([] as const),
  failed: Object.freeze([] as const),
  acceptance_unknown: Object.freeze([] as const),
});
export function canTransitionFrameReview(from: string, to: string): boolean {
  return (FRAME_AUTHORING_TRANSITIONS[from as FrameAuthoringStatus] ?? []).includes(to as FrameAuthoringStatus);
}

export function canonicalFrameJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalFrameJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value as Record<string, unknown>).sort()
      .map(key => JSON.stringify(key) + ':' + canonicalFrameJson((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export interface FrameRequestHashInput {
  role: FrameAuthoringRole;
  prompt: string;
  modelId: string;
  aspectRatio: string;
  sourceAssetId: string | null;
  sourceAssetSha256: string | null;
  envelopeSha256: string | null;
}
/** Identity of one reviewed request: exact intent plus the exact compiled provider bytes. */
export function frameAuthoringRequestHash(input: FrameRequestHashInput): string {
  if (!FrameRoleSchema.safeParse(input.role).success) throw new TypeError('Frame role must be first_frame or last_frame.');
  const identity = {
    aspectRatio: input.aspectRatio,
    envelopeSha256: input.envelopeSha256 ?? null,
    modelId: input.modelId,
    prompt: input.prompt,
    role: input.role,
    sourceAssetId: input.sourceAssetId ?? null,
    sourceAssetSha256: input.sourceAssetSha256 ?? null,
  };
  return createHash('sha256').update(canonicalFrameJson(identity)).digest('hex');
}

/** Internal/persisted review shape. Envelope and receipt fields never leave the server through this DTO. */
export interface FrameReviewRecord extends FrameReviewView {
  sourceAssetSha256: string | null;
  envelope: { provider: 'openrouter'; modelId: string; body: string; bodySha256: string } | null;
  createdBy: string;
  createdByKind: 'operator' | 'agent';
  approvedBy: string | null;
  resultAssetId: string | null;
  output: { mimeType: FrameImageMime; width: number; height: number; sha256: string; byteSize: number } | null;
  providerModelId: string | null;
  providerReceiptId: string | null;
  errorCode: string | null;
}

export interface FrameResultRecord extends FrameResultView {
  shotId: string;
  byteSize: number;
  sourceAssetId: string | null;
  providerModelId: string;
  providerReceiptId: string | null;
  importedBy: string;
  bytes?: Uint8Array;
}

export function toFrameReviewView(record: FrameReviewRecord): FrameReviewView {
  const view: FrameReviewView = {
    reviewId: record.reviewId, projectId: record.projectId, shotId: record.shotId,
    expectedRevision: record.expectedRevision, role: record.role, prompt: record.prompt,
    modelId: record.modelId, aspectRatio: record.aspectRatio, sourceAssetId: record.sourceAssetId,
    requestHash: record.requestHash, status: record.status, blockers: record.blockers.map(({ code, message }) => ({ code, message })),
    estimateUsd: record.estimateUsd,
  };
  return Object.freeze(view);
}

export function toFrameResultView(record: FrameResultRecord): FrameResultView {
  return Object.freeze({
    assetId: record.assetId, projectId: record.projectId, reviewId: record.reviewId,
    mimeType: record.mimeType, width: record.width, height: record.height, sha256: record.sha256,
  });
}
