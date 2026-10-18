// Promoted from spikes/02-frame-provenance: full-source PTS + independent RGB decode,
// measured ordinal extraction and roundtrip verification. No fixture IDs/limits/dependencies.
import { dirname } from 'node:path';
import { check, MediaError } from './types.ts';
import type { FileHandle } from 'node:fs/promises';
import type { Inspection } from './types.ts';
import { regular, hashFile } from './storage.ts';
import type { Storage } from './storage.ts';
import { run, ffBase, probeBase } from './process.ts';

export interface Format { kind: 'image' | 'video'; mimeType: string; demuxer: string }
export function sniff(b: Buffer): Format {
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { kind: 'image', mimeType: 'image/png', demuxer: 'png_pipe' };
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return { kind: 'image', mimeType: 'image/jpeg', demuxer: 'jpeg_pipe' };
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { kind: 'image', mimeType: 'image/webp', demuxer: 'webp_pipe' };
  if (b.toString('ascii', 4, 8) === 'ftyp') return { kind: 'video', mimeType: b.toString('ascii', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4', demuxer: 'mov' };
  if (b.subarray(0, 4).equals(Buffer.from([26,69,223,163]))) return { kind: 'video', mimeType: b.subarray(0, 128).includes(Buffer.from('webm')) ? 'video/webm' : 'video/x-matroska', demuxer: 'matroska' };
  throw new MediaError('UNSUPPORTED_MEDIA_BYTES');
}
async function rejectAnimatedPng(file: FileHandle, size: number) {
  // png_pipe deliberately decodes only the default image of APNG: probe frame count alone is insufficient.
  let offset = 8, count = 0; const header = Buffer.alloc(8);
  while (offset < size) {
    check(++count <= 100_000 && offset + 12 <= size, 'INVALID_PNG');
    check((await file.read(header, 0, 8, offset)).bytesRead === 8, 'INVALID_PNG');
    const length = header.readUInt32BE(0), type = header.toString('ascii', 4, 8);
    check(type !== 'acTL' && type !== 'fcTL' && type !== 'fdAT', 'ANIMATED_IMAGE_UNSUPPORTED');
    check(offset + 12 + length <= size && (count !== 1 || type === 'IHDR'), 'INVALID_PNG');
    offset += 12 + length;
    if (type === 'IEND') { check(length === 0 && offset === size, 'INVALID_PNG'); return; }
  }
  throw new MediaError('INVALID_PNG');
}
export function inputArgs(path: string, format: Format, s: Storage, ffmpeg = false): string[] {
  return ['-protocol_whitelist', 'file,pipe', '-probesize', '5000000', '-analyzeduration', '10000000',
    '-max_pixels', String(s.limits.maxPixels), '-f', format.demuxer,
    ...(format.demuxer === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
    ...(ffmpeg ? ['-noautorotate', '-i'] : []), path];
}
export function parseHashes(text: string) {
  const timeBase = text.match(/#tb 0: (\S+)/)?.[1];
  const rows = text.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.split(',').map(x => x.trim()));
  check(timeBase && rows.every(r => r.length === 6 && /^-?\d+$/.test(r[2]) && /^[a-f0-9]{64}$/.test(r[5])), 'INVALID_FRAMEHASH');
  return { timeBase, rows };
}
type Rational = readonly [bigint, bigint];
function clock(value: unknown): Rational {
  check(typeof value === 'string' && /^[1-9]\d*\/[1-9]\d*$/.test(value), 'UNKNOWN_TIMESTAMP');
  const parts = value.split('/').map(Number);
  check(parts.every(Number.isSafeInteger), 'UNKNOWN_TIMESTAMP');
  return [BigInt(parts[0]), BigInt(parts[1])];
}
function playbackExtent() {
  let first: Rational | undefined, last: Rational | undefined;
  return {
    include(pts: number, duration: number, [num, den]: Rational) {
      check(Number.isSafeInteger(pts), 'UNKNOWN_TIMESTAMP');
      check(Number.isSafeInteger(duration) && duration >= 0, 'UNKNOWN_DURATION');
      const start: Rational = [BigInt(pts) * num, den];
      const end: Rational = [(BigInt(pts) + BigInt(duration)) * num, den];
      if (!first || start[0] * first[1] < first[0] * start[1]) first = start;
      if (!last || end[0] * last[1] > last[0] * end[1]) last = end;
    },
    seconds(limit: number) {
      check(first && last, 'UNKNOWN_DURATION');
      // Compare the union of all accepted playback intervals in exact rational
      // clocks. Large common PTS origins must not round an over-limit tail away.
      const num = last[0] * first[1] - first[0] * last[1], den = last[1] * first[1];
      check(num >= 0n && num <= BigInt(limit) * den, 'DURATION_LIMIT');
      return Number(num) / Number(den);
    },
  };
}
export async function inspectFile(s: Storage, path: string, claimedMime?: string): Promise<Inspection> {
  const file = await regular(path, s.limits.maxBytes);
  let format: Format, sha256: string, size: number;
  try {
    const b = Buffer.alloc(256); await file.read(b, 0, b.length, 0); format = sniff(b);
    ({ sha256, size } = await hashFile(file, s.limits.maxBytes));
    if (format.mimeType === 'image/png') await rejectAnimatedPng(file, size);
  } finally { await file.close(); }
  check(!claimedMime || claimedMime === 'application/octet-stream' || claimedMime === format.mimeType, 'MIME_MISMATCH');
  const cwd = dirname(path);
  const info = JSON.parse((await run(s.ffprobe, [...probeBase, '-show_streams', '-show_format', '-of', 'json', ...inputArgs(path, format, s)], s.limits, cwd)).toString());
  check(Array.isArray(info.streams), 'NO_STREAMS');
  const video = info.streams.filter((v: any) => v.codec_type === 'video');
  const audio = info.streams.filter((v: any) => v.codec_type === 'audio');
  check(video.length === 1 && audio.length <= 1 && info.streams.length === video.length + audio.length, 'UNSUPPORTED_STREAMS');
  const v = video[0];
  check(['png','mjpeg','webp','h264','hevc','vp8','vp9','av1','ffv1','prores'].includes(v.codec_name), 'UNSUPPORTED_CODEC');
  check(Number.isSafeInteger(v.width) && Number.isSafeInteger(v.height) && v.width > 0 && v.height > 0 && v.width * v.height <= s.limits.maxPixels, 'PIXEL_LIMIT');
  check(!v.disposition?.attached_pic && !v.side_data_list?.some((x: any) => x.rotation && x.rotation !== 0), 'UNSUPPORTED_ORIENTATION');
  check(!audio.some((a: any) => a.channels > 8 || Number(a.sample_rate) > 192000), 'UNSUPPORTED_AUDIO');
  const videoClock = clock(v.time_base);
  const probed = JSON.parse((await run(s.ffprobe, [...probeBase, '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=pts,duration,width,height', '-of', 'json', ...inputArgs(path, format, s)], s.limits, cwd)).toString()).frames;
  check(Array.isArray(probed) && probed.length > 0 && probed.length <= s.limits.maxFrames, 'FRAME_LIMIT');
  check(format.kind !== 'image' || (probed.length === 1 && audio.length === 0), 'ANIMATED_IMAGE_UNSUPPORTED');
  for (let i = 0; i < probed.length; i++) {
    const f = probed[i]; check(Number.isSafeInteger(f.pts), 'UNKNOWN_TIMESTAMP');
    check(!i || f.pts > probed[i - 1].pts, 'AMBIGUOUS_PTS');
    check(f.width === v.width && f.height === v.height, 'VARIABLE_DIMENSIONS_UNSUPPORTED');
    check(format.kind === 'image'
      ? f.duration === undefined || (Number.isSafeInteger(f.duration) && f.duration >= 0)
      : Number.isSafeInteger(f.duration) && f.duration > 0, 'UNKNOWN_DURATION');
  }
  const extent = playbackExtent();
  // Only a still image may lack a playback duration; video endpoints were checked above.
  for (const f of probed) extent.include(f.pts, f.duration ?? 0, videoClock);
  if (audio.length) {
    const a = audio[0];
    const audioClock = clock(a.time_base);
    const audioFrames = JSON.parse((await run(s.ffprobe, [...probeBase, '-select_streams', 'a:0', '-show_frames', '-show_entries', 'frame=pts,duration', '-of', 'json', ...inputArgs(path, format, s)], s.limits, cwd)).toString()).frames;
    check(Array.isArray(audioFrames) && audioFrames.length > 0, 'UNKNOWN_DURATION');
    for (const f of audioFrames) {
      check(Number.isSafeInteger(f.pts), 'UNKNOWN_TIMESTAMP');
      check(Number.isSafeInteger(f.duration) && f.duration > 0, 'UNKNOWN_DURATION');
      extent.include(f.pts, f.duration, audioClock);
    }
    // Container ticks can round off audible samples (e.g. AAC in Matroska). Measure
    // the complete native decode on its sample clock too; do not resample or trim.
    const sampleRate = Number(a.sample_rate);
    check(Number.isSafeInteger(sampleRate) && sampleRate > 0 && sampleRate <= 192000, 'UNKNOWN_DURATION');
    const pcm = parseHashes((await run(s.ffmpeg, [...ffBase, '-copyts', ...inputArgs(path, format, s, true),
      '-map', `0:${a.index}`, '-vn', '-sn', '-dn', '-c:a', 'pcm_s16le', '-threads', '1', '-f', 'framehash', '-hash', 'sha256', '-'], s.limits, cwd)).toString());
    check(pcm.timeBase === `1/${sampleRate}` && pcm.rows.length > 0, 'UNKNOWN_DURATION');
    const sampleClock = clock(pcm.timeBase);
    for (const row of pcm.rows) {
      const pts = Number(row[2]), duration = Number(row[3]);
      check(Number.isSafeInteger(pts), 'UNKNOWN_TIMESTAMP');
      check(Number.isSafeInteger(duration) && duration > 0, 'UNKNOWN_DURATION');
      extent.include(pts, duration, sampleClock);
    }
  }
  const durationSeconds = extent.seconds(s.limits.maxDurationSeconds);
  const jpeg = format.mimeType === 'image/jpeg';
  if (jpeg) await run(s.ffmpeg, [...ffBase, ...inputArgs(path, format, s, true), '-f', 'null', '-'], s.limits, cwd);
  const decoded = parseHashes((await run(s.ffmpeg, [...ffBase, '-copyts', ...inputArgs(path, format, s, true), '-map', `0:${v.index}`, '-an', '-sn', '-dn',
    ...(jpeg ? ['-vf', 'scale=in_range=full:out_range=full'] : []), '-fps_mode', 'passthrough', '-enc_time_base', 'demux', '-c:v', 'rawvideo', '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'framehash', '-hash', 'sha256', '-'], s.limits, cwd, jpeg ? 'full-range-jpeg-conversion' : 'strict')).toString());
  check(decoded.timeBase === v.time_base && decoded.rows.length === probed.length && probed.every((f: any, i: number) => String(f.pts) === decoded.rows[i][2]), 'DECODE_PROBE_MISMATCH');
  // Video framehash and the optional sample-clock audio framehash both ran to clean EOF.
  const after = await regular(path, s.limits.maxBytes);
  try { check((await hashFile(after, s.limits.maxBytes)).sha256 === sha256, 'SOURCE_CHANGED'); } finally { await after.close(); }
  return { sourceSha256: sha256, size, kind: format.kind, mimeType: format.mimeType, width: v.width, height: v.height, codec: v.codec_name,
    streamIndex: v.index, timeBase: v.time_base, originPts: String(probed[0].pts), durationSeconds, audioStreams: audio.length,
    frames: probed.map((f: any, index: number) => ({ index, pts: String(f.pts), duration: f.duration === undefined ? null : String(f.duration), rgbSha256: decoded.rows[index][5] })), eof: 'observed-clean-decode' };
}
export function formatOf(inspection: Inspection): Format {
  const demuxer = ({ 'image/png':'png_pipe', 'image/jpeg':'jpeg_pipe', 'image/webp':'webp_pipe', 'video/mp4':'mov', 'video/quicktime':'mov', 'video/webm':'matroska', 'video/x-matroska':'matroska' } as Record<string, string>)[inspection.mimeType];
  check(demuxer, 'UNSUPPORTED_MEDIA_BYTES'); return { kind: inspection.kind, mimeType: inspection.mimeType, demuxer };
}
