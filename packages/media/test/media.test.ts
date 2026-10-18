import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile, symlink, chmod } from 'node:fs/promises';
import { createMediaStore } from '../src/index.ts';
import test from 'node:test';
import { join } from 'node:path';
import { fixture, projectId, id, pixels, pts, sha, WIDTH, HEIGHT } from './support.ts';

test('imports real bytes, measures every source PTS/pixel and retains the original across restart', async t => {
  const mod = await import('../src/index.ts').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return null; throw e; });
  assert.equal(typeof mod?.createMediaStore, 'function', 'owned-media entry point must exist');
  const f = await fixture(t), store = await mod!.createMediaStore(f.options);
  const original = await readFile(f.video), assetId = id();
  const asset = await store.importLocal({ assetId, projectId, filePath: f.video, filename: 'my take.mkv', origin: 'imported' });
  assert.equal(asset.sha256, sha(original));
  assert.equal(asset.origin, 'imported');
  assert.equal(asset.kind, 'video');
  assert.equal(asset.width, WIDTH); assert.equal(asset.height, HEIGHT);
  assert.equal(asset.mediaUrl, `/api/media/${assetId}`);
  const measured = await store.inspect({ projectId, assetId });
  assert.equal(measured.eof, 'observed-clean-decode');
  assert.equal(measured.timeBase, '1/1000');
  assert.deepEqual(measured.frames.map(x => x.pts), pts);
  assert.deepEqual(measured.frames.map(x => x.rgbSha256), [0,1,2,3,4,5].map(n => sha(pixels(n))));
  await writeFile(f.video, 'working source replaced');
  const restarted = await mod!.createMediaStore(f.options);
  const handle = await restarted.openAsset({ projectId, assetId });
  try { assert.equal(sha(await handle.file.readFile()), sha(original)); }
  finally { await handle.file.close(); }
  assert.equal((await stat(join(f.options.root, 'objects', asset.sha256))).mode & 0o222, 0);
  assert.deepEqual(await readdir(join(f.options.root, 'staging')), []);
});

test('bounded multipart-style streams inspect bytes, reject MIME lies, and never publish failed imports', async t => {
  const f = await fixture(t); const bytes = await readFile(f.image);
  const store = await createMediaStore({ ...f.options, limits: { maxBytes: bytes.length, ingestTimeoutMs: 100 } });
  const input = { assetId: id(), projectId, filename: 'reference.png', origin: 'sample' as const, claimedMime: 'image/png' };
  async function* chunks() { yield bytes.subarray(0, 20); yield bytes.subarray(20); }
  assert.equal(typeof store.importStream, 'function', 'bounded upload import required');
  const asset = await store.importStream(input, chunks());
  assert.equal(asset.origin, 'sample'); assert.equal(asset.sha256, sha(bytes));
  assert.equal((await store.importStream(input, chunks())).id, asset.id, 'exact retry keeps identity');
  await assert.rejects(store.importStream({ ...input, assetId: id(), claimedMime: 'video/mp4' }, chunks()), /MIME_MISMATCH/);
  await assert.rejects(store.importStream({ ...input, assetId: id() }, (async function* () { yield bytes; yield Buffer.from([1]); })()), /BYTE_LIMIT/);
  await assert.rejects(store.importStream({ ...input, assetId: id() }, { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; } }), /INGEST_TIMEOUT/);
  assert.equal((await readdir(join(f.options.root, 'records'))).length, 1);
  assert.deepEqual(await readdir(join(f.options.root, 'staging')), []);
});

test('local intake blocks path traversal, symlinks, wrong-project reads, malformed IDs and tampered objects', async t => {
  const f = await fixture(t); const store = await createMediaStore(f.options);
  const input = { assetId: id(), projectId, filename: 'reference.png', origin: 'imported' as const, filePath: f.image };
  await symlink(f.image, join(f.inputs, 'link.png'));
  await assert.rejects(store.importLocal({ ...input, filePath: join(f.inputs, 'link.png') }), /SYMLINK_REJECTED/);
  await assert.rejects(store.importLocal({ ...input, filePath: join(f.dir, 'outside.png') }), /OUTSIDE_IMPORT_ROOT/);
  await assert.rejects(store.importLocal({ ...input, assetId: ` ${input.assetId}` }), /INVALID_ID/);
  const asset = await store.importLocal(input);
  await assert.rejects(store.openAsset({ projectId: id(), assetId: asset.id }), /ASSET_NOT_IN_PROJECT/);
  const path = join(f.options.root, 'objects', asset.sha256);
  await chmod(path, 0o600); await writeFile(path, 'tampered');
  await assert.rejects(store.openAsset({ projectId, assetId: asset.id }), /STORAGE_CORRUPT/);
});
