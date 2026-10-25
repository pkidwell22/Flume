/**
 * Storyboard-to-shot proposals.
 *
 * A planner (injected) proposes an editable shot list. Nothing is generated and no shot exists
 * while the list is a proposal. An explicit operator acceptance turns the *reviewed* list into
 * real shots through the existing command port (`shot.create`) using deterministic command IDs,
 * so an interrupted application can resume without creating duplicates.
 *
 * Concurrency and crash contract (see also ./authoring-operation-lock.ts and migration 011):
 *  - acceptance is ONE compare-and-set in the store: `status = 'draft' AND revision = expected`
 *    becomes `applying`, and the exact `shot.create` payload plus the issuing actor are frozen in
 *    the same statement. Two concurrent accepts cannot both win, and neither can bypass a changed
 *    revision or a cancellation that landed first.
 *  - application runs under a durable, fenced lease. A second `accept`/`resume` observes the live
 *    lease and is refused without any side effect. A worker whose lease expired cannot record
 *    results: every item claim/settle/finish carries the fence.
 *  - resume sends the FROZEN payload bytes, never a reconstruction from live text, and only the
 *    actor recorded at acceptance may resume. This matters because command receipts are keyed by
 *    `(actor_id, command_id)`: a different actor could otherwise mint a second shot.
 *  - a definite 4xx refusal is recorded as failed; anything else is recorded as unknown and is
 *    reconciled on resume with the same command id (receipt replay), never auto-retried here.
 *
 * Deliberate boundaries:
 *  - this module never issues generation, approval, budget or provider commands, and it has no
 *    field that could carry one; a proposal is never spend authorization;
 *  - it does not persist cuts or pins. Accepted shot IDs are handed to the existing storyboard
 *    cut engine as `{ shotId, durationMs }` through `toPlanCuts()`;
 *  - planner output is validated, never repaired.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Receipt } from './contracts.ts';
import {
  DEFAULT_LEASE_TTL_MS,
  createMemoryAuthoringOperationLock,
  fingerprintPayload,
  type AuthoringLease,
  type AuthoringOperationLock,
} from './authoring-operation-lock.ts';

/**
 * The actor shape this service needs. It is structurally the platform `Actor` from
 * `./contracts.ts`; declaring it here keeps the module self-contained (no runtime import cycle)
 * and lets it be exercised without the domain package being built.
 */
export type StoryboardActor = { id: string; kind: 'operator' | 'agent'; projectIds: '*' | string[] };

/** Editorial bounds. Durations are authored intent, independent of any provider clip length. */
export const MIN_SHOT_SECONDS = 1;
export const MAX_SHOT_SECONDS = 60;
export const DEFAULT_MAX_SHOTS = 12;
export const HARD_MAX_SHOTS = 50;
export const DEFAULT_MAX_TOTAL_SECONDS = 600;

const UuidSchema = z.string().uuid();

export type StoryboardBounds = {
  minSeconds: number; maxSeconds: number; maxShots: number; maxTotalSeconds: number;
};

export const DEFAULT_BOUNDS: StoryboardBounds = Object.freeze({
  minSeconds: MIN_SHOT_SECONDS, maxSeconds: MAX_SHOT_SECONDS,
  maxShots: DEFAULT_MAX_SHOTS, maxTotalSeconds: DEFAULT_MAX_TOTAL_SECONDS,
});

/** One proposed cut. Authored timing only: no model, cost, approval or provider field exists. */
const ShotDraftSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  direction: z.string().trim().min(1).max(2_000),
  startDescription: z.string().trim().min(1).max(2_000),
  endDescription: z.string().trim().min(1).max(2_000),
  durationSeconds: z.number().int().min(MIN_SHOT_SECONDS).max(MAX_SHOT_SECONDS),
  continuityNotes: z.string().trim().max(2_000).default(''),
});
const ShotDraftOnly = ShotDraftSchema.omit({ continuityNotes: true });

const PlannerOutputSchema = z.strictObject({
  shots: z.array(ShotDraftSchema).min(1).max(HARD_MAX_SHOTS),
});

/** Edits are parsed permissively on duration so that an out-of-bounds edit is reported as an
 * edit refusal (`PROPOSAL_INVALID_EDIT` with its field path), not as a malformed request. */
const EditItemSchema = z.strictObject({ itemId: UuidSchema, ...ShotDraftOnly.shape, durationSeconds: z.number().int().min(0).max(86_400), continuityNotes: z.string().trim().max(2_000) });

