import { z } from 'zod';
import { ServiceError,uuid } from './contracts.ts';

/**
 * Recorded reference provenance: one read-only projection of the frozen review snapshot.
 *
 * The single source is `flume.reviews.snapshot`, written by `generation.prepare` and pinned by
 * `verifyReview`. Nothing here reads `flume.shots`, `flume.assets`, the provider envelope, a
 * storage key, a URL or the current selection, so a replaced, re-ingested or missing asset can
 * never change what a past generation is recorded as having used.
 *
 * Three states are load-bearing and are never collapsed into one another:
 *  - `recorded` — every non-null role binding resolved to a frozen digest, or both role keys were
 *    explicitly recorded as null (nothing was bound);
 *  - `partial`  — some role information is recorded but at least one binding has no usable frozen
 *    digest, or a key is missing, so the record cannot be asserted complete;
 *  - `unknown`  — the snapshot carries no usable binding information at all.
 *
 * A digest is either the exact frozen 64-hex string or null. Null always means *unknown*; it is
 * never backfilled from the assets table, inferred, or repaired.
 */
export const referenceRoles = ['first_frame','last_frame'] as const;
export type ReferenceRole = (typeof referenceRoles)[number];
const roleKeys: ReadonlyArray<readonly [ReferenceRole, string]> = [['first_frame','firstFrameAssetId'],['last_frame','lastFrameAssetId']];
const digestPattern = /^[0-9a-f]{64}$/;

export const referenceReferenceSchema = z.strictObject({
  role: z.enum(['first_frame','last_frame']),
  assetId: uuid.nullable(),
  sha256: z.string().regex(digestPattern).nullable(),
}).strict();
export type ReferenceEntry = z.infer<typeof referenceReferenceSchema>;

export const referenceReceiptSchema = z.strictObject({
  attemptId: uuid,
  reviewId: uuid,
  projectId: uuid,
  shotId: uuid,
  shotRevision: z.number().int().min(0),
  requestHash: z.string().regex(digestPattern),
  recordedAt: z.string().min(1),
  status: z.enum(['recorded','partial','unknown']),
  references: z.array(referenceReferenceSchema).max(referenceRoles.length),
}).strict();
export type ReferenceReceipt = z.infer<typeof referenceReceiptSchema>;

/** The one joined row this read is allowed to see: the attempt plus its frozen review. */
export type ReferenceProvenanceRow = {
  attempt_id: string;
  attempt_project_id: string;
  attempt_shot_id: string;
  attempt_shot_revision: number;
  review_id: string;
  review_id_row: string;
  review_project_id: string;
  review_shot_id: string;
  review_shot_revision: number;
  request_hash: string;
  recorded_at: Date | string;
  snapshot: unknown;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Frozen per-asset digests keyed case-insensitively. A disputed duplicate becomes unusable. */
function digestIndex(assets: unknown): Map<string, string | null> {
  const index = new Map<string, string | null>();
  if (!Array.isArray(assets)) return index;
  for (const entry of assets) {
    const asset = record(entry);
    if (!asset) continue;
    const id = text(asset.id);
    if (!uuid.safeParse(id).success) continue;
    const key = id.toLowerCase(), declared = text(asset.sha256);
    const digest = digestPattern.test(declared) ? declared : null;
    // Two entries for one asset disagree: the honest value is unknown, not the last one read.
    index.set(key, index.has(key) && index.get(key) !== digest ? null : digest);
  }
  return index;
}

function timestamp(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new ServiceError('PROVENANCE_INCONSISTENT','The recorded review is not usable.',409);
  return date.toISOString();
}

/** The attempt and its review must describe the same generation, or nothing is presented. */
function identityOf(row: ReferenceProvenanceRow) {
  const attemptId = text(row.attempt_id), projectId = text(row.attempt_project_id);
  const shotId = text(row.attempt_shot_id), reviewId = text(row.review_id_row);
  const consistent = uuid.safeParse(attemptId).success && uuid.safeParse(projectId).success
    && uuid.safeParse(shotId).success && uuid.safeParse(reviewId).success
    && text(row.review_id).toLowerCase() === reviewId.toLowerCase()
    && text(row.review_project_id).toLowerCase() === projectId.toLowerCase()
    && text(row.review_shot_id).toLowerCase() === shotId.toLowerCase()
    && row.review_shot_revision === row.attempt_shot_revision
    && Number.isInteger(row.attempt_shot_revision) && row.attempt_shot_revision >= 0
    && digestPattern.test(text(row.request_hash));
  if (!consistent) throw new ServiceError('PROVENANCE_INCONSISTENT','The recorded review does not match this attempt.',409);
  return { attemptId, reviewId, projectId, shotId, shotRevision: row.attempt_shot_revision, requestHash: text(row.request_hash), recordedAt: timestamp(row.recorded_at) };
}

/**
 * Pure projection: frozen review row -> receipt. Unknowns stay unknown, and the caller's UUID
 * alias casing is preserved because that is what the snapshot recorded.
 */
export function projectReferenceReceipt(row: ReferenceProvenanceRow): ReferenceReceipt {
  const identity = identityOf(row);
  const snapshot = record(row.snapshot);
  const bindings = snapshot ? record(snapshot.bindings) : null;
  const present = bindings ? roleKeys.filter(([, key]) => Object.prototype.hasOwnProperty.call(bindings, key)) : [];
  const references: ReferenceEntry[] = [];
  if (bindings && present.length) {
    const digests = digestIndex(snapshot?.assets);
    for (const [role, key] of present) {
      const value = bindings[key];
      // A recorded null is a fact: nothing was bound to this role.
      if (value === null) continue;
      const assetId = text(value);
      // Junk is never coerced into an identifier; the role stays visible with nothing asserted.
      if (!uuid.safeParse(assetId).success) { references.push({ role, assetId: null, sha256: null }); continue; }
      references.push({ role, assetId, sha256: digests.get(assetId.toLowerCase()) ?? null });
    }
  }
  const complete = present.length === roleKeys.length
    && references.every(reference => reference.assetId !== null && reference.sha256 !== null);
  const status = present.length === 0 ? 'unknown' : complete ? 'recorded' : 'partial';
  // Explicit runtime validation at the boundary: an extra or malformed field cannot be served.
  return referenceReceiptSchema.parse({ ...identity, status, references });
}
