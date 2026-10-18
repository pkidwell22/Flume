import type { FileHandle } from 'node:fs/promises';

export type AssetOrigin = 'imported' | 'generated' | 'sample';
export interface Frame { index: number; pts: string; duration: string | null; rgbSha256: string }
export interface Inspection {
  sourceSha256: string; size: number; kind: 'image' | 'video'; mimeType: string;
  width: number; height: number; codec: string; streamIndex: number; timeBase: string;
  originPts: string; frames: Frame[]; durationSeconds: number; audioStreams: number;
  eof: 'observed-clean-decode';
}
export interface Asset {
  id: string; projectId: string; filename: string; kind: 'image' | 'video'; origin: AssetOrigin;
  sha256: string; mediaUrl: string; width: number; height: number; durationSeconds?: number;
  mimeType: string; size: number; provenance?: Record<string, unknown>;
}
export interface AssetRef { projectId: string; assetId: string }
export interface FrameRequest extends AssetRef { sourceAssetId: string; frame: 'first' | 'last' }
export interface ImageProfile { kind: 'fit-png-v1'; width: number; height: number; fit: 'contain' | 'cover'; background: 'black' | 'white' }
export interface PrepareRequest extends AssetRef { sourceAssetId: string; role: 'first_frame' | 'last_frame'; profile: ImageProfile }
export interface ImportInfo {
  assetId: string; projectId: string; filename: string; origin: 'imported' | 'sample'; claimedMime?: string;
}
export interface RemoteIdentity { provider: string; jobId: string; outputId: string }
export interface GeneratedImport { projectId: string; filename: string; remoteIdentity: RemoteIdentity; claimedMime?: string }
export interface DownloadPolicy { allowedHosts: readonly string[]; maxRedirects?: number }
export interface LocalImport extends ImportInfo { filePath: string }
export interface Limits {
  maxBytes: number; maxPixels: number; maxFrames: number; maxDurationSeconds: number;
  processTimeoutMs: number; ingestTimeoutMs: number; maxProcessOutputBytes: number;
}
export interface StoreOptions {
  /** Dedicated service-owned directory; its parent must already exist. Never a disposable-test root. */
  root: string; importRoots?: readonly string[]; ffmpegPath: string; ffprobePath: string;
  limits?: Partial<Limits>; downloadPolicy?: DownloadPolicy;
}
export interface OpenedAsset { asset: Asset; file: FileHandle; size: number; mimeType: string }
export interface ExportSelection {
  exportId: string; assetId: string; projectId: string; shotId: string; takeId: string;
  sourceAssetId: string; sourceSha256: string; shotRevision: number; selectionRevision: number; profile: 'mp4-copy-v1';
}
export interface FrozenExport { version: 1; selection: ExportSelection; snapshotSha256: string }
export interface StoredRecord { asset: Asset; inspection: Inspection }
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxBytes: 512 * 1024 * 1024, maxPixels: 33_554_432, maxFrames: 72_000,
  maxDurationSeconds: 1200, processTimeoutMs: 120_000, ingestTimeoutMs: 120_000,
  maxProcessOutputBytes: 32 * 1024 * 1024,
});
export class MediaError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'MediaError'; this.code = code; }
}
export function check(ok: unknown, code: string): asserts ok { if (!ok) throw new MediaError(code); }
export function uuid(value: unknown): asserts value is string {
  check(typeof value === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(value), 'INVALID_ID');
}
export function hashId(value: unknown): asserts value is string { check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'INVALID_HASH'); }
