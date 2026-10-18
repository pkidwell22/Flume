import type { Db } from 'pg-boss';

export type Phase = 'submit' | 'poll' | 'retrieve' | 'import' | 'hold' | 'done';
export type AttemptStatus = 'queued' | 'running' | 'retrieving' | 'ready' | 'blocked' | 'failed' | 'acceptance_unknown';
/** Server-private: exact serialized reviewed bytes; scope binds account, route and adapter version. No secrets. */
export interface FrozenRequest {
  provider: string; modelId: string; scope: string; body: string; bodySha256: string;
}
export interface DispatchIntent { key: string; request: FrozenRequest }
export interface ProviderReceipt { provider: string; scope: string; modelId: string; providerJobId: string }
export interface RemoteOutput { outputId: string; url: string; sha256?: string }
export interface OwnedMedia {
  assetId: string; storageKey: string; filename: string; kind: 'video' | 'image';
  sha256: string; byteLength: number; width: number; height: number; durationSeconds?: number;
  /** Verified publication metadata; samples remain samples across worker publication. */
  origin?: 'generated' | 'sample'; mimeType?: string; provenance?: Record<string, unknown>;
}
export interface PublishedTake { takeId: string; assetId: string }
export interface Issue { code: string; message: string }
export interface AttemptState {
  id: string; projectId: string; shotId: string; shotRevision: number;
  request: FrozenRequest; version: number; owner: string | null; epoch: number;
  phase: Phase; status: AttemptStatus; recoverPhase: Exclude<Phase, 'hold' | 'done'> | null;
  dispatch: DispatchIntent | null; receipt: ProviderReceipt | null;
  remoteState: 'not_dispatched' | 'unknown' | 'running' | 'succeeded' | 'failed';
  outputs: RemoteOutput[]; imports: Record<string, PublishedTake>;
  polls: number; issue: Issue | null;
}
export interface Activation { jobId: string; retryCount: number; attemptId: string }
export interface Lease { activation: Activation; owner: string; epoch: number }
export type Authorization = { allowed: true } | { allowed: false; issue: Issue };

/** All methods use the SAME checked-out transaction as executeSql. Never open nested pools. */
export interface WorkerTransaction extends Db {
  /** SELECT FOR UPDATE. Queue activation must be locked first. */
  loadAttempt(attemptId: string): Promise<AttemptState | null>;
  /** CAS version; atomically persists the complete checkpoint. Throw on conflict. */
  saveAttempt(state: AttemptState, expectedVersion: number): Promise<void>;
  /** Lock/recheck current approval, revocation, expiry and immutable reviewed authority. No network. */
  authorizeDispatch(state: AttemptState): Promise<Authorization>;
  receipts(attemptId: string): Promise<ProviderReceipt[]>;
  /** Unique (attempt, provider scope, job, output). Verify immutable provenance on replay.
   * Publish owned Asset + Take in this transaction. NEVER change shot selection/revision. */
  publishTake(state: AttemptState, output: RemoteOutput, owned: OwnedMedia): Promise<PublishedTake>;
}
export interface WorkerStore {
  /** BEGIN/COMMIT/ROLLBACK; await completion before releasing the client. */
  transaction<T>(action: (tx: WorkerTransaction) => Promise<T>): Promise<T>;
  /** Append-only acceptance evidence, even from stale owners. Validate against persisted dispatch.
   * Conflicting handles must remain visible to receipts(), not last-writer-wins. */
  observeReceipt(attemptId: string, intent: DispatchIntent, receipt: ProviderReceipt): Promise<void>;
}
export interface PhaseQueue {
  fetch(): Promise<Activation | null>;
  /** SELECT state,retry_count ... FOR UPDATE on exact queue/job. */
  lock(tx: Db, activation: Activation): Promise<boolean>;
  enqueue(tx: Db, attemptId: string, delaySeconds?: number): Promise<string>;
  complete(tx: Db, activation: Activation): Promise<void>;
}
export type SubmitResult =
  | { kind: 'accepted'; receipt: ProviderReceipt }
  | { kind: 'blocked' | 'rejected' | 'unknown'; issue: Issue };
export type StatusResult =
  | { kind: 'running'; receipt: ProviderReceipt }
  | { kind: 'succeeded'; receipt: ProviderReceipt }
  | { kind: 'blocked' | 'failed' | 'unavailable'; issue: Issue };
export type OutputsResult =
  | { kind: 'outputs'; receipt: ProviderReceipt; outputs: RemoteOutput[] }
  | { kind: 'blocked' | 'unavailable'; issue: Issue };
export interface ProviderPort {
  /** Exactly one bounded POST; no internal retry, fallback or privacy override. */
  submit(intent: DispatchIntent, signal: AbortSignal): Promise<SubmitResult>;
  status(receipt: ProviderReceipt, signal: AbortSignal): Promise<StatusResult>;
  outputs(receipt: ProviderReceipt, signal: AbortSignal): Promise<OutputsResult>;
  /** Optional READ-ONLY lookup of exact immutable scope/key, never request-creating replay. */
  lookup?(intent: DispatchIntent, signal: AbortSignal): Promise<ProviderReceipt | null>;
}
export interface MediaPort {
  /** Idempotently owns, bounds and verifies bytes; enforces SSRF/redirect/path policy.
   * No provider credentials, database publication or selection. Must honor abort. */
  ownOutput(input: { projectId: string; attemptId: string; receipt: ProviderReceipt;
    output: RemoteOutput; importKey: string }, signal: AbortSignal): Promise<OwnedMedia>;
}
export interface WorkerOptions {
  operationTimeoutMs?: number; pollDelaySeconds?: number; maxPolls?: number; maxOutputs?: number;
}
export interface WorkerDependencies { store: WorkerStore; queue: PhaseQueue; provider: ProviderPort; media: MediaPort }
export type DeliveryResult = 'idle' | 'stale' | AttemptStatus;
