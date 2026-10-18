import { dirname } from 'node:path';
import { check } from './types.ts';
import type { Inspection, PrepareRequest } from './types.ts';
import type { Storage } from './storage.ts';
import { run, ffBase } from './process.ts';
import { formatOf, inputArgs, inspectFile, parseHashes } from './inspect.ts';

export function validatePreparation(request: PrepareRequest, s: Storage) {
  const p = request.profile;
  check(['first_frame','last_frame'].includes(request.role) && p?.kind === 'fit-png-v1'
    && Number.isSafeInteger(p.width) && Number.isSafeInteger(p.height) && p.width > 0 && p.height > 0
    && p.width * p.height <= s.limits.maxPixels && ['contain','cover'].includes(p.fit)
    && ['black','white'].includes(p.background), 'INVALID_IMAGE_PROFILE');
}
export async function prepare(s: Storage, source: Inspection, path: string, output: string, request: PrepareRequest) {
  validatePreparation(request, s); check(source.kind === 'image', 'IMAGE_REQUIRED');
  const p = request.profile; const jpeg = source.mimeType === 'image/jpeg';
  const scale = `scale=${p.width}:${p.height}:force_original_aspect_ratio=${p.fit === 'contain' ? 'decrease' : 'increase'}:flags=lanczos${jpeg ? ':in_range=full:out_range=full' : ''}`;
  const fit = p.fit === 'contain' ? `pad=${p.width}:${p.height}:(ow-iw)/2:(oh-ih)/2:color=${p.background}` : `crop=${p.width}:${p.height}`;
  await run(s.ffmpeg, [...ffBase, '-n', ...inputArgs(path, formatOf(source), s, true), '-map', `0:${source.streamIndex}`, '-an',
    '-vf', `${scale},${fit},setsar=1,format=rgb24`, '-frames:v', '1', '-c:v', 'png', '-threads', '1', '-map_metadata', '-1', '-update', '1', '-fs', String(s.limits.maxBytes), output], s.limits, dirname(path), jpeg ? 'full-range-jpeg-conversion' : 'strict');
  const inspection = await inspectFile(s, output);
  check(inspection.width === p.width && inspection.height === p.height, 'PREPARATION_MISMATCH');
  return { inspection, provenance: { kind: 'prepared-image', sourceSha256: source.sourceSha256,
    preparedSha256: inspection.sourceSha256, role: request.role, profile: p, pixelPolicy: 'encoded-raster-rgb24-noautorotate' } };
}

export async function extract(s: Storage, source: Inspection, path: string, output: string, mode: 'first' | 'last') {
  check(source.kind === 'video', 'VIDEO_REQUIRED');
  check(mode === 'first' || mode === 'last', 'INVALID_FRAME_MODE');
  const chosen = mode === 'last' ? source.frames.at(-1)! : source.frames[0];
  const text = (await run(s.ffmpeg, [...ffBase, '-n', '-copyts', ...inputArgs(path, formatOf(source), s, true),
    '-filter_complex', `[0:${source.streamIndex}]format=rgb24,select=eq(n\\,${chosen.index}),split=2[image][hash]`,
    '-map', '[image]', '-frames:v', '1', '-fps_mode', 'passthrough', '-c:v', 'png', '-threads', '1', '-update', '1', '-fs', String(s.limits.maxBytes), output,
    '-map', '[hash]', '-frames:v', '1', '-fps_mode', 'passthrough', '-enc_time_base', source.timeBase,
    '-c:v', 'rawvideo', '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'framehash', '-hash', 'sha256', '-'], s.limits, dirname(path))).toString();
  const hash = parseHashes(text);
  check(hash.timeBase === source.timeBase && hash.rows.length === 1 && hash.rows[0][2] === chosen.pts && hash.rows[0][5] === chosen.rgbSha256, 'EXTRACTION_MISMATCH');
  // Decode the PNG independently. File hash and decoded pixels are different identities.
  const inspection = await inspectFile(s, output);
  check(inspection.frames.length === 1 && inspection.frames[0].rgbSha256 === chosen.rgbSha256, 'PNG_PIXEL_MISMATCH');
  return { inspection, provenance: { kind: 'extracted-frame', frame: mode, sourceSha256: source.sourceSha256,
    sourceFrameCount: source.frames.length, frameIndex: chosen.index, pts: chosen.pts, timeBase: source.timeBase,
    rgbSha256: chosen.rgbSha256, imageSha256: inspection.sourceSha256, pixelPolicy: 'encoded-raster-rgb24-noautorotate' } };
}
