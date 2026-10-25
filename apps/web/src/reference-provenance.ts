/**
 * Read-only transport for *recorded* reference history.
 *
 * This module answers one question for one generation: which references — identity, digest and
 * role — were frozen into its review? It never mutates, never inspects, selects, exports or
 * generates, and never consults current media. Three facts are load-bearing and are not
 * collapsed here:
 *
 *  - a digest of `null` means *not recorded*. It is never inferred from the current asset, and it
 *    is never presented as a verification that the media is the one that was used;
 *  - `unknown` means the record carries no usable binding information — it is not "no references";
 *  - the receipt says nothing about whether that media still exists.
 *
 * The wire shape is validated field by field and rebuilt, so an unexpected server field is never
 * rendered and junk is never coerced into an identifier.
 */
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digestPattern = /^[0-9a-f]{64}$/;
const roles = ['first_frame','last_frame'] as const;
const statuses = ['recorded','partial','unknown'] as const;

export type RecordedInputRole = (typeof roles)[number];
export interface RecordedInputReference { role: RecordedInputRole; assetId: string | null; sha256: string | null }
export interface ReferenceReceipt {
  attemptId: string; reviewId: string; projectId: string; shotId: string; shotRevision: number;
  requestHash: string; recordedAt: string;
  status: 'recorded' | 'partial' | 'unknown';
  references: RecordedInputReference[];
}
/** What the take-review disclosure renders. Structurally identical to the package's own type. */
export type RecordedInputsState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; status: ReferenceReceipt['status']; references: RecordedInputReference[] }
  | { phase: 'error'; message: string };
/** Controller state for one (project, attempt) read. Absence means "never asked". */
export type ReferenceReadState =
  | { phase: 'loading' }
  | { phase: 'ready'; receipt: ReferenceReceipt }
  | { phase: 'error'; code: string; message: string };
export interface ReferenceProvenancePort { read(attemptId: string, projectId: string): Promise<ReferenceReceipt> }

export class ReferenceProvenanceError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'ReferenceProvenanceError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** One authoritative key per generation. Casing aliases share one receipt. */
export function referenceReadKey(projectId: string, attemptId: string): string {
  return `${projectId.toLowerCase()}:${attemptId.toLowerCase()}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function malformed(): ReferenceProvenanceError {
  return new ReferenceProvenanceError('MALFORMED_RESPONSE', 'The server returned unreadable recorded inputs. Nothing was assumed.');
}

/** Strict wire validation. A role, id or digest that is not exactly right is not a receipt. */
export function referenceReceiptFromWire(value: unknown): ReferenceReceipt {
  const view = record(value);
  const attemptId = text(view.attemptId), reviewId = text(view.reviewId);
  const projectId = text(view.projectId), shotId = text(view.shotId);
  for (const id of [attemptId, reviewId, projectId, shotId]) if (!uuidPattern.test(id)) throw malformed();
  if (!Number.isInteger(view.shotRevision) || (view.shotRevision as number) < 0) throw malformed();
  if (!digestPattern.test(text(view.requestHash))) throw malformed();
  if (!text(view.recordedAt)) throw malformed();
  const status = text(view.status);
  if (!(statuses as readonly string[]).includes(status)) throw malformed();
  if (!Array.isArray(view.references) || view.references.length > roles.length) throw malformed();
  const seen = new Set<string>();
  const references: RecordedInputReference[] = [];
  for (const entry of view.references) {
    const item = record(entry);
    const role = text(item.role);
    if (!(roles as readonly string[]).includes(role) || seen.has(role)) throw malformed();
    const assetId = item.assetId === null ? null : text(item.assetId);
    const sha256 = item.sha256 === null ? null : text(item.sha256);
    if (assetId !== null && !uuidPattern.test(assetId)) throw malformed();
    if (sha256 !== null && !digestPattern.test(sha256)) throw malformed();
    seen.add(role);
    references.push({ role: role as RecordedInputRole, assetId, sha256 });
  }
  return {
    attemptId, reviewId, projectId, shotId, shotRevision: view.shotRevision as number,
    requestHash: text(view.requestHash), recordedAt: text(view.recordedAt),
    status: status as ReferenceReceipt['status'], references,
  };
}

/** Bounded, honest copy for the disclosure. Unknown codes keep the server's safe message. */
export function referenceReadMessage(code: string, fallback: string): string {
  switch (code) {
    case 'PROVENANCE_NOT_FOUND': return 'No recorded reference history is available for this attempt.';
    case 'FORBIDDEN': return 'This project does not grant access to that recorded history.';
    case 'PROVENANCE_INCONSISTENT': return 'The stored review does not match this attempt, so nothing is shown.';
    case 'MALFORMED_RESPONSE': return 'The server returned unreadable recorded inputs. Nothing was assumed.';
    case 'CONNECTION_LOST': return 'Could not reach Flume. Check the local service, then try again.';
    default: return fallback || 'Recorded inputs could not be read. Try again.';
  }
}

/** Map one controller read into the disclosure's presentation state. */
export function recordedInputsFor(read: ReferenceReadState | undefined): RecordedInputsState | null {
  if (!read) return null;
  return read.phase === 'ready'
    ? { phase: 'ready', status: read.receipt.status, references: read.receipt.references }
    : read;
}

export function createReferenceProvenanceApi(fetcher: typeof fetch = globalThis.fetch.bind(globalThis)): ReferenceProvenancePort {
  return {
    async read(attemptId, projectId) {
      const path = `/api/attempts/${encodeURIComponent(attemptId)}/provenance?projectId=${encodeURIComponent(projectId)}`;
      let response: Response;
      try {
        // Same-origin only: the existing Host/Origin/actor policy authorizes this GET.
        response = await fetcher(path, { method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: { accept: 'application/json' } });
      } catch {
        throw new ReferenceProvenanceError('CONNECTION_LOST', 'Could not reach Flume. Check the local service, then try again.');
      }
      let body: unknown = null;
      try { body = await response.json(); } catch { body = null; }
      if (!response.ok) {
        const error = record(body);
        throw new ReferenceProvenanceError(
          typeof error.code === 'string' ? error.code : `HTTP_${response.status}`,
          typeof error.message === 'string' ? error.message : 'The recorded inputs were refused.',
          response.status,
        );
      }
      if (body === null) throw new ReferenceProvenanceError('EMPTY_RESPONSE', 'The server answered without a readable body.', response.status);
      return referenceReceiptFromWire(body);
    },
  };
}
