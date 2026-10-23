import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createMediaStore } from '../src/index.ts';
import { fixture, ff, id, projectId, FFMPEG } from './support.ts';

const NOTICE = '[swscaler @ 0xffff8c010f80] No accelerated colorspace conversion found from yuv420p to rgb24.';

// Synthetic replica of the FFmpeg 7 arm64 swscale limitation: the trusted test seam forwards to the
// real FFmpeg byte-for-byte and only adds the known notice on the rgb24 conversion pass.
async function injector(f: { dir: string }, name: string, lines: readonly string[]) {
  const path = join(f.dir, name);
  await writeFile(path, `#!${process.execPath}\n`
    + `const {spawnSync}=require('node:child_process');\n`
    + `const args=process.argv.slice(2);\n`
    + `if(args.includes('rgb24')) process.stderr.write(${JSON.stringify(lines.map(line => `${line}\n`).join(''))});\n`
    + `const r=spawnSync(${JSON.stringify(FFMPEG)},args,{stdio:['ignore','inherit','inherit'],timeout:20000});\n`
    + `process.exit(r.status??1);\n`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

async function extractionInjector(f: { dir: string }, name: string, lines: readonly string[], exitCode = 0) {
  const path = join(f.dir, name);
  await writeFile(path, `#!${process.execPath}\n`
    + `const {spawnSync}=require('node:child_process');\n`
    + `const args=process.argv.slice(2);\n`
    + `const extraction=args.includes('-filter_complex')&&args.some(x=>x.includes('split=2[image][hash]'));\n`
    + `if(extraction) process.stderr.write(${JSON.stringify(lines.map(line => `${line}\n`).join(''))});\n`
    + `const r=spawnSync(${JSON.stringify(FFMPEG)},args,{stdio:['ignore','inherit','inherit'],timeout:20000});\n`
    + `process.exit(extraction&&${exitCode}!==0?${exitCode}:r.status??1);\n`, { mode: 0o700 });
  return path;
}

async function yuv420pFixture(t: TestContext) {
  const f = await fixture(t), path = join(f.inputs, 'software-rgb.mp4');
  ff(['-framerate', '25', '-i', join(f.inputs, 'frame-%d.ppm'), '-frames:v', '6', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', '-threads', '1', '-movflags', '+faststart', path]);
  return { ...f, path, request: { projectId, assetId: id(), filename: 'software-rgb.mp4', origin: 'sample' as const } };
}

test('a yuv420p import survives the arm64 software RGB conversion notice with identical frames', async t => {
  const f = await yuv420pFixture(t);
  const strict = await createMediaStore(f.options);
  const reference = await strict.importLocal({ ...f.request, filePath: f.path });
  const measured = await strict.inspect({ projectId, assetId: reference.id });
  const wrapped = await createMediaStore({ ...f.options, root: join(f.dir, 'wrapped'), ffmpegPath: await injector(f, 'ffmpeg-software-rgb.cjs', [NOTICE]) });
  const imported = await wrapped.importLocal({ ...f.request, filePath: f.path });
  assert.equal(imported.sha256, reference.sha256);
  assert.equal(imported.durationSeconds, reference.durationSeconds);
  const inspected = await wrapped.inspect({ projectId, assetId: imported.id });
  assert.deepEqual(inspected.frames.map(x => x.pts), measured.frames.map(x => x.pts));
  assert.deepEqual(inspected.frames.map(x => x.rgbSha256), measured.frames.map(x => x.rgbSha256));
});

test('the notice never excuses a second diagnostic on the conversion pass', async t => {
  const f = await yuv420pFixture(t);
  const store = await createMediaStore({ ...f.options, ffmpegPath: await injector(f, 'ffmpeg-mixed.cjs',
    [NOTICE, '[h264 @ 0x7f8a1c030000] Error while decoding stream #0:0: Invalid data found when processing input']) });
  await assert.rejects(store.importLocal({ ...f.request, filePath: f.path }), /DECODE_DIAGNOSTIC/);
  assert.deepEqual(await readdir(join(f.options.root, 'records')), []);
  assert.deepEqual(await readdir(join(f.options.root, 'staging')), []);
});

test('the notice is scoped to yuv420p video and never relaxes a bgr0 decode', async t => {
  const f = await fixture(t); // source.mkv is ffv1/bgr0, which has no such conversion notice
  const store = await createMediaStore({ ...f.options, ffmpegPath: await injector(f, 'ffmpeg-software-rgb.cjs', [NOTICE]) });
  await assert.rejects(store.importLocal({ projectId, assetId: id(), filename: 'source.mkv', origin: 'sample', filePath: f.video }),
    /DECODE_DIAGNOSTIC/);
  assert.deepEqual(await readdir(join(f.options.root, 'records')), []);
});

test('corrupt yuv420p bytes are rejected even when the notice is tolerated', async t => {
  const f = await yuv420pFixture(t);
  const bytes = await readFile(f.path), truncated = join(f.inputs, 'truncated.mp4');
  await writeFile(truncated, bytes.subarray(0, bytes.length - 200));
  const store = await createMediaStore({ ...f.options, ffmpegPath: await injector(f, 'ffmpeg-software-rgb.cjs', [NOTICE]) });
  await assert.rejects(store.importLocal({ ...f.request, filename: 'truncated.mp4', filePath: truncated }),
    /MEDIA_PROCESS_FAILED|DECODE_DIAGNOSTIC/);
  assert.deepEqual(await readdir(join(f.options.root, 'records')), []);
  assert.deepEqual(await readdir(join(f.options.root, 'staging')), []);
});

test('frame extraction tolerates only the exact software RGB notice after clean source validation', async t => {
  const f = await yuv420pFixture(t);
  const strict = await createMediaStore(f.options);
  const source = await strict.importLocal({ ...f.request, filePath: f.path });
  const measured = await strict.extractFrame({ projectId, assetId: id(), sourceAssetId: source.id, frame: 'last' });
  const wrapped = await createMediaStore({ ...f.options, ffmpegPath: await extractionInjector(f, 'ffmpeg-extract-notice.cjs', [NOTICE]) });
  const extracted = await wrapped.extractFrame({ projectId, assetId: id(), sourceAssetId: source.id, frame: 'last' });
  assert.equal(extracted.provenance?.sourceSha256, source.sha256);
  assert.equal(extracted.provenance?.frameIndex, 5);
  assert.equal(extracted.provenance?.pts, measured.provenance?.pts);
  assert.equal(extracted.provenance?.timeBase, measured.provenance?.timeBase);
  assert.equal(extracted.provenance?.rgbSha256, measured.provenance?.rgbSha256);
  assert.equal(extracted.sha256, measured.sha256);
});

test('frame extraction refuses mixed diagnostics and nonzero exit despite the software RGB notice', async t => {
  const f = await yuv420pFixture(t);
  const strict = await createMediaStore(f.options);
  const source = await strict.importLocal({ ...f.request, filePath: f.path });
  const mixed = await createMediaStore({ ...f.options, ffmpegPath: await extractionInjector(f, 'ffmpeg-extract-mixed.cjs',
    [NOTICE, '[h264 @ 0x7f8a1c030000] Invalid data found when processing input']) });
  await assert.rejects(mixed.extractFrame({ projectId, assetId: id(), sourceAssetId: source.id, frame: 'first' }), /DECODE_DIAGNOSTIC/);
  const nonzero = await createMediaStore({ ...f.options, ffmpegPath: await extractionInjector(f, 'ffmpeg-extract-nonzero.cjs', [NOTICE], 9) });
  await assert.rejects(nonzero.extractFrame({ projectId, assetId: id(), sourceAssetId: source.id, frame: 'first' }), /MEDIA_PROCESS_FAILED/);
});
