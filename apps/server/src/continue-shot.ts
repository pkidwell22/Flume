import { createHash } from 'node:crypto';
import { actorSchema, authorize, commandSchema, ServiceError, uuid, type Actor, type Command, type Receipt } from './contracts.ts';
import type { Asset, Workspace } from './dto.ts';
import {
  createMemoryAuthoringOperationLock,
  DEFAULT_LEASE_TTL_MS,
  fingerprintPayload,
  type AuthoringLease,
  type AuthoringOperationLock,
} from './authoring-operation-lock.ts';

/**
 * Continue from this take.
 *
 * The operator picks one project-owned take. The LAST frame of that take's video is extracted as a new
 * owned image, a NEW shot is created, and the extracted image is bound as the new shot's FIRST frame.
 * The new shot's last frame stays empty and the source shot is never mutated.
 *
 * This module owns orchestration only. It calls the existing primitives through injected ports:
 *   - service.getWorkspace          -> ownership, take/asset resolution and authoritative readback
 *   - service.extractReferenceFrame -> MEDIA PORT extraction (frame:'last'), no provider, no queue
 *   - service.command               -> real shot.create / shot.update command shapes (validated here too)
 *
 * No provider/queue port exists in this surface: continuing a take cannot spend or submit anything.
 *
 * Durable ownership, not optimism:
 *  - every run holds a fenced lease from `flume.authoring_operation_leases` (see
 *    ./authoring-operation-lock.ts). A concurrent call is refused with CONTINUE_IN_PROGRESS and does
 *    NOT touch extraction; a process that lost its lease cannot write its result.
 *  - the exact `shot.create` payload, the exact `shot.update` (bind) payload and the issuing actor
 *    are frozen in the journal before dispatch and replayed byte-for-byte on resume. Receipts are
 *    keyed by `(actor_id, command_id)`, so replaying as a different actor would mint a second shot.
 *  - EXTRACTION is the one step without an idempotency key. The journal records
 *    `extractionDispatched` before the media port is called. If a later owner finds it dispatched
 *    and no derived frame is visible, the outcome is UNKNOWN, not "safe to retry": nothing is
 *    re-extracted and the operation reports EXTRACTION_UNKNOWN (non-resumable) for inspection.
 *    Only a refusal the port can prove happened before dispatch clears the flag for a retry.
 *
 * There is no distributed transaction here. Extraction, shot creation and binding are separate commits.
 * Partial progress is REPORTED, never rolled back or pretended away.
 */

export type ContinueShotJournalStatus = 'pending' | 'extracting' | 'extracted' | 'creating' | 'created' | 'binding' | 'completed' | 'blocked' | 'extraction_unknown';

export type ContinueShotRecord = {
  operationId: string;
  projectId: string;
  /** Actor that owns this operation. Part of request identity, checked on every resume. */
  actorId: string;
  actorKind: Actor['kind'];
  /** Fingerprint of the whole request intent (project, take, asset, title, prompt, actor). */
  intentHash: string;
  sourceTakeId: string;
  sourceShotId: string;
  sourceAssetId: string;
  sourceAssetSha256: string;
  title: string;
  prompt: string;
  status: ContinueShotJournalStatus;
  /** True once the media port has been (or is about to be) invoked for `sourceAssetId`. */
  extractionDispatched: boolean;
  extractedAssetId: string | null;
  shotId: string | null;
  shotRevision: number | null;
  /** Exact command payloads frozen before dispatch; replayed verbatim on resume. */
  createPayload: ContinueShotCommand | null;
  createPayloadHash: string | null;
  bindPayload: ContinueShotCommand | null;
  bindPayloadHash: string | null;
  blockers: string[];
  message: string | null;
  resumable: boolean;
  updatedAt: string;
};

export type ContinueShotCommand = {
  type: 'shot.create' | 'shot.update';
  commandId: string;
  projectId: string;
  title?: string;
  prompt?: string;
  shotId?: string;
  expectedRevision?: number;
  patch?: { bindings: { firstFrameAssetId: string } };
};

export type ContinueShotGuard = { ownerToken: string; fence: number };

export type ContinueShotBegin = {
  record: ContinueShotRecord;
  created: boolean;
  /** Null when another owner holds a live lease; the caller must not perform any side effect. */
  lease: AuthoringLease | null;
};

/**
 * Durable journal contract. The SQL adapter is `createSqlContinueShotJournal(executor)` in
 * ./continue-shot-store.ts (migration 011). `begin` creates the record if absent and acquires the
 * fenced lease; `save` is a compare-and-set on status AND lease fence, so a superseded worker can
 * never overwrite a newer owner's progress.
 */
