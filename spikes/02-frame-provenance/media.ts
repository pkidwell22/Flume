import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { FFMPEG, FFPROBE, OUTPUT, FIXTURE_IDS, fixturePath, sha256 } from './fixtures.ts';
import type { FixtureId } from './fixtures.ts';
import { add, compare, fraction, multiply, seconds, subtract, ticks } from './clock.ts';
import type { Q } from './clock.ts';

const exec = promisify(execFile);
export interface Selection {
  mode: 'first' | 'last' | 'custom'; range: { start: string; end: string }; requested?: string;
  mapping?: { timelineTime: string; sourceStart: string; rate: string };
}
export interface Extraction {
  kind: 'actual-output-frame'; source: Inspection; request: Selection; requestedSourceTime: string | null;
  decoded: Frame & { timeBase: string; sourceTime: string; relativeTime: string };
  image: { path: string; sha256: string }; evidence: string;
}
export async function extract(fixture: FixtureId, request: Selection): Promise<Extraction> {
  request = structuredClone(request);
  if (!['first', 'last', 'custom'].includes(request.mode)) throw new Error('UNSUPPORTED_MODE');
  if (request.mapping && request.requested !== undefined) throw new Error('AMBIGUOUS_REQUEST');
  if (request.mode !== 'custom' && (request.mapping || request.requested !== undefined)) throw new Error('UNEXPECTED_REQUESTED_TIME');
  const start = seconds(request.range.start); const end = seconds(request.range.end);
  if (compare(start, end) >= 0) throw new Error('INVALID_RANGE: start < end required');
  let requested: Q | null = null;
  if (request.mode === 'custom') {
    if (request.mapping) {
      const rate = seconds(request.mapping.rate);
      if (compare(rate, [0n, 1n]) <= 0) throw new Error('UNSUPPORTED_RATE: constant positive rate only');
      if (compare(seconds(request.mapping.timelineTime), [0n, 1n]) < 0) throw new Error('NEGATIVE_TIMELINE_TIME');
      requested = add(seconds(request.mapping.sourceStart), multiply(seconds(request.mapping.timelineTime), rate));
    } else if (request.requested !== undefined) requested = seconds(request.requested);
    else throw new Error('CUSTOM_TIME_REQUIRED');
    if (compare(requested, start) < 0 || compare(requested, end) >= 0) throw new Error('REQUEST_OUTSIDE_RANGE');
  }
  const source = await inspect(fixture);
  const candidates = source.frames.filter(f => compare(ticks(f.pts, source.timeBase), start) >= 0 && compare(ticks(f.pts, source.timeBase), end) < 0);
  if (!candidates.length) throw new Error('NO_FRAME_IN_RANGE');
  const chosen = request.mode === 'last' ? candidates.at(-1)! : requested ? candidates.find(f => compare(ticks(f.pts, source.timeBase), requested!) >= 0) : candidates[0];
  if (!chosen) throw new Error('NO_FRAME_AT_OR_AFTER_REQUEST');
  const evidence = await evidenceDir('extract');
  const image = resolve(evidence, 'frame.png');
  const framehash = (await run(FFMPEG, [
    '-hide_banner', '-nostdin', '-v', 'warning', '-xerror', '-copyts', '-protocol_whitelist', 'file,pipe', '-i', source.snapshotPath,
    '-filter_complex', `[0:${source.streamIndex}]select=eq(n\\,${chosen.index}),split=2[image][hash]`,
    '-map', '[image]', '-frames:v', '1', '-fps_mode', 'passthrough', '-c:v', 'png', '-threads', '1', '-update', '1', image,
    '-map', '[hash]', '-frames:v', '1', '-fps_mode', 'passthrough', '-enc_time_base', source.timeBase,
    '-c:v', 'rawvideo', '-pix_fmt', 'rgb24', '-f', 'framehash', '-hash', 'sha256', '-',
  ], evidence, 'extraction')).toString();
  const row = framehash.split('\n').find(line => line && !line.startsWith('#'))?.split(',').map(s => s.trim());
  if (row?.[2] !== chosen.pts || row?.[5] !== chosen.rgbSha256 || framehash.match(/#tb 0: (\S+)/)?.[1] !== source.timeBase) throw new Error(`EXTRACT_MISMATCH: ${evidence}`);
  const rgb = await run(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'warning', '-xerror', '-i', image, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], evidence, 'png-roundtrip');
  if (sha256(rgb) !== chosen.rgbSha256) throw new Error(`PNG_PIXEL_MISMATCH: ${evidence}`);
  const result: Extraction = {
    kind: 'actual-output-frame', source, request: structuredClone(request), requestedSourceTime: requested ? fraction(requested) : null,
    decoded: { ...chosen, timeBase: source.timeBase, sourceTime: fraction(ticks(chosen.pts, source.timeBase)), relativeTime: fraction(subtract(ticks(chosen.pts, source.timeBase), ticks(source.origin, source.timeBase))) },
    image: { path: image, sha256: sha256(await readFile(image)) }, evidence,
  };
  await writeFile(resolve(evidence, 'extraction.json'), JSON.stringify(result, null, 2));
  return result;
}

export interface Frame { index: number; pts: string; duration: string | null; rgbSha256: string }
export interface Inspection {
  fixture: FixtureId; sourceSha256: string; snapshotPath: string; streamIndex: number; timeBase: string;
  origin: string; frames: Frame[]; eof: 'observed-clean-decode'; evidence: string;
}

async function evidenceDir(prefix: string): Promise<string> {
  const root = resolve(OUTPUT, 'evidence');
  await mkdir(root, { recursive: true });
  return mkdtemp(resolve(root, `${prefix}-`));
}

async function run(executable: string, args: string[], dir: string, label: string): Promise<Buffer> {
  try {
    const result = await exec(executable, args, { encoding: 'buffer', timeout: 30_000, maxBuffer: 16_000_000 });
    await writeFile(resolve(dir, `${label}.stdout`), result.stdout);
    await writeFile(resolve(dir, `${label}.stderr`), result.stderr);
    await writeFile(resolve(dir, `${label}.command.json`), JSON.stringify({ executable, args, exitCode: 0 }, null, 2));
    if (result.stderr.length) throw new Error(`DECODE_DIAGNOSTIC: ${dir}/${label}.stderr`);
    return result.stdout;
  } catch (error: any) {
    if (error.stdout !== undefined) {
      await writeFile(resolve(dir, `${label}.stdout`), error.stdout);
      await writeFile(resolve(dir, `${label}.stderr`), error.stderr ?? '');
      await writeFile(resolve(dir, `${label}.command.json`), JSON.stringify({ executable, args, exitCode: error.code, signal: error.signal }, null, 2));
    }
    throw new Error(`MEDIA_PROCESS_FAILED: ${error.message}; evidence=${dir}`);
  }
}

export async function inspect(fixture: FixtureId): Promise<Inspection> {
  if (!FIXTURE_IDS.includes(fixture)) throw new Error('OWNED_FIXTURE_ONLY');
  const evidence = await evidenceDir(fixture);
  const bytes = await readFile(fixturePath(fixture));
  const sourceSha256 = sha256(bytes);
  const source = resolve(evidence, `source${extname(fixturePath(fixture))}`);
  await writeFile(source, bytes, { flag: 'wx', mode: 0o444 });
  const probe = JSON.parse((await run(FFPROBE, [
    '-v', 'warning', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_frames', '-show_format', '-of', 'json', source,
  ], evidence, 'ffprobe')).toString());
  const videos = probe.streams.filter((s: any) => s.codec_type === 'video');
  if (videos.length !== 1) throw new Error(`UNSUPPORTED_VIDEO_STREAMS: ${videos.length}; evidence=${evidence}`);
  const stream = videos[0];
  const decoded = probe.frames.filter((f: any) => f.stream_index === stream.index);
  if (!decoded.length || !/^[1-9]\d*\/[1-9]\d*$/.test(stream.time_base)) throw new Error(`UNKNOWN_TIMESTAMP: no frames/timebase; evidence=${evidence}`);
  for (let i = 0; i < decoded.length; i++) {
    if (!Number.isSafeInteger(decoded[i].pts)) throw new Error(`UNKNOWN_TIMESTAMP: missing or unsafe PTS; evidence=${evidence}`);
    if (i && decoded[i].pts <= decoded[i - 1].pts) throw new Error(`AMBIGUOUS_PTS: equal or nonmonotonic; evidence=${evidence}`);
  }
  const framehash = (await run(FFMPEG, [
    '-hide_banner', '-nostdin', '-v', 'warning', '-xerror', '-copyts', '-protocol_whitelist', 'file,pipe', '-i', source,
    '-map', `0:${stream.index}`, '-an', '-sn', '-dn', '-fps_mode', 'passthrough', '-enc_time_base', 'demux',
    '-c:v', 'rawvideo', '-pix_fmt', 'rgb24', '-f', 'framehash', '-hash', 'sha256', '-',
  ], evidence, 'decoded-framehash')).toString();
  const hashes = framehash.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').map(s => s.trim()));
  if (framehash.match(/#tb 0: (\S+)/)?.[1] !== stream.time_base || hashes.length !== decoded.length ||
      decoded.some((f: any, i: number) => String(f.pts) !== hashes[i][2])) throw new Error(`DECODE_PROBE_MISMATCH: ${evidence}`);
  const frames = decoded.map((f: any, index: number) => ({
    index, pts: String(f.pts), duration: f.duration === undefined ? null : String(f.duration), rgbSha256: hashes[index][5],
  }));
  const result: Inspection = { fixture, sourceSha256, snapshotPath: source, streamIndex: stream.index, timeBase: stream.time_base, origin: frames[0].pts, frames, eof: 'observed-clean-decode', evidence };
  await writeFile(resolve(evidence, 'inspection.json'), JSON.stringify(result, null, 2));
  return result;
}
