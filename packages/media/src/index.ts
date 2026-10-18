import { join } from 'node:path';
import { check, uuid } from './types.ts';
import type { StoreOptions, LocalImport, AssetRef, OpenedAsset, StoredRecord, Asset, ImportInfo, FrameRequest, PrepareRequest, FrozenExport, GeneratedImport } from './types.ts';
import { generatedAssetId, remoteIdentityHash } from './generated.ts';
import { downloadToFile } from './download.ts';
export { generatedAssetId } from './generated.ts';
import { renderExport, verifyFrozen } from './export.ts';
export { freezeExportSelection, isExportStale } from './export.ts';
import { extract, prepare, validatePreparation } from './derive.ts';
import { storage, copyLocal, copyHandle, regular, hashFile, writeStream } from './storage.ts';
import type { Storage } from './storage.ts';
import { inspectFile } from './inspect.ts';
export { MediaError, DEFAULT_LIMITS } from './types.ts';
export type * from './types.ts';

function validateImport(input: ImportInfo) {
  uuid(input.projectId); uuid(input.assetId);
  check(typeof input.filename === 'string' && input.filename.length > 0 && input.filename.length <= 255 && !/[\\/\x00-\x1f\x7f]/.test(input.filename), 'INVALID_FILENAME');
  check(['imported', 'sample'].includes(input.origin), 'INVALID_ORIGIN');
}
function toAsset(input: ImportInfo, i: StoredRecord['inspection']): Asset {
  return { id: input.assetId, projectId: input.projectId, filename: input.filename, origin: input.origin,
    kind: i.kind, sha256: i.sourceSha256, mediaUrl: `/api/media/${input.assetId}`, width: i.width, height: i.height,
    ...(i.kind === 'video' ? { durationSeconds: i.durationSeconds } : {}), size: i.size, mimeType: i.mimeType };
}
async function openOwned(s: Storage, ref: AssetRef): Promise<OpenedAsset> {
  uuid(ref.projectId); uuid(ref.assetId);
  const record = await s.record(ref.assetId);
  check(record.asset.projectId.toLowerCase() === ref.projectId.toLowerCase(), 'ASSET_NOT_IN_PROJECT');
  const file = await regular(s.object(record.asset.sha256), s.limits.maxBytes);
  try {
    const actual = await hashFile(file, s.limits.maxBytes);
    check(actual.sha256 === record.asset.sha256 && actual.size === record.asset.size, 'STORAGE_CORRUPT');
    return { asset: record.asset, file, size: actual.size, mimeType: record.asset.mimeType };
  } catch (e) { await file.close(); throw e; }
}
async function snapshotOwned(s: Storage, ref: AssetRef, path: string) {
  const owned = await openOwned(s, ref);
  try { await copyHandle(owned.file, path, s.limits); } finally { await owned.file.close(); }
  const inspection = await inspectFile(s, path);
  check(inspection.sourceSha256 === owned.asset.sha256, 'STORAGE_CORRUPT');
  return { asset: owned.asset, inspection };
}
function derivedAsset(source: Asset, assetId: string, filename: string, inspection: StoredRecord['inspection'], provenance: Record<string, unknown>): Asset {
  return { id: assetId, projectId: source.projectId, origin: source.origin, filename, kind: inspection.kind,
    width: inspection.width, height: inspection.height, mimeType: inspection.mimeType, size: inspection.size,
    sha256: inspection.sourceSha256, mediaUrl: `/api/media/${assetId}`,
    ...(inspection.kind === 'video' ? { durationSeconds: inspection.durationSeconds } : {}),
    provenance: { ...provenance, sourceAssetId: source.id } };
}
export async function createMediaStore(options: StoreOptions) {
  options = structuredClone(options);
  const s = await storage(options);
  const generatedInput = (captured: GeneratedImport) => {
    const input = { ...captured, assetId: generatedAssetId(captured.projectId, captured.remoteIdentity), origin: 'imported' as const };
    validateImport(input); return input;
  };
  const publishGenerated = async (captured: GeneratedImport, path: string, claimedMime?: string): Promise<Asset> => {
    const inspection = await inspectFile(s, path, claimedMime ?? captured.claimedMime); check(inspection.kind === 'video', 'VIDEO_REQUIRED');
    const asset: Asset = { ...toAsset(generatedInput(captured), inspection), origin: 'generated',
      provenance: { kind: 'provider-output', provider: captured.remoteIdentity.provider, remoteIdentitySha256: remoteIdentityHash(captured.projectId, captured.remoteIdentity) } };
    return (await s.publish(path, { asset, inspection })).asset;
  };
  return {
    /** Local paths are accepted only beneath configured importRoots. HTTP uploads should use importStream. */
    async importLocal(request: LocalImport): Promise<Asset> {
      const input = structuredClone(request); validateImport(input);
      return s.stage(async dir => {
        const path = join(dir, 'input'); await copyLocal(s, input.filePath, path);
        const inspection = await inspectFile(s, path, input.claimedMime);
        const asset = toAsset(input, inspection); return (await s.publish(path, { asset, inspection })).asset;
      });
    },
    async importStream(request: ImportInfo, stream: AsyncIterable<Uint8Array>): Promise<Asset> {
      const input = structuredClone(request); validateImport(input);
      return s.stage(async dir => {
        const path = join(dir, 'input'); await writeStream(stream, path, s.limits);
        const inspection = await inspectFile(s, path, input.claimedMime);
        const asset = toAsset(input, inspection); return (await s.publish(path, { asset, inspection })).asset;
      });
    },
    async importGeneratedOutput(request: GeneratedImport, stream: AsyncIterable<Uint8Array>): Promise<Asset> {
      const captured = structuredClone(request); generatedInput(captured);
      return s.stage(async dir => {
        const path = join(dir, 'input'); await writeStream(stream, path, s.limits);
        return publishGenerated(captured, path);
      });
    },
    async retrieveGeneratedOutput(request: GeneratedImport & { url: string }): Promise<Asset> {
      const captured = structuredClone(request); const input = generatedInput(captured);
      return s.stage(async dir => {
        // Remote identity replay must not depend on a still-live signed URL.
        let record: StoredRecord | undefined;
        try { record = await s.record(input.assetId); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
        if (record) {
          check(record.asset.origin === 'generated' && record.asset.filename === input.filename
            && record.asset.provenance?.remoteIdentitySha256 === remoteIdentityHash(input.projectId, input.remoteIdentity), 'ASSET_ID_CONFLICT');
          const owned = await openOwned(s, { projectId: input.projectId, assetId: input.assetId });
          await owned.file.close(); return owned.asset;
        }
        const path = join(dir, 'input');
        const { claimedMime } = await downloadToFile(captured.url, options.downloadPolicy ?? { allowedHosts: [] }, path, s.limits);
        return publishGenerated(captured, path, claimedMime);
      });
    },
    async exportSelected(request: FrozenExport): Promise<Asset> {
      const frozen = verifyFrozen(structuredClone(request)); const input = frozen.selection;
      return s.stage(async dir => {
        const path = join(dir, 'input'), output = join(dir, 'export.mp4');
        const source = await snapshotOwned(s, { projectId: input.projectId, assetId: input.sourceAssetId }, path);
        check(source.asset.sha256 === input.sourceSha256, 'EXPORT_SOURCE_MISMATCH');
        const inspection = await renderExport(s, source.inspection, path, output);
        const asset = derivedAsset(source.asset, input.assetId, 'selected-take.mp4', inspection,
          { kind: 'frozen-export', snapshotSha256: frozen.snapshotSha256, selection: input, sourceSha256: source.asset.sha256 });
        return (await s.publish(output, { asset, inspection })).asset;
      });
    },
    async prepareImage(request: PrepareRequest): Promise<Asset> {
      const input = structuredClone(request); uuid(input.assetId); uuid(input.sourceAssetId); validatePreparation(input, s);
      return s.stage(async dir => {
        const path = join(dir, 'input'), output = join(dir, 'prepared.png');
        const source = await snapshotOwned(s, { projectId: input.projectId, assetId: input.sourceAssetId }, path);
        const { inspection, provenance } = await prepare(s, source.inspection, path, output, input);
        const asset = derivedAsset(source.asset, input.assetId, `${input.role}-prepared.png`, inspection, provenance);
        return (await s.publish(output, { asset, inspection })).asset;
      });
    },
    async extractFrame(request: FrameRequest): Promise<Asset> {
      const input = structuredClone(request); uuid(input.assetId); uuid(input.sourceAssetId);
      check(['first','last'].includes(input.frame), 'INVALID_FRAME_MODE');
      return s.stage(async dir => {
        const path = join(dir, 'input'), output = join(dir, 'frame.png');
        const source = await snapshotOwned(s, { projectId: input.projectId, assetId: input.sourceAssetId }, path);
        const { inspection, provenance } = await extract(s, source.inspection, path, output, input.frame);
        const asset = derivedAsset(source.asset, input.assetId, `${input.frame}-frame.png`, inspection, provenance);
        return (await s.publish(output, { asset, inspection })).asset;
      });
    },
    async inspect(ref: AssetRef) {
      ref = structuredClone(ref);
      return s.stage(async dir => (await snapshotOwned(s, ref, join(dir, 'input'))).inspection);
    },
    openAsset(ref: AssetRef): Promise<OpenedAsset> { return openOwned(s, structuredClone(ref)); },
  };
}
export type MediaStore = Awaited<ReturnType<typeof createMediaStore>>;