const ProposeSchema = z.strictObject({ projectId: UuidSchema, brief: z.string().trim().max(20_000), maxShots: z.number().int().min(1).max(HARD_MAX_SHOTS).optional() });
const AddressSchema = z.strictObject({ projectId: UuidSchema, proposalId: UuidSchema });
const ReviseRequestSchema = AddressSchema.extend({ expectedRevision: z.number().int().nonnegative(), items: z.array(EditItemSchema).min(1).max(HARD_MAX_SHOTS) });
const AcceptRequestSchema = AddressSchema.extend({ expectedRevision: z.number().int().nonnegative() });
const ResumeRequestSchema = AddressSchema.extend({ retryFailed: z.boolean().optional() });

export type ShotDraft = z.infer<typeof ShotDraftSchema>;
export type ItemState = 'pending' | 'created' | 'failed' | 'unknown';
export type ProposalStatus = 'draft' | 'applying' | 'applied' | 'partial' | 'unknown' | 'cancelled';

export type ProposalItem = ShotDraft & {
  /** Immutable identity assigned at proposal time; edits never change it. */
  itemId: string;
  state: ItemState;
  /** Confirmed shot from a command receipt. Never inferred. */
  shotId: string | null;
  /** Deterministic `shot.create` command ID, assigned once at acceptance and reused on resume. */
  commandId: string | null;
  code: string | null;
};

export type StoryboardProposal = {
  id: string;
  projectId: string;
  status: ProposalStatus;
  /** Reviewed edit count. Acceptance does not bump it: acceptance is not an edit. */
  revision: number;
  createdAt: string;
  bounds: StoryboardBounds;
  items: ProposalItem[];
  cancelRequested: boolean;
  failure: { itemId: string; code: string; message: string } | null;
  provenance: { plannerModelId: string; requestHash: string; proposedBy: string; proposedByKind: StoryboardActor['kind']; acceptedBy: string | null; acceptedByKind: StoryboardActor['kind'] | null };
};

export type ShotCreateCommand = { type: 'shot.create'; commandId: string; projectId: string; title: string; prompt: string };
/** The application port. Wired by the coordinator to the existing service.command handler. */
export type StoryboardCommandPort = (actor: StoryboardActor, command: ShotCreateCommand) => Promise<Receipt>;
export type StoryboardPlanner = { modelId: string; propose(input: { projectId: string; brief: string; bounds: StoryboardBounds }): Promise<unknown> };

/** Exact command bytes frozen at acceptance, plus the actor that will issue them. */
export type FrozenShotCreate = {
  itemId: string;
  commandId: string;
  payload: ShotCreateCommand;
  payloadHash: string;
  actorId: string;
  actorKind: StoryboardActor['kind'];
};

export type StoryboardAcceptInput = {
  projectId: string;
  proposalId: string;
  expectedRevision: number;
  acceptedBy: string;
  acceptedByKind: StoryboardActor['kind'];
  commands: { itemId: string; commandId: string; payload: ShotCreateCommand; payloadHash: string }[];
};

export type StoryboardItemSettlement = {
  projectId: string; proposalId: string; itemId: string;
  state: 'created' | 'failed' | 'unknown';
  shotId: string | null;
  code: string | null;
  lease: AuthoringLease;
};

/**
 * Store port. Ownership/lease operations live behind it so the service cannot accidentally write
 * without a fence. The SQL adapter is ./storyboard-store.ts (`createSqlStoryboardStore(executor)`);
 * it requires migration 011 and a live `store.lease`.
 */
export interface StoryboardProposalStore {
  /** Durable operation ownership. The service uses it for every application run. */
  readonly lease: AuthoringOperationLock;
  /** Create a draft. Must be create-if-absent: an existing row is never overwritten. */
  save(proposal: StoryboardProposal): Promise<void>;
  /** Atomic edit: applies only when the stored row is still `draft` at `expectedRevision`. */
  saveDraft(proposal: StoryboardProposal, expectedRevision: number): Promise<StoryboardProposal | null>;
  load(projectId: string, proposalId: string): Promise<StoryboardProposal | null>;
  list(projectId: string): Promise<StoryboardProposal[]>;
  /** Frozen commands recorded at acceptance, in review order. Empty before acceptance. */
  loadFrozen(projectId: string, proposalId: string): Promise<FrozenShotCreate[]>;
  /** Atomic CAS: draft+revision -> applying, freezing commands and actor in the same statement. */
  accept(input: StoryboardAcceptInput): Promise<StoryboardProposal | null>;
  /** Durable cancellation intent. Cancels a draft outright; only flags an in-flight application. */
  requestCancel(projectId: string, proposalId: string): Promise<StoryboardProposal | null>;
  claimItem(input: { projectId: string; proposalId: string; itemId: string; allowFailed: boolean; lease: AuthoringLease }): Promise<boolean>;
  settleItem(input: StoryboardItemSettlement): Promise<boolean>;
  finish(input: { projectId: string; proposalId: string; status: ProposalStatus; failure: StoryboardProposal['failure']; lease: AuthoringLease }): Promise<StoryboardProposal | null>;
}

