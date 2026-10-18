import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, readdir, writeFile, open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createMediaStore, DEFAULT_LIMITS } from '../src/index.ts';
import { run } from '../src/process.ts';
import { fixture, projectId, id, FFMPEG, ff } from './support.ts';

test('a real exit-zero FFmpeg warning is not a clean successful decode', async t => {
  const f = await fixture(t);
  // image2 warns because a still filename has no sequence pattern; FFmpeg still exits zero.
  await assert.rejects(run(FFMPEG, ['-hide_banner','-nostdin','-v','warning','-i',f.image,'-frames:v','1','-threads','1',join(f.dir,'warning.png')], DEFAULT_LIMITS, f.dir), /DECODE_DIAGNOSTIC/);
});

test('real FFmpeg process deadline and output cap reject and reap, rather than leaving native work running', async t => {
  const f = await fixture(t); const started = Date.now();
  await assert.rejects(run(FFMPEG, ['-hide_banner','-nostdin','-v','warning','-re','-f','lavfi','-i','testsrc=size=64x48:rate=30','-threads','1','-f','null','-'], { ...DEFAULT_LIMITS, processTimeoutMs: 150 }, f.dir), /PROCESS_TIMEOUT/);
  assert.ok(Date.now() - started < 2000);
  await assert.rejects(run(FFMPEG, ['-hide_banner','-nostdin','-v','warning','-i',f.video,'-f','rawvideo','-pix_fmt','rgb24','-'], { ...DEFAULT_LIMITS, maxProcessOutputBytes: 64 }, f.dir), /PROCESS_OUTPUT_LIMIT/);
});

test('truncated, unsupported, pixel/frame-limited bytes never acquire an available asset record', async t => {
  const f = await fixture(t); const original = await readFile(f.video);
  const store = await createMediaStore(f.options);
  const req = { projectId, assetId: id(), filename: 'take.mkv', origin: 'imported' as const };
  await assert.rejects(store.importStream(req, (async function* () { yield original.subarray(0, original.length - 300); })()), /MEDIA_PROCESS_FAILED|DECODE_DIAGNOSTIC/);
  await assert.rejects(store.importStream(req, (async function* () { yield Buffer.from('<svg><script>oops</script></svg>'); })()), /UNSUPPORTED_MEDIA_BYTES/);
  const limitedFrames = await createMediaStore({ ...f.options, limits: { maxFrames: 5 } });
  await assert.rejects(limitedFrames.importLocal({ ...req, filePath: f.video }), /FRAME_LIMIT/);
  const limitedPixels = await createMediaStore({ ...f.options, limits: { maxPixels: 100 } });
  await assert.rejects(limitedPixels.importLocal({ ...req, filePath: f.video }), /PIXEL_LIMIT|MEDIA_PROCESS_FAILED/);
  assert.deepEqual(await readdir(join(f.options.root, 'records')), []);
  assert.deepEqual(await readdir(join(f.options.root, 'staging')), []);
});

test('owned storage excludes overlapping operations even through separately opened store handles', async t => {
  const f = await fixture(t); const one = await createMediaStore(f.options), two = await createMediaStore(f.options);
  const bytes = await readFile(f.image); let release!: () => void, held!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { held = resolve; });
  const request = { projectId, assetId: id(), filename: 'first.png', origin: 'imported' as const };
  const pending = one.importStream(request, (async function* () { held(); await blocked; yield bytes; })());
  try {
    await entered;
    await assert.rejects(two.importLocal({ ...request, assetId: id(), filePath: f.image }), /MEDIA_BUSY/);
  } finally { release(); await pending; }
  assert.deepEqual(await readdir(join(f.options.root, 'staging')), []);
});

test('common JPEG imports and cover preparations decode actual bytes rather than filename extensions', async t => {
  const f = await fixture(t); const store = await createMediaStore(f.options);
  const path = join(f.inputs, 'reference.jpg'); ff(['-i', f.image, '-frames:v','1','-update','1',path]);
  const source = await store.importLocal({ projectId, assetId: id(), filename: 'misleading.png', filePath: path, origin: 'imported', claimedMime: 'image/jpeg' });
  assert.equal(source.mimeType, 'image/jpeg');
  const result = await store.prepareImage({ projectId, assetId: id(), sourceAssetId: source.id, role: 'first_frame', profile: { kind: 'fit-png-v1', width: 64, height: 64, fit: 'cover', background: 'white' } });
  assert.equal(result.mimeType, 'image/png'); assert.equal(result.width, 64); assert.equal(result.height, 64);
});

test('animated PNG is not silently imported as its opening still frame', async t => {
  const f = await fixture(t); const path = join(f.inputs, 'animation.png');
  ff(['-framerate','25','-i',join(f.inputs,'frame-%d.ppm'),'-frames:v','6','-f','apng',path]);
  const store = await createMediaStore(f.options);
  await assert.rejects(store.importLocal({ projectId, assetId: id(), filename: 'animation.png', filePath: path, origin: 'imported' }), /ANIMATED_IMAGE_UNSUPPORTED/);
  assert.deepEqual(await readdir(join(f.options.root, 'records')), []);
});

test('unowned roots are rejected without deleting or rewriting pre-existing data', async t => {
  const f = await fixture(t); await mkdir(f.options.root, { mode: 0o700 });
  const sentinel = join(f.options.root, 'sentinel'); await writeFile(sentinel, 'not media data');
  await assert.rejects(createMediaStore(f.options), /UNOWNED_ROOT/);
  assert.equal(await readFile(sentinel, 'utf8'), 'not media data');
});

test('failed metadata durability never publishes a new available record', async t => {
  const f = await fixture(t); const store = await createMediaStore(f.options);
  const records = join(f.options.root, 'records'), inode = (await stat(records)).ino;
  const probe = await open(join(f.dir, 'probe'), 'wx'); const proto = Object.getPrototypeOf(probe);
  await probe.close(); const original = proto.sync; let injected = false;
  proto.sync = async function(this: FileHandle) {
    const info = await this.stat();
    if (!injected && info.isDirectory() && info.ino === inode) { injected = true; throw new Error('injected durability failure'); }
    return original.call(this);
  };
  try {
    await assert.rejects(store.importLocal({ projectId, assetId: id(), filename: 'first.png', filePath: f.image, origin: 'imported' }), /injected durability failure/);
  } finally { proto.sync = original; }
  assert.equal(injected, true); assert.deepEqual(await readdir(records), []);
  assert.deepEqual(await readdir(join(f.options.root, 'staging')), []);
});
