// Structural UI ports from BUILD-BRIEF. The production adapter is the only
// boundary that needs alignment with the canonical @flume/domain/client exports.
import type { AuthoringCapabilities } from './authoring-api.ts';
import type { ComposerProposal } from './storyboard-types.ts';
import type { ContinuationRecovery } from './continue-shot-types.ts';
import type { ReferenceReadState } from './reference-provenance.ts';
export interface Project { id: string; name: string; brief: string; revision: number }
export interface Controls { modelId: string; durationSeconds: number; resolution: string; aspectRatio: string; generateAudio: boolean; seed?: number }
export interface Bindings { firstFrameAssetId: string | null; lastFrameAssetId: string | null }
export interface Shot { id: string; projectId: string; title: string; prompt: string; revision: number; controls: Controls; bindings: Bindings; selectedTakeId: string | null; selectionRevision: number }
export type ShotPatch = Partial<Pick<Shot, 'title' | 'prompt'>> & { controls?: Partial<Omit<Controls, 'seed'>> & {seed?:number|null}; bindings?: Partial<Bindings> };
export interface Asset { id: string; projectId: string; filename: string; kind: 'image' | 'video'; origin: 'imported' | 'generated' | 'sample'; sha256: string; mediaUrl: string; width: number; height: number; durationSeconds?: number; provenance?: unknown }
export interface Take { id: string; projectId: string; shotId: string; attemptId: string; assetId: string; createdAt: string }
export interface Attempt { id: string; projectId: string; shotId: string; shotRevision: number; status: 'queued' | 'running' | 'retrieving' | 'ready' | 'blocked' | 'failed' | 'acceptance_unknown'; providerJobId: string | null; errorCode: string | null; message: string | null }
export interface Review { id: string; projectId: string; shotId: string; shotRevision: number; requestHash: string; prompt: string; controls: Controls; bindings: Bindings; estimatedCostUsd: string | null; blockers: Array<string | { code: string; message: string }>; approved: boolean }
export interface Export { id: string; projectId: string; shotId: string; takeId: string; shotRevision: number; selectionRevision: number; status: 'queued' | 'running' | 'ready' | 'failed'; assetId: string | null; stale: boolean }
export interface Capability { modelId: string; name: string; durations: number[]; resolutions: string[]; aspectRatios?: string[]; frameRoles: string[]; seedSupported: boolean; generateAudioSupported?: boolean; availability: 'available' | 'blocked' | 'unknown'; blocker: string | null }
export interface Workspace { project: Project | null; shots: Shot[]; assets: Asset[]; takes: Take[]; attempts: Attempt[]; reviews: Review[]; exports: Export[]; capabilities: Capability[] }
export type CommandIntent =
  | { type: 'project.create'; name: string; brief: string }
  | { type: 'shot.create'; projectId: string; title: string; prompt: string }
  | { type: 'shot.update'; projectId: string; shotId: string; expectedRevision: number; patch: ShotPatch }
  | { type: 'generation.prepare'; projectId: string; shotId: string; expectedRevision: number }
  | { type: 'generation.approve'; projectId: string; reviewId: string; maxAttempts: number; maxCostUsd: string }
  | { type: 'generation.submit'; projectId: string; reviewId: string }
  | { type: 'attempt.resume'; projectId: string; attemptId: string }
  | { type: 'take.inspect'; projectId: string; takeId: string }
  | { type: 'take.select'; projectId: string; shotId: string; expectedRevision: number; expectedSelectionRevision: number; takeId: string; inspectionId: string }
  | { type: 'export.create'; projectId: string; shotId: string; expectedRevision: number; expectedSelectionRevision: number };
export type Command = CommandIntent & { commandId: string };
export interface Receipt { commandId: string; projectId: string; resourceId?: string; revision?: number; attemptId?: string; reviewId?: string; exportId?: string; inspectionId?: string }
export interface FlumePort {
  listProjects(): Promise<Project[]>;
  getWorkspace(projectId?: string): Promise<Workspace>;
  command(command: Command): Promise<Receipt>;
  uploadAsset(file: File, projectId: string): Promise<Asset>;
}
export interface WorkspaceError { code: string; message: string; currentRevision?: number }
export interface WorkspaceState {
  phase: 'idle' | 'loading' | 'ready' | 'error'; projects: Project[]; workspace: Workspace | null;
  activeShotId: string | null; busy: string | null; error: WorkspaceError | null;
  notice: string | null; reviewId: string | null; uncertainCommand: Command | null;
  dirtyShotIds: ReadonlySet<string>;
  authoring: AuthoringState;
  /** Recorded-input reads keyed by project + attempt. Absence means "never asked". */
  references?: Readonly<Record<string, ReferenceReadState>>;
}
/** Server-reported authoring capabilities. Absence is unknown, never "available". */
export interface AuthoringState {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  capabilities: AuthoringCapabilities | null;
  error: WorkspaceError | null;
  proposal: ComposerProposal | null;
  recovery?: { phase: 'loading' | 'restored' | 'error'; proposalId: string; message: string } | null;
  /** Saved continue-shot identity plus the authoritative server view restored for this project. */
  continuation?: ContinuationRecovery | null;
}