/**
 * Reference store for tests and single-process fixtures. NOT cross-process durable: the lease and
 * every compare-and-set below run inside one JavaScript event loop turn, so they are honest only
 * for a single process. Use `createSqlStoryboardStore` for a real deployment.
 */
export class InMemoryProposalStore implements StoryboardProposalStore {
  readonly lease: AuthoringOperationLock;
  private readonly rows = new Map<string, StoryboardProposal>();
  private readonly frozen = new Map<string, FrozenShotCreate[]>();
  private readonly key = (projectId: string, proposalId: string) => `${projectId.toLowerCase()}/${proposalId.toLowerCase()}`;

  constructor(options: { lease?: AuthoringOperationLock; now?: () => number } = {}) {
    this.lease = options.lease ?? createMemoryAuthoringOperationLock({ now: options.now });
  }

  private live(lease: AuthoringLease, projectId: string): boolean {
    const peek = (this.lease as AuthoringOperationLock & { peekSync?: (scope: string, operationId: string) => { ownerToken: string; fence: number; live: boolean; projectId: string } | null }).peekSync;
    if (peek) {
      const row = peek.call(this.lease, lease.scope, lease.operationId);
      return !!row && row.live && row.ownerToken === lease.ownerToken && row.fence === lease.fence
        && row.projectId.toLowerCase() === projectId.toLowerCase();
    }
    return false;
  }

  async save(proposal: StoryboardProposal) {
    const key = this.key(proposal.projectId, proposal.id);
    if (this.rows.has(key)) return;
    this.rows.set(key, structuredClone(proposal));
  }

  async saveDraft(proposal: StoryboardProposal, expectedRevision: number) {
    const key = this.key(proposal.projectId, proposal.id);
    const row = this.rows.get(key);
    if (!row || row.status !== 'draft' || row.revision !== expectedRevision) return null;
    const next = structuredClone(proposal);
    this.rows.set(key, next);
    return structuredClone(next);
  }

  async load(projectId: string, proposalId: string) {
    const row = this.rows.get(this.key(projectId, proposalId));
    return row ? structuredClone(row) : null;
  }

