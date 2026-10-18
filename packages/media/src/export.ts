// Selection/revision authorization belongs to the command transaction. This module never reads
// mutable editorial state or selects a take. Persist this frozen value in the durable export job.
import { dirname } from 'node:path';
import { check, uuid, hashId } from './types.ts';
import { uuidKey } from './identity.ts';
import type { ExportSelection, FrozenExport, Inspection } from './types.ts';
import { digest } from './storage.ts';
import type { Storage } from './storage.ts';
import { run, ffBase } from './process.ts';
import { inspectFile, inputArgs, formatOf } from './inspect.ts';

export function freezeExportSelection(input: ExportSelection): FrozenExport {
  const v = structuredClone(input);
  check(Object.keys(v).sort().join(',') === 'assetId,exportId,profile,projectId,selectionRevision,shotId,shotRevision,sourceAssetId,sourceSha256,takeId', 'INVALID_EXPORT_SELECTION');
  for (const key of ['exportId','assetId','projectId','shotId','takeId','sourceAssetId'] as const) uuid(v[key]);
  hashId(v.sourceSha256);
  check(v.profile === 'mp4-copy-v1' && Number.isSafeInteger(v.shotRevision) && v.shotRevision >= 0 && Number.isSafeInteger(v.selectionRevision) && v.selectionRevision >= 0, 'INVALID_EXPORT_PROFILE');
  const selection = Object.freeze({ exportId: v.exportId, assetId: v.assetId, projectId: v.projectId, shotId: v.shotId,
    takeId: v.takeId, sourceAssetId: v.sourceAssetId, sourceSha256: v.sourceSha256,
    shotRevision: v.shotRevision, selectionRevision: v.selectionRevision, profile: v.profile });
  return Object.freeze({ version: 1 as const, selection, snapshotSha256: digest(JSON.stringify({ version: 1, selection })) });
}
export function verifyFrozen(input: FrozenExport): FrozenExport {
  check(input?.version === 1, 'INVALID_EXPORT_VERSION');
  const frozen = freezeExportSelection(input.selection);
  check(frozen.snapshotSha256 === input.snapshotSha256, 'SNAPSHOT_HASH_MISMATCH'); return frozen;
}
export function isExportStale(frozen: FrozenExport, current: { shotRevision: number; selectionRevision: number; selectedTakeId: string | null }) {
  const { selection } = verifyFrozen(frozen);
  const selectedTakeId = current.selectedTakeId === null ? null : uuidKey(current.selectedTakeId);
  return selection.shotRevision !== current.shotRevision || selection.selectionRevision !== current.selectionRevision || uuidKey(selection.takeId) !== selectedTakeId;
}
export async function renderExport(s: Storage, source: Inspection, path: string, output: string) {
  check(source.kind === 'video' && ['h264','hevc','av1'].includes(source.codec), 'EXPORT_CODEC_UNSUPPORTED');
  await run(s.ffmpeg, [...ffBase, '-n', '-copyts', ...inputArgs(path, formatOf(source), s, true),
    '-map', `0:${source.streamIndex}`, '-map', '0:a?', '-c', 'copy', '-map_metadata', '-1', '-map_chapters', '-1',
    '-movflags', '+faststart', '-fs', String(s.limits.maxBytes), output], s.limits, dirname(path));
  const inspection = await inspectFile(s, output);
  check(inspection.width === source.width && inspection.height === source.height && inspection.audioStreams === source.audioStreams
    && inspection.frames.length === source.frames.length && inspection.frames.every((f, i) => f.rgbSha256 === source.frames[i].rgbSha256), 'EXPORT_PIXEL_MISMATCH');
  // Rational clock comparison avoids floating-point guesses if the muxer changes timebase.
  const [sn, sd] = source.timeBase.split('/').map(BigInt), [on, od] = inspection.timeBase.split('/').map(BigInt);
  check(inspection.frames.every((f, i) => BigInt(f.pts) * on * sd === BigInt(source.frames[i].pts) * sn * od), 'EXPORT_TIMESTAMP_MISMATCH');
  return inspection;
}
