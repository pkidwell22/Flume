import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createMediaStore } from '../src/index.ts';
import { fixture, projectId, id, pixels, sha, ff } from './support.ts';

test('last-frame extraction matches the final actual VFR pixels, PTS and complete frame count', async t => {
  const f = await fixture(t); const store = await createMediaStore(f.options);
  const source = await store.importLocal({ projectId, assetId: id(), filePath: f.video, filename: 'source.mkv', origin: 'sample' });
  assert.equal(typeof store.extractFrame, 'function', 'measured frame extraction required');
  const last = await store.extractFrame({ projectId, assetId: id(), sourceAssetId: source.id, frame: 'last' });
  const first = await store.extractFrame({ projectId, assetId: id(), sourceAssetId: source.id, frame: 'first' });
  assert.equal(last.origin, 'sample'); assert.notEqual(first.sha256, last.sha256);
  assert.equal(last.provenance?.sourceSha256, source.sha256);
  assert.equal(last.provenance?.frameIndex, 5); assert.equal(last.provenance?.pts, '5480');
  assert.equal(last.provenance?.timeBase, '1/1000'); assert.equal(last.provenance?.sourceFrameCount, 6);
  assert.equal(last.provenance?.rgbSha256, sha(pixels(5)));
  const bytes = ff(['-i', join(f.options.root, 'objects', last.sha256), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  assert.equal(sha(bytes), sha(pixels(5)));
  t.diagnostic(JSON.stringify({ measuredSourceFrames: last.provenance?.sourceFrameCount, lastOrdinal: last.provenance?.frameIndex, lastPts: last.provenance?.pts, timeBase: last.provenance?.timeBase, lastRgbSha256: last.provenance?.rgbSha256, lastPngSha256: last.sha256 }));
  assert.equal((await store.inspect({ projectId, assetId: source.id })).sourceSha256, source.sha256);
  assert.deepEqual(await readdir(join(f.options.root, 'staging')), []);
});

test('prepared images keep independent original/prepared identities and explicit endpoint roles', async t => {
  const f = await fixture(t); const store = await createMediaStore(f.options); const original = await readFile(f.image);
  const source = await store.importLocal({ projectId, assetId: id(), filePath: f.image, filename: 'source.png', origin: 'imported' });
  assert.equal(typeof store.prepareImage, 'function', 'owned preparation required');
  const input = { projectId, assetId: id(), sourceAssetId: source.id, role: 'last_frame' as const, profile: { kind: 'fit-png-v1' as const, width: 96, height: 96, fit: 'contain' as const, background: 'black' as const } };
  const pending = store.prepareImage(input); input.profile.width = 128;
  const prepared = await pending;
  assert.equal(prepared.width, 96); assert.equal(prepared.height, 96);
  assert.equal(prepared.provenance?.sourceSha256, sha(original)); assert.equal(prepared.provenance?.sourceAssetId, source.id);
  assert.equal(prepared.provenance?.role, 'last_frame');
  assert.equal(prepared.provenance?.preparedSha256, prepared.sha256); assert.notEqual(prepared.sha256, source.sha256);
  assert.equal(sha(await readFile(join(f.options.root, 'objects', source.sha256))), sha(original));
  await assert.rejects(store.prepareImage({ ...input, assetId: id(), profile: { ...input.profile, width: -1 } }), /INVALID_IMAGE_PROFILE/);
  assert.equal((await readdir(join(f.options.root, 'records'))).length, 2);
});
