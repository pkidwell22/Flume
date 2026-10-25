import type { ComponentType } from 'react';
import type { Asset, Attempt, Capability, Export, Review, Shot, ShotPatch, Take, WorkspaceError } from './types.ts';

export interface ShotEditorProps {
  shot: Shot; assets: Asset[]; capabilities: Capability[]; busy: boolean; error?: WorkspaceError | null;
  onSave(patch: ShotPatch, expectedRevision: number): Promise<Shot>;
  onUpload(file: File): Promise<Asset>;
  onPrepare(expectedRevision: number): Promise<void>;
  /** Signal every draft edit, including button-driven reference changes.
   * Native input capture in the shell is only a fallback, not full coverage. */
  onDirtyChange(dirty: boolean): void;
  /** Report the editor's draft frame references so the preview can label them
   * unsaved. Presentation only: it never saves, reviews or submits. */
  onDraftChange?(report: DraftFrameReport): void;
  /** Register the editor's own guarded save so the preview offers that exact
   * action rather than a second write path. */
  registerSaveAction?(save: (() => void) | null): void;
}
/** Mirrors the shot editor's draft frame report without importing its types. */
export interface DraftFrameRef { assetId: string; filename: string; mediaUrl: string }
export interface DraftFrameReport { shotId: string; first: DraftFrameRef | null; last: DraftFrameRef | null }
export interface TakeReviewProps {
  shot: Shot; takes: Take[]; assets: Asset[]; exports: Export[]; busy: boolean;
  onInspect(takeId: string): Promise<{ inspectionId: string }>;
  onSelect(takeId: string, inspectionId?: string): Promise<void>;
  onExport(): Promise<void>;
}
export interface ActivityPanelProps { attempts: Attempt[]; busy: boolean; onResume(attemptId: string): Promise<void> }
export interface GenerationReviewProps {
  review: Review; assets: Asset[]; busy: boolean;
  onApprove(limits: { maxAttempts: number; maxCostUsd: string }): Promise<void>;
  onSubmit(): Promise<void>;
  onDismiss(): void;
}
export interface WorkspaceComponents {
  Brand: ComponentType;
  ShotEditor: ComponentType<ShotEditorProps>;
  TakeReview: ComponentType<TakeReviewProps>;
  ActivityPanel: ComponentType<ActivityPanelProps>;
  GenerationReview: ComponentType<GenerationReviewProps>;
}