export type ContinueShotJournal = {
  load(operationId: string): Promise<ContinueShotRecord | null>;
  begin(record: ContinueShotRecord, options?: { ownerToken?: string; ttlMs?: number }): Promise<ContinueShotBegin>;
  save(record: ContinueShotRecord, from: ContinueShotJournalStatus[], guard: ContinueShotGuard): Promise<ContinueShotRecord | null>;
  release(operationId: string, guard: ContinueShotGuard): Promise<void>;
  /** Read-only liveness probe for the public view. Never acquires, renews or releases anything. */
  isActive?(operationId: string): Promise<boolean>;
};

/**
 * Labelled NON-DURABLE fixture journal: process memory only, lost on restart. It reproduces the
 * fence/expiry semantics so concurrency and takeover behaviour can be tested, and must never be
 * described as cross-process ownership.
 */
export function createMemoryContinueShotJournal(options: { now?: () => number; ttlMs?: number } = {}): ContinueShotJournal {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const records = new Map<string, ContinueShotRecord>();
  const lease: AuthoringOperationLock = createMemoryAuthoringOperationLock({ now });
  const peek = (lease as AuthoringOperationLock & { peekSync?: (scope: string, id: string) => { ownerToken: string; fence: number; live: boolean; projectId: string } | null }).peekSync!;
  const holds = (operationId: string, projectId: string, guard: ContinueShotGuard) => {
    const row = peek.call(lease, 'continue-shot', operationId.toLowerCase());
    return !!row && row.live && row.ownerToken === guard.ownerToken && row.fence === guard.fence
      && row.projectId.toLowerCase() === projectId.toLowerCase();
  };
  return {
    async load(operationId) {
      const found = records.get(operationId.toLowerCase());
      return found ? structuredClone(found) : null;
    },
    async begin(record, beginOptions = {}) {
      const key = record.operationId.toLowerCase();
      let existing = records.get(key);
      const created = !existing;
      if (!existing) {
        records.set(key, structuredClone(record));
        existing = structuredClone(record);
      }
      const acquired = await lease.acquire({
        scope: 'continue-shot', operationId: key, projectId: existing.projectId,
        ownerToken: beginOptions.ownerToken, ttlMs: beginOptions.ttlMs ?? ttlMs,
      });
      return { record: structuredClone(existing), created, lease: acquired.lease };
    },
    async save(record, from, guard) {
      const key = record.operationId.toLowerCase();
      const existing = records.get(key);
      if (!existing || !from.includes(existing.status) || !holds(record.operationId, existing.projectId, guard)) return null;
      const next = structuredClone(record);
      records.set(key, next);
      return structuredClone(next);
    },
    async release(operationId, guard) {
      await lease.release({
        scope: 'continue-shot', operationId: operationId.toLowerCase(), projectId: records.get(operationId.toLowerCase())?.projectId ?? '',
        ownerToken: guard.ownerToken, fence: guard.fence, expiresAt: new Date(now()).toISOString(),
      });
    },
    async isActive(operationId) {
      const row = peek.call(lease, 'continue-shot', operationId.toLowerCase());
      return !!row && row.live;
    },
  };
}

export type ContinueShotPorts = {
  /** Coordinator passes `service.getWorkspace`. Read-only, project scoped. */
  getWorkspace(actor: Actor, projectId: string): Promise<Workspace>;
  /** Coordinator passes `service.extractReferenceFrame`. Operator-only, ownership checked server-side. */
  extractReferenceFrame(actor: Actor, input: { projectId: string; assetId: string; frame: 'first' | 'last' }): Promise<Asset>;
  /** Coordinator passes `service.command`. */
  command(actor: Actor, cmd: Command): Promise<Receipt>;
  journal: ContinueShotJournal;
  now?: () => string;
  /** Lease lifetime for one run. Short values are only useful for takeover tests. */
  leaseTtlMs?: number;
};

export type ContinueShotRequest = {
  /** Caller-generated idempotency key for one operator intention. Reuse it to resume/retry. */
  operationId: string;
  projectId: string;
  sourceTakeId: string;
  title?: string;
  prompt: string;
};

export type ContinueShotOutcome = {
  operationId: string;
  projectId: string;
  status: 'completed' | 'partial' | 'blocked';
  resumed: boolean;
  sourceTakeId: string;
  sourceShotId: string;
  sourceAssetId: string;
  sourceAssetSha256: string;
  extractedAssetId: string | null;
  shotId: string | null;
  shotRevision: number | null;
  firstFrameAssetId: string | null;
  lastFrameAssetId: string | null;
  nextStep: 'extract' | 'create' | 'bind' | 'done' | 'reconcile';
  commandIds: { shotCreate: string; shotBind: string };
  lineage: { sourceTakeId: string; sourceShotId: string; sourceAssetId: string; sourceAssetSha256: string; extractedAssetId: string };
  code: string | null;
  message: string | null;
  resumable: boolean;
};

