/** Structural public DTO views; no server, database, or provider dependency. */
export interface ReviewShot {
  id: string; projectId: string; title: string; revision: number;
  selectedTakeId: string | null; selectionRevision: number;
}
export interface ReviewTake {
  id: string; projectId: string; shotId: string; attemptId: string;
  assetId: string; createdAt: string;
}
export interface ReviewAsset {
  id: string; projectId: string; filename: string;
  kind: 'image' | 'video'; origin: 'imported' | 'generated' | 'sample';
  sha256: string; mediaUrl: string; width: number; height: number;
  durationSeconds?: number; provenance?: unknown;
}
export interface ReviewExport {
  id: string; projectId: string; shotId: string; takeId: string;
  shotRevision: number; selectionRevision: number;
  status: 'queued' | 'running' | 'ready' | 'failed';
  assetId: string | null; stale: boolean;
}
export interface InspectTakeRequest { projectId: string; takeId: string }
export interface TakeInspection { inspectionId: string }
/** One recorded reference, exactly as the frozen review recorded it. Null means unknown. */
export interface RecordedInputReference {
  role: 'first_frame' | 'last_frame';
  assetId: string | null;
  sha256: string | null;
}
/**
 * Read-only recorded reference history for one take. `unknown` is not "no references", and a
 * null digest is never a verification of the current media. The package never fetches this.
 */
export type RecordedInputsState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; status: 'recorded' | 'partial' | 'unknown'; references: readonly RecordedInputReference[] }
  | { phase: 'error'; message: string };
export interface SelectTakeRequest {
  projectId: string; shotId: string; takeId: string; inspectionId: string;
  expectedRevision: number; expectedSelectionRevision: number;
}
export interface ExportTakeRequest {
  projectId: string; shotId: string;
  expectedRevision: number; expectedSelectionRevision: number;
}
export interface TakeReviewProps {
  shot: ReviewShot | null;
  takes: readonly ReviewTake[];
  assets: readonly ReviewAsset[];
  exports: readonly ReviewExport[];
  busy?: boolean;
  onInspect: (request: InspectTakeRequest) => Promise<TakeInspection>;
  onSelect: (request: SelectTakeRequest) => Promise<void>;
  onExport: (request: ExportTakeRequest) => Promise<void>;
  /** Recorded review-time inputs for a take, or null when this consumer has no receipt source. */
  recordedInputs?: (take: ReviewTake) => RecordedInputsState | null | undefined;
  /** Ask the consumer to read that receipt. Presentation intent only: it is never a command. */
  onReadRecordedInputs?: (take: ReviewTake) => void;
}