  async list(projectId: string) {
    return [...this.rows.values()].filter(row => row.projectId.toLowerCase() === projectId.toLowerCase())
      .map(row => structuredClone(row)).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async loadFrozen(projectId: string, proposalId: string) {
    const rows = this.frozen.get(this.key(projectId, proposalId));
    return rows ? structuredClone(rows) : [];
  }

  async accept(input: StoryboardAcceptInput) {
    const key = this.key(input.projectId, input.proposalId);
    const row = this.rows.get(key);
    if (!row || row.status !== 'draft' || row.revision !== input.expectedRevision || row.cancelRequested) return null;
    row.status = 'applying';
    row.failure = null;
    row.provenance.acceptedBy = input.acceptedBy;
    row.provenance.acceptedByKind = input.acceptedByKind;
    row.items = row.items.map(item => {
      const command = input.commands.find(entry => entry.itemId.toLowerCase() === item.itemId.toLowerCase());
      return command ? { ...item, commandId: command.commandId } : item;
    });
    this.frozen.set(key, input.commands.map(command => ({
      itemId: command.itemId,
      commandId: command.commandId,
      payload: structuredClone(command.payload),
      payloadHash: command.payloadHash,
      actorId: input.acceptedBy,
      actorKind: input.acceptedByKind,
    })));
    return structuredClone(row);
  }

  async requestCancel(projectId: string, proposalId: string) {
    const row = this.rows.get(this.key(projectId, proposalId));
    if (!row || row.status === 'applied') return null;
    row.cancelRequested = true;
    if (row.status === 'draft') row.status = 'cancelled';
    return structuredClone(row);
  }

  async claimItem(input: { projectId: string; proposalId: string; itemId: string; allowFailed: boolean; lease: AuthoringLease }) {
    const row = this.rows.get(this.key(input.projectId, input.proposalId));
    if (!row || row.cancelRequested || row.status === 'cancelled') return false;
    if (!this.live(input.lease, input.projectId)) return false;
    const item = row.items.find(entry => entry.itemId.toLowerCase() === input.itemId.toLowerCase());
    if (!item) return false;
    if (item.state === 'created') return false;
    if (item.state === 'failed' && !input.allowFailed) return false;
    return true;
  }

  async settleItem(input: StoryboardItemSettlement) {
    const row = this.rows.get(this.key(input.projectId, input.proposalId));
    if (!row || !this.live(input.lease, input.projectId)) return false;
    const item = row.items.find(entry => entry.itemId.toLowerCase() === input.itemId.toLowerCase());
    if (!item || item.state === 'created') return false;
    item.state = input.state;
    item.shotId = input.state === 'created' ? input.shotId : null;
    item.code = input.code;
    return true;
  }

  async finish(input: { projectId: string; proposalId: string; status: ProposalStatus; failure: StoryboardProposal['failure']; lease: AuthoringLease }) {
    const row = this.rows.get(this.key(input.projectId, input.proposalId));
    if (!row || !this.live(input.lease, input.projectId)) return null;
    row.status = input.status;
    row.failure = input.failure === null ? null : structuredClone(input.failure);
    return structuredClone(row);
  }
}

export class StoryboardProposalError extends Error {
  constructor(public code: string, message: string, public status = 409, public currentRevision?: number, public details?: unknown) {
    super(message);
    this.name = 'StoryboardProposalError';
  }
}

const NAMESPACE = 'flume.storyboard-proposal/1';
/** UUIDv5-shaped deterministic identifier. Same input, same ID, across processes and restarts. */
function stableUuid(name: string): string {
  const bytes = Buffer.from(createHash('sha256').update(`${NAMESPACE}:${name}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const stableItemId = (proposalId: string, index: number) => stableUuid(`item:${proposalId.toLowerCase()}:${index}`);
export const stableCommandId = (proposalId: string, itemId: string) => stableUuid(`create:${proposalId.toLowerCase()}:${itemId.toLowerCase()}`);

/** The shot payload is authored prose; start/end and continuity are kept because they are the
 * only instruction the shot's later generation review needs. */
function shotPrompt(item: ShotDraft): string {
  const lines = [item.direction, `Start: ${item.startDescription}`, `End: ${item.endDescription}`];
  if (item.continuityNotes) lines.push(`Continuity: ${item.continuityNotes}`);
  return lines.join('\n\n');
}

function parseOrReject<T>(schema: z.ZodType<T>, value: unknown, code: string, message: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new StoryboardProposalError(code, message, 400, undefined, { issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
}

function boundIssues(shots: ShotDraft[], bounds: StoryboardBounds, base: string) {
  const issues: { path: string; message: string }[] = [];
  if (shots.length > bounds.maxShots) issues.push({ path: base, message: `A storyboard may propose at most ${bounds.maxShots} shots.` });
  shots.forEach((shot, index) => {
    if (shot.durationSeconds < bounds.minSeconds || shot.durationSeconds > bounds.maxSeconds) {
      issues.push({ path: `${base}.${index}.durationSeconds`, message: `Each shot must be between ${bounds.minSeconds} and ${bounds.maxSeconds} seconds.` });
    }
  });
  const total = shots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  if (total > bounds.maxTotalSeconds) issues.push({ path: base, message: `A proposed storyboard is limited to ${bounds.maxTotalSeconds} seconds.` });
  return issues;
}

/** A 4xx from the command port is a definite refusal with no side effect; anything else may have
 * been accepted, so it is treated as unknown and never retried automatically. */
function definiteFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}
const codeOf = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length <= 64 ? code : 'SHOT_REFUSED';
};
const messageOf = (error: unknown) => (error instanceof Error && error.message ? error.message.slice(0, 500) : 'The shot was refused.');

export type StoryboardProposalService = ReturnType<typeof createStoryboardProposalService>;

export function createStoryboardProposalService(deps: {
  planner: StoryboardPlanner;
  command: StoryboardCommandPort;
  store: StoryboardProposalStore;
  now?: () => string;
  /** Lease lifetime. Only shorter values are useful for takeover tests. */
  leaseTtlMs?: number;
}) {
  const { planner, command, store } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  if (!store?.lease || typeof store.lease.acquire !== 'function') {
    throw new TypeError('A StoryboardProposalStore with a durable `lease` is required; an in-process mutex is not cross-process ownership.');
  }
  const leasePort = store.lease;
  const ttlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;

  function authorize(actor: StoryboardActor, projectId: string) {
    if (!actor || typeof actor.id !== 'string' || (actor.kind !== 'operator' && actor.kind !== 'agent')) {
      throw new StoryboardProposalError('UNAUTHORIZED', 'An actor is required.', 401);
    }
    if (actor.projectIds !== '*' && !actor.projectIds.some(id => id.toLowerCase() === projectId.toLowerCase())) {
      throw new StoryboardProposalError('FORBIDDEN', 'Project access is not granted.', 403);
    }
  }
  function requireOperator(actor: StoryboardActor) {
    if (actor.kind !== 'operator') {
      throw new StoryboardProposalError('FORBIDDEN', 'Only an operator can create shots or change an accepted proposal.', 403);
    }
  }
  async function load(actor: StoryboardActor, projectId: string, proposalId: string) {
    authorize(actor, projectId);
    const proposal = await store.load(projectId, proposalId);
    if (!proposal) throw new StoryboardProposalError('PROPOSAL_NOT_FOUND', 'This storyboard proposal does not exist in this project.', 404);
    return proposal;
  }

  /** Validate planner output. A string is parsed as JSON exactly once; nothing is repaired. */
  function readProposal(raw: unknown, bounds: StoryboardBounds): ShotDraft[] {
    let value = raw;
    if (typeof raw === 'string') {
      try { value = JSON.parse(raw); }
      catch { throw new StoryboardProposalError('PLANNER_MALFORMED', 'The planner response was not valid JSON. Ask for a structured shot list again.', 422); }
    }
    const parsed = PlannerOutputSchema.safeParse(value);
    if (!parsed.success) {
      throw new StoryboardProposalError('PLANNER_INVALID', 'The planner response did not match the storyboard shot contract.', 422, undefined, {
        issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    const issues = boundIssues(parsed.data.shots, bounds, 'shots');
    if (issues.length) throw new StoryboardProposalError('PLANNER_INVALID', 'The planner response is outside the storyboard bounds.', 422, undefined, { issues });
    return parsed.data.shots;
  }

  async function propose(rawActor: StoryboardActor, rawInput: unknown): Promise<StoryboardProposal> {
    const input = parseOrReject(ProposeSchema, rawInput, 'INVALID_REQUEST', 'A project and a brief are required.');
    authorize(rawActor, input.projectId);
    const bounds: StoryboardBounds = { ...DEFAULT_BOUNDS, ...(input.maxShots ? { maxShots: input.maxShots } : {}) };
    const shots = readProposal(await planner.propose({ projectId: input.projectId, brief: input.brief, bounds }), bounds);
    const id = randomUUID();
    const proposal: StoryboardProposal = {
      id, projectId: input.projectId, status: 'draft', revision: 0, createdAt: now(), bounds,
      items: shots.map((shot, index) => ({ itemId: stableItemId(id, index), ...shot, state: 'pending', shotId: null, commandId: null, code: null })),
      cancelRequested: false, failure: null,
      provenance: {
        plannerModelId: planner.modelId,
        requestHash: createHash('sha256').update(JSON.stringify({ projectId: input.projectId, brief: input.brief, bounds, shots })).digest('hex'),
        proposedBy: rawActor.id, proposedByKind: rawActor.kind, acceptedBy: null, acceptedByKind: null,
      },
    };
    await store.save(proposal);
    return structuredClone(proposal);
  }

  async function read(rawActor: StoryboardActor, rawInput: unknown) {
    const input = parseOrReject(AddressSchema, rawInput, 'INVALID_REQUEST', 'A proposal address is required.');
    return load(rawActor, input.projectId, input.proposalId);
  }

  async function list(rawActor: StoryboardActor, projectId: string) {
    authorize(rawActor, projectId);
    return store.list(projectId);
  }

  /**
   * One reviewed edit. The item set is fixed at proposal time: edits may retitle, redirect,
   * retime and reorder, but never add or drop a cut, so what is applied is what was reviewed.
   */
  async function revise(rawActor: StoryboardActor, rawInput: unknown): Promise<StoryboardProposal> {
    const input = parseOrReject(ReviseRequestSchema, rawInput, 'INVALID_REQUEST', 'A proposal revision is required.');
    const proposal = await load(rawActor, input.projectId, input.proposalId);
    if (proposal.status !== 'draft') {
      throw new StoryboardProposalError('PROPOSAL_STATE', 'This proposal is no longer editable; its shots are already being, or have been, created.', 409, proposal.revision);
    }
    if (input.expectedRevision !== proposal.revision) {
      throw new StoryboardProposalError('REVISION_CONFLICT', 'This proposal changed. Reload before editing it.', 409, proposal.revision);
    }
    const known = new Map(proposal.items.map(item => [item.itemId.toLowerCase(), item]));
    const issues: { path: string; message: string }[] = [];
    const seen = new Set<string>();
    for (const [index, item] of input.items.entries()) {
      const key = item.itemId.toLowerCase();
      if (!known.has(key)) issues.push({ path: `items.${index}.itemId`, message: 'This cut is not part of the reviewed proposal.' });
      if (seen.has(key)) issues.push({ path: `items.${index}.itemId`, message: 'Each cut appears once.' });
      seen.add(key);
    }
    const missing = [...known.keys()].filter(key => !seen.has(key));
    if (missing.length) issues.push({ path: 'items', message: 'An edit cannot remove or add cuts; cancel the proposal and ask the planner again.' });
    issues.push(...boundIssues(input.items, proposal.bounds, 'items'));
    if (issues.length) throw new StoryboardProposalError('PROPOSAL_INVALID_EDIT', 'The edited storyboard is not valid.', 422, proposal.revision, { issues });

    const next: StoryboardProposal = {
      ...proposal,
      revision: proposal.revision + 1,
      failure: null,
      items: input.items.map(item => {
        const current = known.get(item.itemId.toLowerCase())!;
        return { ...current, ...item, itemId: current.itemId };
      }),
    };
    const saved = await store.saveDraft(next, input.expectedRevision);
    if (!saved) {
      const latest = await store.load(input.projectId, input.proposalId);
      if (!latest) throw new StoryboardProposalError('PROPOSAL_NOT_FOUND', 'This storyboard proposal does not exist in this project.', 404);
      if (latest.status !== 'draft') throw new StoryboardProposalError('PROPOSAL_STATE', 'This proposal is no longer editable; its shots are already being, or have been, created.', 409, latest.revision);
      throw new StoryboardProposalError('REVISION_CONFLICT', 'This proposal changed. Reload before editing it.', 409, latest.revision);
    }
    return saved;
  }

  function failureFor(item: ProposalItem) {
    return {
      itemId: item.itemId,
      code: item.code ?? 'SHOT_REFUSED',
      message: item.state === 'unknown'
        ? 'The outcome of this shot creation is unknown. Resume re-issues the same command.'
        : 'This cut was refused.',
    };
  }

  function firstProblem(proposal: StoryboardProposal) {
    const failed = proposal.items.find(item => item.state === 'failed');
    if (failed) return failureFor(failed);
    const unknown = proposal.items.find(item => item.state === 'unknown');
    return unknown ? failureFor(unknown) : null;
  }

  /**
   * Walk the frozen cut list under `held`. Created cuts are never re-issued; cancellation is
   * observed from durable state before every claim, and every write is fenced, so a worker whose
   * lease was taken over cannot record anything.
   */
  async function runApplication(input: {
    projectId: string; proposalId: string; actor: StoryboardActor; retryFailed: boolean; held: AuthoringLease;
  }): Promise<StoryboardProposal> {
    const { projectId, proposalId, actor, retryFailed, held } = input;
    const frozen = await store.loadFrozen(projectId, proposalId);
    const byItem = new Map(frozen.map(entry => [entry.itemId.toLowerCase(), entry]));
    if (!frozen.length) throw new StoryboardProposalError('PROPOSAL_INTEGRITY', 'This proposal has no frozen command payloads. Reload after investigation.', 500);
    for (const entry of frozen) {
      if (entry.commandId !== stableCommandId(proposalId, entry.itemId)
        || entry.payload.type !== 'shot.create'
        || entry.payload.commandId !== entry.commandId
        || entry.payload.projectId.toLowerCase() !== projectId.toLowerCase()
        || fingerprintPayload(entry.payload) !== entry.payloadHash
        || entry.actorId !== actor.id
        || entry.actorKind !== actor.kind) {
        throw new StoryboardProposalError('PROPOSAL_INTEGRITY', 'A frozen shot command no longer matches the accepted revision or actor. Nothing was sent.', 500);
      }
    }

    let cancelled = false;
    let leaseLost = false;
    const snapshot = await store.load(projectId, proposalId);
    if (!snapshot) throw new StoryboardProposalError('PROPOSAL_NOT_FOUND', 'This storyboard proposal does not exist in this project.', 404);

    for (const item of snapshot.items) {
      const live = await store.load(projectId, proposalId);
      if (!live) throw new StoryboardProposalError('PROPOSAL_NOT_FOUND', 'This storyboard proposal does not exist in this project.', 404);
      if (live.cancelRequested || live.status === 'cancelled') { cancelled = true; break; }
      const current = live.items.find(entry => entry.itemId.toLowerCase() === item.itemId.toLowerCase());
      if (!current || current.state === 'created') continue;
      if (current.state === 'failed' && !retryFailed) continue;

      const entry = byItem.get(item.itemId.toLowerCase());
      if (!entry) throw new StoryboardProposalError('PROPOSAL_INTEGRITY', 'A reviewed cut has no frozen command. Nothing was sent.', 500);

      const claimed = await store.claimItem({ projectId, proposalId, itemId: item.itemId, allowFailed: retryFailed, lease: held });
      if (!claimed) {
        const latest = await store.load(projectId, proposalId);
        if (!latest) throw new StoryboardProposalError('PROPOSAL_NOT_FOUND', 'This storyboard proposal does not exist in this project.', 404);
        if (latest.cancelRequested || latest.status === 'cancelled') { cancelled = true; break; }
        const settled = latest.items.find(entryItem => entryItem.itemId.toLowerCase() === item.itemId.toLowerCase());
        if (settled?.state === 'created') continue;
        leaseLost = true;
        break;
      }

      let state: 'created' | 'failed' | 'unknown';
      let shotId: string | null = null;
      let code: string | null = null;
      try {
        const receipt = await command(actor, structuredClone(entry.payload));
        const created = receipt?.resourceId;
        if (typeof created !== 'string' || !UuidSchema.safeParse(created).success) {
          state = 'unknown'; code = 'COMMAND_RECEIPT_INVALID';
        } else {
          state = 'created'; shotId = created; code = null;
        }
      } catch (error) {
        state = definiteFailure(error) ? 'failed' : 'unknown';
        code = definiteFailure(error) ? codeOf(error) : 'COMMAND_OUTCOME_UNKNOWN';
      }
      const settled = await store.settleItem({ projectId, proposalId, itemId: item.itemId, state, shotId, code, lease: held });
      if (!settled) { leaseLost = true; break; }
      // Stop at the first cut that did not confirm: an unknown or refused outcome is reported, not
      // papered over by creating later cuts in the same pass.
      if (state !== 'created') break;
    }

    const latest = await store.load(projectId, proposalId);
    if (!latest) throw new StoryboardProposalError('PROPOSAL_NOT_FOUND', 'This storyboard proposal does not exist in this project.', 404);
    const complete = latest.items.every(item => item.state === 'created');
    const cancelledNow = cancelled || latest.cancelRequested || latest.status === 'cancelled';
    const status: ProposalStatus = complete ? 'applied'
      : cancelledNow ? 'cancelled'
      : latest.items.some(item => item.state === 'failed') ? 'partial'
      : 'unknown';
    const failure = complete ? null : firstProblem(latest);
    const finished = leaseLost
      ? null
      : await store.finish({ projectId, proposalId, status, failure, lease: held });
    return finished ?? latest;
  }

  async function acquire(projectId: string, proposalId: string): Promise<AuthoringLease> {
    const result = await leasePort.acquire({ scope: 'storyboard.apply', operationId: proposalId.toLowerCase(), projectId, ttlMs });
    if (!result.lease) {
      throw new StoryboardProposalError('OPERATION_IN_PROGRESS', 'Another request is already applying this proposal. Nothing was sent.', 409);
    }
    return result.lease;
  }

  /** Explicit acceptance. Freezes reviewed content and actor, assigns one deterministic command ID
   * per cut and creates shots. It never generates media and never approves spending. */
  async function accept(rawActor: StoryboardActor, rawInput: unknown): Promise<StoryboardProposal> {
    const input = parseOrReject(AcceptRequestSchema, rawInput, 'INVALID_REQUEST', 'A proposal address and revision are required.');
    authorize(rawActor, input.projectId);
    requireOperator(rawActor);
    const proposal = await load(rawActor, input.projectId, input.proposalId);
    if (proposal.status === 'cancelled') throw new StoryboardProposalError('PROPOSAL_STATE', 'This proposal was cancelled. Ask the planner for a new one.', 409, proposal.revision);
    if (proposal.status !== 'draft') throw new StoryboardProposalError('PROPOSAL_STATE', 'This proposal is already being applied or has been applied.', 409, proposal.revision);
    if (input.expectedRevision !== proposal.revision) throw new StoryboardProposalError('REVISION_CONFLICT', 'This proposal changed. Reload before creating shots.', 409, proposal.revision);

    const commands = proposal.items.map(item => {
      const commandId = stableCommandId(proposal.id, item.itemId);
      const payload: ShotCreateCommand = {
        type: 'shot.create', commandId, projectId: proposal.projectId, title: item.title, prompt: shotPrompt(item),
      };
      return { itemId: item.itemId, commandId, payload, payloadHash: fingerprintPayload(payload) };
    });

    const accepted = await store.accept({
      projectId: input.projectId, proposalId: input.proposalId, expectedRevision: input.expectedRevision,
      acceptedBy: rawActor.id, acceptedByKind: rawActor.kind, commands,
    });
    if (!accepted) {
      const latest = await store.load(input.projectId, input.proposalId);
      if (!latest) throw new StoryboardProposalError('PROPOSAL_NOT_FOUND', 'This storyboard proposal does not exist in this project.', 404);
      if (latest.status === 'cancelled' || latest.cancelRequested) throw new StoryboardProposalError('PROPOSAL_STATE', 'This proposal was cancelled. Ask the planner for a new one.', 409, latest.revision);
      if (latest.status !== 'draft') throw new StoryboardProposalError('PROPOSAL_STATE', 'This proposal is already being applied or has been applied.', 409, latest.revision);
      throw new StoryboardProposalError('REVISION_CONFLICT', 'This proposal changed. Reload before creating shots.', 409, latest.revision);
    }

    const held = await acquire(input.projectId, input.proposalId);
    try {
      return await runApplication({ projectId: input.projectId, proposalId: input.proposalId, actor: rawActor, retryFailed: false, held });
    } finally {
      await leasePort.release(held);
    }
  }

  /** Continue an interrupted application. Same frozen payloads and command IDs, so the receipt
   * table replays instead of the project gaining a second shot. */
  async function resume(rawActor: StoryboardActor, rawInput: unknown): Promise<StoryboardProposal> {
    const input = parseOrReject(ResumeRequestSchema, rawInput, 'INVALID_REQUEST', 'A proposal address is required.');
    authorize(rawActor, input.projectId);
    requireOperator(rawActor);
    const proposal = await load(rawActor, input.projectId, input.proposalId);
    if (proposal.status === 'cancelled') throw new StoryboardProposalError('PROPOSAL_STATE', 'This proposal was cancelled. Ask the planner for a new one.', 409, proposal.revision);
    if (proposal.status === 'draft') throw new StoryboardProposalError('PROPOSAL_STATE', 'This proposal has not been accepted yet.', 409, proposal.revision);
    if (proposal.status === 'applied') return structuredClone(proposal);
    if (!proposal.items.every(item => item.commandId)) throw new StoryboardProposalError('PROPOSAL_INTEGRITY', 'A stored proposal is missing its command identifiers. Reload after investigation.', 500);
    // Receipts are keyed by (actor_id, command_id): only the accepting actor can safely replay them.
    if (proposal.provenance.acceptedBy !== rawActor.id || proposal.provenance.acceptedByKind !== rawActor.kind) {
      throw new StoryboardProposalError('PROPOSAL_ACTOR_MISMATCH', 'This proposal was accepted by a different actor. Only that operator can resume its frozen commands.', 409, proposal.revision);
    }

    const held = await acquire(input.projectId, input.proposalId);
    try {
      const current = await store.load(input.projectId, input.proposalId);
      if (!current) throw new StoryboardProposalError('PROPOSAL_NOT_FOUND', 'This storyboard proposal does not exist in this project.', 404);
      if (current.status === 'cancelled') throw new StoryboardProposalError('PROPOSAL_STATE', 'This proposal was cancelled. Ask the planner for a new one.', 409, current.revision);
      if (current.status === 'applied') return current;
      return await runApplication({
        projectId: input.projectId, proposalId: input.proposalId, actor: rawActor,
        retryFailed: input.retryFailed === true, held,
      });
    } finally {
      await leasePort.release(held);
    }
  }

  /** Stop creating shots. A draft is cancelled outright; an in-flight application stops before its
   * next cut (checked against durable state) and reports the cuts that already exist. */
  async function cancel(rawActor: StoryboardActor, rawInput: unknown): Promise<StoryboardProposal> {
    const input = parseOrReject(AddressSchema, rawInput, 'INVALID_REQUEST', 'A proposal address is required.');
    authorize(rawActor, input.projectId);
    requireOperator(rawActor);
    const proposal = await load(rawActor, input.projectId, input.proposalId);
    if (proposal.status === 'applied') throw new StoryboardProposalError('PROPOSAL_STATE', 'Every shot in this proposal already exists.', 409, proposal.revision);
    const cancelled = await store.requestCancel(input.projectId, input.proposalId);
    if (!cancelled) {
      const latest = await store.load(input.projectId, input.proposalId);
      if (!latest) throw new StoryboardProposalError('PROPOSAL_NOT_FOUND', 'This storyboard proposal does not exist in this project.', 404);
      throw new StoryboardProposalError('PROPOSAL_STATE', 'Every shot in this proposal already exists.', 409, latest.revision);
    }
    return cancelled;
  }

  return { propose, read, list, revise, accept, resume, cancel };
}

/**
 * Adapter to the existing storyboard cut engine: the accepted shots in review order, ready to be
 * submitted as ONE revision-checked `plan.apply`. It writes nothing; the coordinator owns the
 * plan command, its expectedRevision and its pin checks.
 */
export function toPlanCuts(proposal: StoryboardProposal): { shotId: string; durationMs: number }[] {
  return proposal.items
    .filter(item => item.state === 'created' && typeof item.shotId === 'string')
    .map(item => ({ shotId: item.shotId as string, durationMs: item.durationSeconds * 1_000 }));
}
