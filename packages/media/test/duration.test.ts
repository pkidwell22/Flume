import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMediaStore, freezeExportSelection } from '../src/index.ts';
import { FFMPEG, FFPROBE, id, projectId, sha } from './support.ts';

function native(executable: string, args: string[]) {
  const result = spawnSync(executable, args, { timeout: 20_000, maxBuffer: 8_000_000, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '', 'native measurement/generation must be diagnostic-free');
  return result.stdout;
}
async function fixture(t: TestContext, videoSeconds = 1, audioSeconds?: number, videoOffset = 0, audioOffset = 0) {
  assert.ok(process.env.TMPDIR, 'explicit owned TMPDIR required');
  const dir = await mkdtemp(join(await realpath(process.env.TMPDIR!), 'flume-duration-test-'));
  const owner = id();
  t.after(async () => {
    assert.equal(await readFile(join(dir, '.owner'), 'utf8'), owner);
    await rm(dir, { recursive: true });
    await assert.rejects(stat(dir), { code: 'ENOENT' });
  });
  await writeFile(join(dir, '.owner'), owner, { flag: 'wx' });
  const inputs = join(dir, 'inputs'); await mkdir(inputs);
  const path = join(inputs, 'input.mp4');
  native(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'warning', '-xerror', '-n', '-threads', '1', '-filter_threads', '1',
    '-itsoffset', String(videoOffset), '-f', 'lavfi', '-i', `testsrc2=size=64x48:rate=10:duration=${videoSeconds}`,
    ...(audioSeconds === undefined ? [] : ['-itsoffset', String(audioOffset), '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${audioSeconds}`]),
    '-map', '0:v:0', ...(audioSeconds === undefined ? [] : ['-map', '1:a:0']), '-copyts', '-fps_mode', 'passthrough',
    '-c:v', 'libx264', '-threads:v', '1', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-bf', '0',
    ...(audioSeconds === undefined ? [] : ['-c:a', 'aac', '-threads:a', '1', '-b:a', '64k']), '-movflags', '+faststart', path]);
  const bytes = await readFile(path);
  const probe = JSON.parse(native(FFPROBE, ['-v', 'warning', '-show_streams', '-show_format', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', path]));
  // Independent encoded-packet/container oracle; no production timing helper is used.
  const streams = probe.streams.map((s: any) => ({ type: s.codec_type, index: s.index, codec: s.codec_name, start: Number(s.start_time), duration: Number(s.duration) }));
  assert.ok(streams.every((s: any) => Number.isFinite(s.start) && Number.isFinite(s.duration)));
  const containerExtent = Math.max(...streams.map((s: any) => s.start + s.duration)) - Math.min(...streams.map((s: any) => s.start));
  let start = Math.min(...streams.map((s: any) => s.start)), end = Math.max(...streams.map((s: any) => s.start + s.duration));
  let decodedAudio;
  if (audioSeconds !== undefined) {
    // Full decoded PCM is an independent oracle for padding that container ticks omit.
    const pcm = native(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'warning', '-xerror', '-copyts', '-threads', '1', '-i', path,
      '-map', '0:a:0', '-c:a', 'pcm_s16le', '-threads', '1', '-f', 'framehash', '-']);
    assert.match(pcm, /#tb 0: 1\/48000/);
    const rows = pcm.split('\n').filter(line => line.trim() && !line.startsWith('#')).map(line => line.split(',').map(value => value.trim()));
    decodedAudio = { start: Math.min(...rows.map(row => Number(row[2]) / 48000)), end: Math.max(...rows.map(row => (Number(row[2]) + Number(row[3])) / 48000)), frames: rows.length };
    start = Math.min(start, decodedAudio.start); end = Math.max(end, decodedAudio.end);
  }
  const extent = end - start;
  t.diagnostic(JSON.stringify({ fixture: { videoSeconds, audioSeconds, videoOffset, audioOffset }, sha256: sha(bytes), streams, formatDuration: Number(probe.format.duration), containerExtent, decodedAudio, extent }));
  const options = { root: join(dir, 'store'), importRoots: [inputs], ffmpegPath: FFMPEG, ffprobePath: FFPROBE };
  const request = { projectId, assetId: id(), filePath: path, filename: 'input.mp4', origin: 'sample' as const };
  return { dir, path, bytes, probe, streams, extent, options, request };
}
async function assertClean(root: string, published: number) {
  assert.equal((await readdir(join(root, 'records'))).length, published);
  assert.deepEqual(await readdir(join(root, 'staging')), []);
  await assert.rejects(stat(join(root, '.active-operation')), { code: 'ENOENT' });
}
async function probeFault(dir: string, stream: 'v:0' | 'a:0', change: string) {
  // Explicit fault injection over actual ffprobe output, not a fabricated media fixture.
  const wrapper = join(dir, `probe-fault-${id()}.mjs`);
  await writeFile(wrapper, `#!${process.execPath}
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(FFPROBE)}, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 8000000 });
if (result.error || result.status !== 0 || result.stderr) { process.stderr.write(result.stderr || 'real probe failed'); process.exit(1); }
const data = JSON.parse(result.stdout);
if (args.includes('-show_frames') && args[args.indexOf('-select_streams') + 1] === ${JSON.stringify(stream)}) { ${change} }
process.stdout.write(JSON.stringify(data));
`, { flag: 'wx' });
  await chmod(wrapper, 0o700);
  return wrapper;
}

test('whole-asset bound rejects one-second video with four-second audio before publication', async t => {
  const f = await fixture(t, 1, 4);
  assert.equal(f.extent, 4);
  const store = await createMediaStore({ ...f.options, limits: { maxDurationSeconds: 2 } });
  await assert.rejects(store.importLocal(f.request), { code: 'DURATION_LIMIT' });
  await assertClean(f.options.root, 0);
});

test('missing video endpoint duration rejects rather than treating the last frame as instantaneous', async t => {
  const f = await fixture(t, 1);
  const ffprobePath = await probeFault(f.dir, 'v:0', 'delete data.frames.at(-1).duration;');
  const store = await createMediaStore({ ...f.options, ffprobePath, limits: { maxDurationSeconds: 2 } });
  await assert.rejects(store.importLocal(f.request), { code: 'UNKNOWN_DURATION' });
  await assertClean(f.options.root, 0);
});

test('an earlier frame endpoint cannot be hidden by the last video frame', async t => {
  const f = await fixture(t, 1);
  const ffprobePath = await probeFault(f.dir, 'v:0', 'data.frames[0].duration = 20480;');
  const store = await createMediaStore({ ...f.options, ffprobePath, limits: { maxDurationSeconds: 1 } });
  await assert.rejects(store.importLocal(f.request), { code: 'DURATION_LIMIT' });
  await assertClean(f.options.root, 0);
});

test('one tick over the bound is not rounded away by a large common timestamp origin', async t => {
  const f = await fixture(t, 1);
  const ffprobePath = await probeFault(f.dir, 'v:0', 'for (const frame of data.frames) frame.pts += 9007199254690992; data.frames.at(-1).duration += 1;');
  const store = await createMediaStore({ ...f.options, ffprobePath, limits: { maxDurationSeconds: 1 } });
  await assert.rejects(store.importLocal(f.request), { code: 'DURATION_LIMIT' });
  await assertClean(f.options.root, 0);
});

function closeTo(actual: number | undefined, expected: number) {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= 0.000002, `expected ${expected} seconds, got ${actual}`);
}

test('decoded AAC samples extending beyond a rounded Matroska endpoint still exceed the one-second limit', async t => {
  const f = await fixture(t, 0.1);
  const path = join(f.dir, 'inputs', 'rounded-audio.mkv');
  native(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'warning', '-xerror', '-n', '-threads', '1', '-filter_threads', '1',
    '-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=10:duration=0.1', '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=1',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-threads:v', '1', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-bf', '0',
    '-c:a', 'aac', '-threads:a', '1', path]);
  const frames = JSON.parse(native(FFPROBE, ['-v', 'warning', '-select_streams', 'a:0', '-show_streams', '-show_frames', '-of', 'json', path]));
  assert.equal(frames.streams[0].time_base, '1/1000');
  const last = frames.frames.at(-1);
  assert.equal((last.pts + last.duration) / 1000, 1, 'fixture must fool the container-tick-only endpoint');
  const pcm = native(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'warning', '-xerror', '-copyts', '-threads', '1', '-i', path,
    '-map', '0:a:0', '-c:a', 'pcm_s16le', '-threads', '1', '-f', 'framehash', '-']);
  assert.match(pcm, /#tb 0: 1\/48000/);
  const rows = pcm.split('\n').filter(line => line.trim() && !line.startsWith('#')).map(line => line.split(',').map(value => value.trim()));
  const decodedEnd = Math.max(...rows.map(row => (Number(row[2]) + Number(row[3])) / 48000));
  assert.ok(decodedEnd > 1, 'real decoded samples must extend beyond one second');
  t.diagnostic(JSON.stringify({ containerLastFrame: last, decodedAudioEnd: decodedEnd, decodedAudioFrames: rows.length, sha256: sha(await readFile(path)) }));
  const request = { ...f.request, filePath: path, filename: 'rounded-audio.mkv' };
  const store = await createMediaStore({ ...f.options, limits: { maxDurationSeconds: 1 } });
  await assert.rejects(store.importLocal(request), { code: 'DURATION_LIMIT' });
  await assertClean(f.options.root, 0);
  const roomy = await createMediaStore({ ...f.options, root: join(f.dir, 'roomy'), limits: { maxDurationSeconds: 2 } });
  const asset = await roomy.importLocal(request);
  closeTo(asset.durationSeconds, decodedEnd);
  await assertClean(join(f.dir, 'roomy'), 1);
});

test('accepted trailing audio export retains every AAC packet and reports whole-asset metadata', async t => {
  const f = await fixture(t, 1, 4);
  const store = await createMediaStore({ ...f.options, limits: { maxDurationSeconds: 6 } });
  const source = await store.importLocal(f.request);
  const inputInspection = await store.inspect({ projectId, assetId: source.id });
  closeTo(source.durationSeconds, f.extent); closeTo(inputInspection.durationSeconds, f.extent);
  assert.equal(inputInspection.audioStreams, 1);
  const frozen = freezeExportSelection({ projectId, exportId: id(), assetId: id(), shotId: id(), takeId: id(), sourceAssetId: source.id,
    sourceSha256: source.sha256, shotRevision: 1, selectionRevision: 1, profile: 'mp4-copy-v1' });
  const exported = await store.exportSelected(frozen);
  const outputInspection = await store.inspect({ projectId, assetId: exported.id });
  const opened = await store.openAsset({ projectId, assetId: exported.id });
  let bytes: Buffer;
  try { bytes = await opened.file.readFile(); } finally { await opened.file.close(); }
  const path = join(f.dir, 'export.mp4'); await writeFile(path, bytes, { flag: 'wx' });
  const probe = JSON.parse(native(FFPROBE, ['-v', 'warning', '-show_streams', '-show_format', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', path]));
  const audio = probe.streams.find((s: any) => s.codec_type === 'audio');
  assert.equal(audio.codec_name, 'aac'); closeTo(Number(audio.start_time) + Number(audio.duration), 4);
  const packetFacts = (p: any) => {
    const index = p.streams.find((s: any) => s.codec_type === 'audio').index;
    return p.packets.filter((packet: any) => packet.stream_index === index).map((packet: any) => [packet.pts_time, packet.duration_time, packet.data_hash]);
  };
  assert.deepEqual(packetFacts(probe), packetFacts(f.probe), 'all copied AAC payloads/timestamps/durations must survive, including the tail');
  const audioPcmHash = (input: string) => native(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'warning', '-xerror', '-threads', '1', '-i', input,
    '-map', '0:a:0', '-c:a', 'pcm_s16le', '-threads', '1', '-f', 'hash', '-hash', 'sha256', '-']).trim();
  assert.equal(audioPcmHash(path), audioPcmHash(f.path), 'all decoded audio samples must survive');
  closeTo(Number(probe.format.duration), f.extent);
  closeTo(exported.durationSeconds, f.extent); closeTo(outputInspection.durationSeconds, f.extent);
  assert.deepEqual(outputInspection.frames, inputInspection.frames);
  assert.equal(exported.sha256, sha(bytes)); assert.equal(source.sha256, sha(await readFile(f.path)));
  t.diagnostic(JSON.stringify({ sourceDuration: source.durationSeconds, sourceInspectionDuration: inputInspection.durationSeconds,
    exportDuration: exported.durationSeconds, exportInspectionDuration: outputInspection.durationSeconds,
    exportedSha256: sha(bytes), audioPacketCount: packetFacts(probe).length, audioPcmHash: audioPcmHash(path), videoFrameCount: outputInspection.frames.length }));
  await assertClean(f.options.root, 2);
});

test('accepted offset audio export preserves the decoded tail beyond container duration', async t => {
  const f = await fixture(t, 1, 1, 0, 3);
  assert.ok(f.extent > Number(f.probe.format.duration), 'fixture has a decoded tail omitted by container duration');
  const store = await createMediaStore({ ...f.options, limits: { maxDurationSeconds: 6 } });
  const source = await store.importLocal(f.request);
  const frozen = freezeExportSelection({ projectId, exportId: id(), assetId: id(), shotId: id(), takeId: id(), sourceAssetId: source.id,
    sourceSha256: source.sha256, shotRevision: 1, selectionRevision: 1, profile: 'mp4-copy-v1' });
  const exported = await store.exportSelected(frozen);
  const opened = await store.openAsset({ projectId, assetId: exported.id });
  const path = join(f.dir, 'offset-export.mp4');
  try { await writeFile(path, await opened.file.readFile(), { flag: 'wx' }); } finally { await opened.file.close(); }
  const audioFrames = (input: string) => native(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'warning', '-xerror', '-copyts', '-threads', '1', '-i', input,
    '-map', '0:a:0', '-c:a', 'pcm_s16le', '-threads', '1', '-f', 'framehash', '-']).split('\n').filter(line => line.trim() && !line.startsWith('#'));
  assert.deepEqual(audioFrames(path), audioFrames(f.path), 'decoded audio PTS, duration, sample bytes and final sample must remain identical');
  closeTo(source.durationSeconds, f.extent); closeTo(exported.durationSeconds, f.extent);
  closeTo((await store.inspect({ projectId, assetId: exported.id })).durationSeconds, f.extent);
  t.diagnostic(JSON.stringify({ offsetAudioExportDuration: exported.durationSeconds, decodedAudioFramesPreserved: audioFrames(path).length }));
  await assertClean(f.options.root, 2);
});

for (const [name, videoOffset, audioOffset] of [['delayed audio', 0, 3], ['audio before video', 3, 0]] as const) {
  test(`whole-asset extent includes ${name} and intervening gaps`, async t => {
    const f = await fixture(t, 1, 1, videoOffset, audioOffset);
    assert.ok(f.extent >= 4, 'one-second streams offset by three seconds must span at least four seconds');
    const store = await createMediaStore({ ...f.options, limits: { maxDurationSeconds: 2 } });
    await assert.rejects(store.importLocal(f.request), { code: 'DURATION_LIMIT' });
    await assertClean(f.options.root, 0);
    const roomy = await createMediaStore({ ...f.options, root: join(f.dir, 'roomy'), limits: { maxDurationSeconds: 6 } });
    const accepted = await roomy.importLocal(f.request);
    closeTo(accepted.durationSeconds, f.extent);
    closeTo((await roomy.inspect({ projectId, assetId: accepted.id })).durationSeconds, f.extent);
    await assertClean(join(f.dir, 'roomy'), 1);
  });
}

for (const offset of [0, 5]) {
  test(`ordinary video-only duration remains one second with origin ${offset}`, async t => {
    const f = await fixture(t, 1, undefined, offset);
    assert.equal(f.extent, 1);
    const store = await createMediaStore({ ...f.options, limits: { maxDurationSeconds: 1 } });
    const asset = await store.importLocal(f.request);
    const inspection = await store.inspect({ projectId, assetId: asset.id });
    closeTo(asset.durationSeconds, 1); closeTo(inspection.durationSeconds, 1);
    assert.equal(inspection.audioStreams, 0); assert.equal(inspection.frames.length, 10);
    assert.equal(asset.sha256, sha(f.bytes));
    await assertClean(f.options.root, 1);
  });
}

for (const [label, change, code] of [
  ['missing timestamp', 'delete data.frames.at(-1).pts;', 'UNKNOWN_TIMESTAMP'],
  ['missing duration', 'delete data.frames.at(-1).duration;', 'UNKNOWN_DURATION'],
  ['zero duration', 'data.frames.at(-1).duration = 0;', 'UNKNOWN_DURATION'],
  ['no decoded frames', 'data.frames = [];', 'UNKNOWN_DURATION'],
] as const) {
  test(`unmeasurable audio fails closed: ${label} (probe-field fault injection)`, async t => {
    const f = await fixture(t, 1, 4);
    const ffprobePath = await probeFault(f.dir, 'a:0', change);
    const store = await createMediaStore({ ...f.options, ffprobePath, limits: { maxDurationSeconds: 6 } });
    await assert.rejects(store.importLocal(f.request), { code });
    await assertClean(f.options.root, 0);
  });
}