const MAX_TITLE = 500, MAX_PROMPT = 100_000;

/**
 * Public, minimal snapshot of one continuation. It exists so a reopened project can recover the
 * authoritative request state without the browser holding it, and without exposing the frozen
 * creative intention: no prompt, title, command payload, intent hash, lease token or command id.
 */
export type ContinueShotPublicStatus = 'completed' | 'partial' | 'blocked' | 'in_progress' | 'unknown';

export type ContinueShotPublicView = {
  operationId: string;
  projectId: string;
  status: ContinueShotPublicStatus;
  /** True only when an explicit resume would be accepted right now. */
  resumable: boolean;
  /** True while a live worker lease owns this operation. */
  active: boolean;
  sourceTakeId: string;
  sourceShotId: string;
  sourceAssetId: string;
  extractedAssetId: string | null;
  shotId: string | null;
  shotRevision: number | null;
  nextStep: ContinueShotOutcome['nextStep'];
  /** Server-authored blocker codes only. */
  blockers: string[];
  /** Server-authored message only; never raw driver or provider text. */
  message: string | null;
  updatedAt: string;
};

/**
 * Error codes that the media port uses for refusals it can prove happened BEFORE any extraction
 * side effect. Anything else (unknown 5xx, network failure, timeout) may have committed a frame
 * and is therefore irreconcilable on restart. The coordinator must confirm this list against the
 * real `extractReferenceFrame` implementation before exposing the route.
 */
export const EXTRACTION_PRE_DISPATCH_CODES = Object.freeze([
  'MEDIA_UNAVAILABLE', 'EXTRACTION_UNAVAILABLE', 'FRAME_EXTRACTION_UNAVAILABLE', 'NOT_CONFIGURED',
]);

export function extractionDefinitelyNotDispatched(error: unknown): boolean {
  if (!(error instanceof ServiceError)) return false;
  if (typeof error.status === 'number' && error.status >= 400 && error.status < 500) return true;
  return error.status === 503 && EXTRACTION_PRE_DISPATCH_CODES.includes(error.code);
}

