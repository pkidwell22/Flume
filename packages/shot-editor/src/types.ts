import type { ReactElement } from 'react';

/** Narrow structural DTOs; the canonical domain package remains the authority. */
export type FrameRole = 'first_frame' | 'last_frame';
export interface ShotControls {
  modelId: string;
  durationSeconds: number;
  resolution: string;
  aspectRatio: string;
  generateAudio: boolean;
  seed?: number;
}
export interface FrameBindings {
  firstFrameAssetId: string | null;
  lastFrameAssetId: string | null;
}
export interface ShotView {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  revision: number;
  controls: ShotControls;
  bindings: FrameBindings;
  selectedTakeId?: string | null;
  selectionRevision?: number;
}
export interface AssetView {
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
export interface CapabilityView {
  modelId: string;
  name: string;
  durations: readonly number[];
  resolutions: readonly string[];
  /** Omitted metadata is unknown; do not substitute universal ratios. */
  aspectRatios?: readonly string[];
  frameRoles: readonly string[];
  seedSupported: boolean;
  /** Omitted is unknown, distinct from explicit false; neither grants availability. */
  generateAudioSupported?: boolean;
  availability: 'available' | 'blocked' | 'unknown';
  blocker: string | null;
}
export interface SaveShotInput {
  projectId: string;
  shotId: string;
  expectedRevision: number;
  patch: { title: string; prompt: string; controls: ShotControls; bindings: FrameBindings };
}
/** Resolve only after an accepted shot.update receipt; never guess the revision. */
export interface SaveShotResult {
  revision: number;
}
export interface UploadReferenceInput {
  projectId: string;
  shotId: string;
  expectedRevision: number;
  role: FrameRole;
  file: File;
}
export interface PrepareShotInput {
  projectId: string;
  shotId: string;
  expectedRevision: number;
}
export interface ShotEditorProps {
  shot: ShotView | null;
  assets: readonly AssetView[];
  capabilities: readonly CapabilityView[];
  busy?: boolean;
  onSave: (input: SaveShotInput) => Promise<SaveShotResult>;
  /** Import locally and return an owned Asset. Do not save a binding here. */
  onUpload: (input: UploadReferenceInput) => Promise<AssetView>;
  /** Prepare a review only; never approve or submit paid work. */
  onPrepare: (input: PrepareShotInput) => Promise<unknown>;
  /** Wire to review controls so unsaved input cannot approve a different snapshot. */
  onDirtyChange?: (dirty: boolean, shotId: string) => void;
}
export type ShotEditorComponent = (props: ShotEditorProps) => ReactElement;
