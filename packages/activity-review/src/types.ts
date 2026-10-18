/** Structural browser DTOs matching BUILD-BRIEF; no server internals or authority. */
export interface Controls {
  modelId: string;
  durationSeconds: number;
  resolution: string;
  aspectRatio: string;
  generateAudio: boolean;
  seed?: number;
}
export interface Bindings { firstFrameAssetId: string | null; lastFrameAssetId: string | null }
export interface Asset {
  id: string;
  projectId: string;
  filename: string;
  kind: 'image' | 'video';
  origin: 'imported' | 'generated' | 'sample';
  sha256: string;
  mediaUrl: string;
  width: number;
  height: number;
  durationSeconds?: number;
  provenance?: unknown;
}
export type ReviewBlocker = string | { code: string; message: string };
export interface Review {
  id: string;
  projectId: string;
  shotId: string;
  shotRevision: number;
  requestHash: string;
  prompt: string;
  controls: Controls;
  bindings: Bindings;
  estimatedCostUsd: string | null;
  blockers: readonly ReviewBlocker[];
  approved: boolean;
}
export interface Attempt {
  id: string;
  projectId: string;
  shotId: string;
  shotRevision: number;
  status: 'queued' | 'running' | 'retrieving' | 'ready' | 'blocked' | 'failed' | 'acceptance_unknown';
  providerJobId: string | null;
  errorCode: string | null;
  message: string | null;
}
export type ActionResult = void | Promise<void>;
export interface ApprovalLimits { maxAttempts: 1; maxCostUsd: string }
export interface GenerationReviewProps {
  review: Review | null;
  assets: readonly Asset[];
  busy?: boolean;
  onApprove: (reviewId: string, limits: ApprovalLimits) => ActionResult;
  onSubmit: (reviewId: string) => ActionResult;
  onDismiss: () => void;
}
export interface ActivityPanelProps {
  attempts: readonly Attempt[];
  assets: readonly Asset[];
  busy?: boolean;
  onResume: (attemptId: string) => ActionResult;
}