/** Deterministic per-step command id. RFC-4122 shaped so it passes the real IdSchema/CommandIdSchema. */
export function deriveContinueShotCommandId(operationId: string, step: 'create' | 'bind'): string {
  const hex = createHash('sha256').update(`flume/continue-shot/${operationId}/${step}`).digest('hex').slice(0, 32).split('');
  hex[12] = '8';
  hex[16] = '8';
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function lastFrameOf(asset: Asset, sourceAssetId: string, sourceSha256: string) {
  const provenance = asset.provenance as { kind?: unknown; frame?: unknown; sourceAssetId?: unknown; sourceSha256?: unknown } | undefined;
  return asset.kind === 'image' && provenance?.kind === 'extracted-frame' && provenance.frame === 'last' &&
    provenance.sourceAssetId === sourceAssetId && provenance.sourceSha256 === sourceSha256;
}

/**
 * Lease liveness as the READ surface can observe it. `unknown` is not "idle": a journal that cannot
 * answer (no optional probe, or a probe that failed) must not have its silence read as "nothing is
 * running", because that is exactly what would authorize an unsafe retry.
 */
type ContinueShotLiveness = 'live' | 'idle' | 'unknown';

/** True only for progress that is already committed to the journal. */
function committedProgress(record: ContinueShotRecord): boolean {
  return record.extractedAssetId !== null || record.shotId !== null;
}

function nextStepOf(record: ContinueShotRecord): ContinueShotOutcome['nextStep'] {
  if (record.status === 'completed') return 'done';
  if (record.status === 'extraction_unknown') return 'reconcile';
  if (!record.extractedAssetId) return 'extract';
  if (!record.shotId) return 'create';
  return 'bind';
}

/**
 * Honest projection of the journal onto the five states the operator can be shown.
 *
 * Two independent facts decide it: what has been COMMITTED (an extracted frame or a created shot)
 * and what liveness has been OBSERVED (a live fenced lease, a verified idle row, or neither).
 *
 *  - `completed` and `extraction_unknown` are journal-authored terminal states.
 *  - committed progress is `partial`, whatever the journal status: nothing that really happened is
 *    reported as less than it is.
 *  - without committed progress, `in_progress` requires a lease somebody actually holds. A row
 *    nobody holds is never "in progress"; claiming it would be inventing work.
 *  - a dispatched extraction with no result and no holder is `unknown`/`reconcile`: a retry could
 *    commit a second frame, so it is not an ordinary extraction retry.
 *  - when liveness cannot be observed at all, the state is `unknown` and nothing is offered.
 */
function publicStatusOf(record: ContinueShotRecord, liveness: ContinueShotLiveness): ContinueShotPublicStatus {
  if (record.status === 'completed') return 'completed';
  if (record.status === 'extraction_unknown') return 'unknown';
  if (committedProgress(record)) return 'partial';
  if (liveness === 'live') return 'in_progress';
  if (liveness === 'unknown') return 'unknown';
  // Verified idle with nothing committed: an extraction that was dispatched may still commit.
  return record.extractionDispatched ? 'unknown' : 'blocked';
}

function publicView(record: ContinueShotRecord, liveness: ContinueShotLiveness): ContinueShotPublicView {
  const status = publicStatusOf(record, liveness);
  const terminal = status === 'completed' || status === 'unknown';
  return {
    operationId: record.operationId, projectId: record.projectId, status,
    // Only a verified-idle, non-terminal state may be resumed: no resume while a worker may hold the
    // lease, and none for a state whose extraction may already have committed.
    resumable: record.resumable && liveness === 'idle' && !terminal,
    active: liveness === 'live',
    sourceTakeId: record.sourceTakeId, sourceShotId: record.sourceShotId, sourceAssetId: record.sourceAssetId,
    extractedAssetId: record.extractedAssetId, shotId: record.shotId, shotRevision: record.shotRevision,
    nextStep: status === 'unknown' ? 'reconcile' : nextStepOf(record),
    blockers: [...record.blockers],
    message: record.message,
    updatedAt: record.updatedAt,
  };
}

function safeDetail(error: unknown): string | null {
  // Only server-authored ServiceError messages are safe to echo; raw driver/network text is not.
  return error instanceof ServiceError ? error.message : null;
}

export function continueShotIntentHash(input: {
  projectId: string; sourceTakeId: string; sourceAssetId: string; sourceAssetSha256: string;
  title: string; prompt: string; actorId: string; actorKind: Actor['kind'];
}): string {
  return fingerprintPayload(input);
}

export function createContinueShot(ports: ContinueShotPorts) {
  const now = ports.now ?? (() => new Date().toISOString());

  async function continueShot(rawActor: Actor, request: ContinueShotRequest): Promise<ContinueShotOutcome> {
    const actor = actorSchema.parse(rawActor);
    if (!request || typeof request !== 'object') throw new ServiceError('INVALID_REQUEST', 'A continue operation requires an explicit request.', 400);
    if (typeof request.sourceTakeId !== 'string' || request.sourceTakeId.length === 0) throw new ServiceError('TAKE_REQUIRED', 'An explicit project-owned take must be selected.', 400);
    for (const key of ['operationId', 'projectId', 'sourceTakeId'] as const) {
      if (!uuid.safeParse(request[key]).success) throw new ServiceError('INVALID_REQUEST', `A UUID ${key} is required.`, 400);
    }
    if (typeof request.prompt !== 'string' || request.prompt.trim().length === 0) throw new ServiceError('PROMPT_REQUIRED', 'The next shot needs a prompt before it can be created.', 400);
    if (request.prompt.length > MAX_PROMPT) throw new ServiceError('INVALID_PROMPT', 'The next shot prompt is too long.', 400);
    const title = typeof request.title === 'string' ? request.title.trim() : '';
    if (title.length > MAX_TITLE) throw new ServiceError('INVALID_TITLE', 'The next shot title is too long.', 400);

    authorize(actor, request.projectId);
    // Extraction is operator-only upstream; fail here with the same intent instead of half-running.
    if (actor.kind !== 'operator') throw new ServiceError('OPERATOR_REQUIRED', 'Only the configured operator may continue a take.', 403);

    const projectId = request.projectId, operationId = request.operationId, operationKey = operationId.toLowerCase();
    const workspace = await ports.getWorkspace(actor, projectId);
    const take = workspace.takes.find(item => item.id.toLowerCase() === request.sourceTakeId.toLowerCase() && item.projectId.toLowerCase() === projectId.toLowerCase());
    if (!take) throw new ServiceError('TAKE_NOT_FOUND', 'Owned take not found in this project. Select a take explicitly.', 404);
    const asset = workspace.assets.find(item => item.id.toLowerCase() === take.assetId.toLowerCase());
    if (!asset || asset.projectId.toLowerCase() !== projectId.toLowerCase()) throw new ServiceError('TAKE_NOT_FOUND', 'The take has no owned media in this project.', 404);
    if (asset.kind !== 'video') throw new ServiceError('TAKE_NOT_VIDEO', 'Only a take backed by owned video can provide a last frame.', 422);

    const resolvedTitle = title || `Continue from take ${take.id.slice(0, 8)}`;
    const commandIds = { shotCreate: deriveContinueShotCommandId(operationId, 'create'), shotBind: deriveContinueShotCommandId(operationId, 'bind') };
    // Prove the ids we send satisfy the real command contract before any side effect.
    commandSchema.parse({ type: 'shot.create', commandId: commandIds.shotCreate, projectId, title: resolvedTitle, prompt: request.prompt });
    commandSchema.parse({ type: 'shot.update', commandId: commandIds.shotBind, projectId, shotId: take.shotId, expectedRevision: 0, patch: { bindings: { firstFrameAssetId: asset.id } } });

    const intentHash = continueShotIntentHash({
      projectId, sourceTakeId: take.id, sourceAssetId: asset.id, sourceAssetSha256: asset.sha256,
      title: resolvedTitle, prompt: request.prompt, actorId: actor.id, actorKind: actor.kind,
    });

    // Narrowed once, because a nested function cannot rely on the enclosing control-flow analysis.
    const resolvedTakeId = take.id, resolvedAssetId = asset.id;
    /** Changed intent and cross-actor replay are refused before ownership is taken (no side effect,
     *  no lease leak). Re-run after `begin` because a concurrent caller may have created the row. */
    function assertSameIntent(stored: ContinueShotRecord) {
      // Actor first: it is part of the intent hash, and replaying frozen command ids as another
      // actor would mint a new resource instead of replaying the receipt.
      if (stored.actorId !== actor.id || stored.actorKind !== actor.kind) {
        throw new ServiceError('CONTINUE_ACTOR_MISMATCH', 'This operation belongs to a different actor. Only that operator can replay its frozen command ids.', 409);
      }
      if (stored.projectId.toLowerCase() !== projectId.toLowerCase() || stored.sourceTakeId.toLowerCase() !== resolvedTakeId.toLowerCase()) {
        throw new ServiceError('CONTINUE_INTENT_CONFLICT', 'This operation already continues a different take.', 409);
      }
      if (stored.intentHash !== intentHash || stored.title !== resolvedTitle || stored.prompt !== request.prompt
        || stored.sourceAssetId.toLowerCase() !== resolvedAssetId.toLowerCase()) {
        throw new ServiceError('CONTINUE_INTENT_CONFLICT', 'This operation already accepted different shot intent. Start a new operation instead.', 409);
      }
    }

    const prior = await ports.journal.load(operationId);
    if (prior) {
      assertSameIntent(prior);
      if (prior.status === 'completed') return outcome(prior, 'completed', true, { shotRevision: prior.shotRevision ?? 1 });
    }

    const begun = await ports.journal.begin({
      operationId, projectId, actorId: actor.id, actorKind: actor.kind, intentHash,
      sourceTakeId: take.id, sourceShotId: take.shotId,
      sourceAssetId: asset.id, sourceAssetSha256: asset.sha256,
      title: resolvedTitle, prompt: request.prompt,
      status: 'pending', extractionDispatched: false, extractedAssetId: null, shotId: null, shotRevision: null,
      createPayload: null, createPayloadHash: null, bindPayload: null, bindPayloadHash: null,
      blockers: [], message: null, resumable: true, updatedAt: now(),
    }, { ttlMs: ports.leaseTtlMs });

    let record = begun.record;
    const resumed = !begun.created;
    const held: ContinueShotGuard | null = begun.lease
      ? { ownerToken: begun.lease.ownerToken, fence: begun.lease.fence }
      : null;

    // Intent, actor and terminal state are checked BEFORE ownership is needed: they require no side
    // effect, and a caller who reused somebody else's operation id must be told that, not "busy".
    if (resumed) {
      try {
        assertSameIntent(record);
      } catch (error) {
        if (held) await ports.journal.release(operationKey, held);
        throw error;
      }
      if (record.status === 'completed') {
        if (held) await ports.journal.release(operationKey, held);
        return outcome(record, 'completed', resumed, { shotRevision: record.shotRevision ?? 1 });
      }
    }

    // Another process owns this operation right now. Return before ANY side effect (in particular
    // before extraction): absence of a derived frame is not proof that its extraction did not commit.
    if (!held) {
      throw new ServiceError('CONTINUE_IN_PROGRESS', 'Another request is already continuing this take. Nothing was extracted or created; reload in a moment.', 409);
    }
    const guard: ContinueShotGuard = held;

    try {

      async function advance(patch: Partial<ContinueShotRecord>): Promise<ContinueShotRecord> {
        const next = { ...record, ...patch, updatedAt: now() };
        const saved = await ports.journal.save(next, [record.status], guard);
        if (!saved) {
          const latest = await ports.journal.load(operationKey);
          if (latest?.status === 'completed') return latest;
          throw new ServiceError('CONTINUE_CONCURRENT', 'This continuation was advanced by another request. Reload before retrying.', 409);
        }
        record = saved;
        return saved;
      }

      async function settle(code: string, message: string, status: 'partial' | 'blocked', resumable: boolean, options: {
        journalStatus?: ContinueShotJournalStatus; patch?: Partial<ContinueShotOutcome>; record?: Partial<ContinueShotRecord>;
      } = {}): Promise<ContinueShotOutcome> {
        await advance({
          status: options.journalStatus ?? 'blocked',
          message, resumable,
          blockers: [...record.blockers, code],
          ...(options.record ?? {}),
        });
        return outcome(record, status, resumed, { code, message, resumable, ...(options.patch ?? {}) });
      }

      // 1. Last-frame extraction. The only step that cannot be made idempotent by command id.
      if (!record.extractedAssetId) {
        if (record.extractionDispatched) {
          // A previous owner (possibly this process before a crash) dispatched extraction. Reconcile
          // from persisted provenance; never assume the dispatch failed.
          const candidates = workspace.assets.filter(item => lastFrameOf(item, record.sourceAssetId, record.sourceAssetSha256));
          if (candidates.length > 1) {
            return await settle('EXTRACTION_AMBIGUOUS', `${candidates.length} derived last frames already exist for this take. This operation will not guess which one to bind.`, 'blocked', false);
          }
          if (candidates.length === 1) {
            await advance({ status: 'extracted', extractedAssetId: candidates[0].id, message: null, resumable: true });
          } else {
            return await settle(
              'EXTRACTION_UNKNOWN',
              'A last-frame extraction was dispatched but no derived frame is visible. It may still commit, so this operation will not extract again. Inspect the project media, then start a new operation only if no frame appears.',
              'blocked', false, { journalStatus: 'extraction_unknown' },
            );
          }
        }

        if (!record.extractedAssetId) {
          // Durable "dispatched" marker BEFORE the side effect. If we die after this write and the
          // frame never appears, the next owner reports unknown instead of extracting twice.
          await advance({ status: 'extracting', extractionDispatched: true, message: null, resumable: true });
          let derived: Asset;
          try {
            derived = await ports.extractReferenceFrame(actor, { projectId, assetId: record.sourceAssetId, frame: 'last' });
          } catch (error) {
            const detail = safeDetail(error);
            if (extractionDefinitelyNotDispatched(error)) {
              // The port proved nothing was dispatched, so clearing the flag is honest and a retry
              // cannot duplicate a frame.
              return await settle(
                'EXTRACTION_FAILED',
                `The last frame could not be extracted, so nothing was created.${detail ? ` ${detail}` : ''} Retry with the same operation to try again.`,
                'blocked', true, { record: { extractionDispatched: false } },
              );
            }
            return await settle(
              'EXTRACTION_UNKNOWN',
              `The last frame extraction did not report a usable result and may have committed. Nothing further will be created; inspect the project media before retrying with a new operation.${detail ? ` ${detail}` : ''}`,
              'blocked', false, { journalStatus: 'extraction_unknown' },
            );
          }
          if (derived.projectId.toLowerCase() !== projectId.toLowerCase() || derived.kind !== 'image') {
            return await settle('EXTRACTION_INTEGRITY', 'The extracted frame does not belong to this project as an owned image.', 'blocked', false);
          }
          await advance({ status: 'extracted', extractedAssetId: derived.id, message: null, resumable: true });
        }
      }

      // 2. Create the next shot with the real shot.create command (empty bindings), frozen payload.
      if (!record.shotId) {
        const payload: ContinueShotCommand = record.createPayload ?? {
          type: 'shot.create', commandId: commandIds.shotCreate, projectId, title: record.title, prompt: record.prompt,
        };
        if (payload.commandId !== commandIds.shotCreate || payload.projectId.toLowerCase() !== projectId.toLowerCase()
          || payload.title !== record.title || payload.prompt !== record.prompt
          || (record.createPayloadHash !== null && record.createPayloadHash !== fingerprintPayload(payload))) {
          throw new ServiceError('CONTINUE_INTEGRITY', 'The frozen shot create payload no longer matches this operation. Nothing was sent.', 500);
        }
        if (record.createPayload) {
          await advance({ status: 'creating', message: null, resumable: true });
        } else {
          await advance({
            status: 'creating', message: null, resumable: true,
            createPayload: payload, createPayloadHash: fingerprintPayload(payload),
          });
        }
        let receipt: Receipt;
        try {
          receipt = await ports.command(actor, { ...(record.createPayload ?? payload) } as Command);
        } catch (error) {
          const detail = safeDetail(error);
          return await settle(
            'CREATE_FAILED',
            `The next shot was not created. The extracted last frame is recorded as ${record.extractedAssetId}; retry with the same operation to continue.${detail ? ` ${detail}` : ''}`,
            'partial', true,
          );
        }
        if (!receipt?.resourceId || !uuid.safeParse(receipt.resourceId).success) {
          return await settle('CREATE_RECEIPT_INVALID', 'The shot create receipt did not return a usable shot id. The last frame is recorded; investigate before retrying.', 'partial', false);
        }
        await advance({ status: 'created', shotId: receipt.resourceId, shotRevision: receipt.revision ?? 1, message: null, resumable: true });
      }

      // 3. Bind the extracted frame as the FIRST frame only. The opposite frame is never written or cleared.
      const shotId = record.shotId!;
      const bindPayload: ContinueShotCommand = record.bindPayload ?? {
        type: 'shot.update', commandId: commandIds.shotBind, projectId, shotId,
        expectedRevision: record.shotRevision ?? 1,
        patch: { bindings: { firstFrameAssetId: record.extractedAssetId! } },
      };
      if (bindPayload.commandId !== commandIds.shotBind || bindPayload.projectId.toLowerCase() !== projectId.toLowerCase()
        || bindPayload.shotId?.toLowerCase() !== shotId.toLowerCase()
        || bindPayload.patch?.bindings.firstFrameAssetId?.toLowerCase() !== record.extractedAssetId!.toLowerCase()
        || 'lastFrameAssetId' in (bindPayload.patch?.bindings ?? {})
        || (record.bindPayloadHash !== null && record.bindPayloadHash !== fingerprintPayload(bindPayload))) {
        throw new ServiceError('CONTINUE_INTEGRITY', 'The frozen first-frame bind payload no longer matches this operation. Nothing was sent.', 500);
      }
      if (!record.bindPayload) {
        await advance({
          status: 'binding', message: null, resumable: true,
          bindPayload, bindPayloadHash: fingerprintPayload(bindPayload),
        });
      } else {
        await advance({ status: 'binding', message: null, resumable: true });
      }

      let bindFailure: unknown = null;
      try {
        await ports.command(actor, { ...(record.bindPayload ?? bindPayload) } as Command);
      } catch (error) { bindFailure = error; }

      // Authoritative readback: a thrown command may still have committed, and a returned receipt is not readback.
      const after = await ports.getWorkspace(actor, projectId);
      const shot = after.shots.find(item => item.id === shotId);
      if (!shot) return await settle('SHOT_MISSING', 'The new shot could not be read back after binding.', 'blocked', false, { patch: { shotId, firstFrameAssetId: null, lastFrameAssetId: null } });
      const firstFrameAssetId = shot.bindings.firstFrameAssetId ?? null, lastFrameAssetId = shot.bindings.lastFrameAssetId ?? null;
      if (lastFrameAssetId !== null) {
        return await settle(
          'LAST_FRAME_NOT_EMPTY',
          `The new shot already has last frame ${lastFrameAssetId}. This operation never clears the opposite frame.`,
          'blocked', false, { patch: { shotId, shotRevision: shot.revision, firstFrameAssetId, lastFrameAssetId } },
        );
      }
      if (firstFrameAssetId?.toLowerCase() === record.extractedAssetId!.toLowerCase()) {
        await advance({ status: 'completed', shotRevision: shot.revision, message: null, resumable: false });
        return outcome(record, 'completed', resumed, { shotRevision: shot.revision, firstFrameAssetId: record.extractedAssetId, lastFrameAssetId: null });
      }
      if (bindFailure instanceof ServiceError && (bindFailure.code === 'REVISION_CONFLICT' || bindFailure.code === 'COMMAND_CONFLICT')) {
        return await settle(
          'BIND_CONFLICT',
          `The first frame was not bound because the new shot changed (now revision ${shot.revision}, first frame ${firstFrameAssetId ?? 'empty'}). The extracted frame and the new shot remain; resolve the shot before retrying.`,
          'blocked', false, { patch: { shotId, shotRevision: shot.revision, firstFrameAssetId, lastFrameAssetId } },
        );
      }
      const detail = safeDetail(bindFailure);
      return await settle(
        'BIND_FAILED',
        `Binding the first frame did not take effect. The new shot ${shotId} and the extracted frame ${record.extractedAssetId} are recorded; retry with the same operation.${detail ? ` ${detail}` : ''}`,
        'partial', true, { patch: { shotId, shotRevision: shot.revision, firstFrameAssetId, lastFrameAssetId } },
      );
    } finally {
      await ports.journal.release(operationKey, guard);
    }
  }

  /**
   * Observe lease liveness without acquiring, renewing or releasing anything. A journal with no
   * probe, or a probe that fails, yields `unknown` — never a silent "idle".
   */
  async function observeLiveness(operationId: string): Promise<ContinueShotLiveness> {
    const probe = ports.journal.isActive;
    if (typeof probe !== 'function') return 'unknown';
    try {
      return (await probe.call(ports.journal, operationId)) === true ? 'live' : 'idle';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Resolve one journal record for an authorized actor. A missing id, another project's operation
   * and another actor's operation are the same refusal, so the read surface cannot be used to probe
   * for existence or to read a prompt/state from a project the caller is not in.
   */
  async function scopedRecord(rawActor: Actor, request: { projectId: string; operationId: string }) {
    const actor = actorSchema.parse(rawActor);
    if (!request || typeof request !== 'object') {
      throw new ServiceError('INVALID_REQUEST', 'A continuation read requires an explicit project and operation id.', 400);
    }
    for (const key of ['projectId', 'operationId'] as const) {
      if (!uuid.safeParse(request[key]).success) throw new ServiceError('INVALID_REQUEST', `A UUID ${key} is required.`, 400);
    }
    authorize(actor, request.projectId);
    const record = await ports.journal.load(request.operationId);
    if (!record || record.projectId.toLowerCase() !== request.projectId.toLowerCase()
      || record.actorId !== actor.id || record.actorKind !== actor.kind) {
      throw new ServiceError('CONTINUE_NOT_FOUND', 'No continuation with that id is available in this project.', 404);
    }
    const liveness = await observeLiveness(record.operationId);
    return { actor, record, liveness };
  }

  /** Read-only recovery. Performs no extraction, create, bind, lease acquisition or journal write. */
  async function readContinueShot(rawActor: Actor, request: { projectId: string; operationId: string }): Promise<ContinueShotPublicView> {
    const { record, liveness } = await scopedRecord(rawActor, request);
    return publicView(record, liveness);
  }

  /**
   * Explicit resume of the frozen intention. The caller supplies only identity; the prompt, title
   * and take are replayed from the journal, so changed intent cannot be smuggled in under an
   * existing operation id. The gate is the SAME projection the read surface publishes, so a state
   * that is shown without a resume control can never be resumed behind the operator's back.
   */
  async function resumeContinueShot(rawActor: Actor, request: { projectId: string; operationId: string }): Promise<ContinueShotOutcome> {
    const { actor, record, liveness } = await scopedRecord(rawActor, request);
    const view = publicView(record, liveness);
    if (view.active) {
      throw new ServiceError('CONTINUE_IN_PROGRESS', 'Another request is already continuing this take. Nothing was extracted or created; reload in a moment.', 409);
    }
    if (!view.resumable) {
      throw new ServiceError('CONTINUE_NOT_RESUMABLE', `This continuation cannot be resumed.${view.message ? ` ${view.message}` : ' Start a new operation instead.'}`, 409);
    }
    return continueShot(actor, {
      operationId: record.operationId, projectId: record.projectId,
      sourceTakeId: record.sourceTakeId, title: record.title, prompt: record.prompt,
    });
  }

  function outcome(record: ContinueShotRecord, status: ContinueShotOutcome['status'], resumed: boolean, patch: Partial<ContinueShotOutcome>): ContinueShotOutcome {
    return {
      operationId: record.operationId, projectId: record.projectId, status, resumed,
      sourceTakeId: record.sourceTakeId, sourceShotId: record.sourceShotId,
      sourceAssetId: record.sourceAssetId, sourceAssetSha256: record.sourceAssetSha256,
      extractedAssetId: record.extractedAssetId, shotId: record.shotId, shotRevision: record.shotRevision,
      firstFrameAssetId: status === 'completed' ? record.extractedAssetId : null,
      lastFrameAssetId: null,
      nextStep: nextStepOf(record),
      commandIds: { shotCreate: deriveContinueShotCommandId(record.operationId, 'create'), shotBind: deriveContinueShotCommandId(record.operationId, 'bind') },
      lineage: {
        sourceTakeId: record.sourceTakeId, sourceShotId: record.sourceShotId,
        sourceAssetId: record.sourceAssetId, sourceAssetSha256: record.sourceAssetSha256,
        extractedAssetId: record.extractedAssetId ?? '',
      },
      code: null, message: record.message, resumable: record.resumable,
      ...patch,
    };
  }

  return { continueShot, readContinueShot, resumeContinueShot };
}
