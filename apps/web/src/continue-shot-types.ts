/**
 * Continue-shot contracts — the type-only half of `ContinueShot.tsx`.
 *
 * These shapes cross the web surface boundary: the workspace controller, the authoring
 * adapter and, in the server's cross-surface contract test, `apps/server` all read them.
 * They therefore live in a plain `.ts` module so a type-only import never drags a `.tsx`
 * component (and its JSX/React requirements) into a project that does not compile JSX.
 * The component re-exports them, so existing import sites are unchanged.
 *
 * The field names intentionally mirror the server's `ContinueShotOutcome`
 * (apps/server/src/continue-shot.ts) one-for-one, so the coordinator adapter is the
 * identity function: `continueShot: service.continueShot`.
 */

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

/** Minimal, server-authoritative continuation snapshot. No prompt, title, payload or lease material. */
export type ContinueShotPublicView = {
  operationId: string;
  projectId: string;
  status: 'completed' | 'partial' | 'blocked' | 'in_progress' | 'unknown';
  resumable: boolean;
  active: boolean;
  sourceTakeId: string;
  sourceShotId: string;
  sourceAssetId: string;
  extractedAssetId: string | null;
  shotId: string | null;
  shotRevision: number | null;
  nextStep: 'extract' | 'create' | 'bind' | 'done' | 'reconcile';
  blockers: string[];
  message: string | null;
  updatedAt: string;
};

/** Recovery state owned by the workspace controller; never derived locally. */
export type ContinuationRecovery = {
  phase: 'loading' | 'restored' | 'error';
  operationId: string;
  view: ContinueShotPublicView | null;
  message: string | null;
};

export type ContinueShotRequest = {
  operationId: string;
  projectId: string;
  sourceTakeId: string;
  title: string;
  prompt: string;
};

export type ContinueShotPort = {
  /** One call per explicit trigger or retry. Reusing operationId resumes the durable server operation. */
  continueShot(input: ContinueShotRequest): Promise<ContinueShotOutcome>;
};

export type ContinueShotTake = { id: string; label: string; shotId: string };

export type ContinueShotProps = {
  port: ContinueShotPort;
  projectId: string;
  /** Only project-owned takes. An empty list means the control cannot continue anything. */
  takes: ContinueShotTake[];
  sourceShot?: { id: string; title: string; prompt?: string };
  disabled?: boolean;
  blockedReason?: string | null;
  onCompleted?: (outcome: ContinueShotOutcome) => void | Promise<void>;
  /** Saved continuation recovered from the server journal for this project. */
  recovery?: ContinuationRecovery | null;
  /** Read-only retry of a failed recovery read. Never a POST fallback. */
  onRetryRecovery?: () => void | Promise<void>;
  /** Explicit resume of the stored operation. The server replays its frozen intention. */
  onResumeOperation?: (operationId: string) => Promise<ContinueShotOutcome>;
  /** Injectable for deterministic tests; defaults to crypto.randomUUID(). */
  newOperationId?: () => string;
};
