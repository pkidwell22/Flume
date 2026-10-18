import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import * as media from '../src/index.ts';
import { ff, FFMPEG, FFPROBE, sha } from './support.ts';

// Native UUIDs with hex letters ensure case aliases are genuinely different strings.
function letterUuid() {
  for (;;) { const value = randomUUID(); if (/[a-f]/.test(value)) return value; }
}
const chunks = async function* (bytes: Uint8Array) { yield bytes; };
const remoteIdentity = { provider: 'fixture-case', jobId: 'Job-AbC-123', outputId: 'Output-XyZ-0' };
async function ownedFixture(t: TestContext) {
  assert.ok(process.env.TMPDIR, 'explicit isolated TMPDIR required');
  const dir = await mkdtemp(join(await realpath(process.env.TMPDIR), 'media-identity-fixture-'));
  // Register cleanup before acquiring the next resource; never remove another test's store.
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await assert.rejects(lstat(dir), { code: 'ENOENT' });
    t.diagnostic(JSON.stringify({ cleanup: dir, removed: true }));
  });
  const inputs = join(dir, 'inputs'); await mkdir(inputs);
  const video = join(inputs, 'source.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=6:duration=1', '-frames:v', '6', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video]);
  const options = { root: join(dir, 'store'), importRoots: [inputs], ffmpegPath: FFMPEG, ffprobePath: FFPROBE };
  return { dir, inputs, video, options, bytes: await readFile(video) };
}
async function immutableRecord(root: string, asset: media.Asset) {
  const path = join(root, 'records', `${asset.id.toLowerCase()}.json`);
  const stat = await lstat(path, { bigint: true });
  return { path, bytes: await readFile(path), object: await readFile(join(root, 'objects', asset.sha256)),
    identity: { ino: stat.ino, dev: stat.dev, mtimeNs: stat.mtimeNs, mode: stat.mode } };
}
async function assertUnchanged(t: TestContext, root: string, before: Awaited<ReturnType<typeof immutableRecord>>, asset: media.Asset) {
  const after = await immutableRecord(root, asset);
  assert.deepEqual(after.bytes, before.bytes, 'immutable manifest bytes must not change');
  assert.deepEqual(after.identity, before.identity, 'do not replace or rewrite an identical manifest');
  assert.deepEqual(after.object, before.object, 'CAS object bytes must not change');
  assert.deepEqual(JSON.parse(after.bytes.toString()).asset, asset, 'return the exact persisted asset');
  assert.deepEqual(await readdir(join(root, 'staging')), []);
  await assert.rejects(lstat(join(root, '.active-operation')), { code: 'ENOENT' });
  t.diagnostic(JSON.stringify({ projectId: asset.projectId, assetId: asset.id,
    manifestSha256Before: sha(before.bytes), manifestSha256After: sha(after.bytes),
    objectSha256Before: sha(before.object), objectSha256After: sha(after.object) }));
}

test('uppercase local asset UUID aliases replay the original literal manifest and media URL', async t => {
  const f = await ownedFixture(t); const store = await media.createMediaStore(f.options);
  const projectId = letterUuid().toUpperCase(), assetId = letterUuid().toUpperCase();
  const request = { projectId, assetId, filename: 'source.mp4', origin: 'sample' as const };
  const first = await store.importLocal({ ...request, filePath: f.video });
  assert.equal(first.id, assetId); assert.equal(first.projectId, projectId);
  assert.equal(first.mediaUrl, `/api/media/${assetId}`);
  const before = await immutableRecord(f.options.root, first);
  const alias = { ...request, assetId: assetId.toLowerCase(), projectId: projectId.toLowerCase() };
  assert.deepEqual(await store.importStream(alias, chunks(f.bytes)), first);
  const opened = await store.openAsset(alias);
  try { assert.deepEqual(opened.asset, first); assert.equal(sha(await opened.file.readFile()), first.sha256); }
  finally { await opened.file.close(); }
  await assert.rejects(store.importStream({ ...alias, filename: 'changed.mp4' }, chunks(f.bytes)), /ASSET_ID_CONFLICT/);
  const frameRequest = { projectId, assetId: letterUuid().toUpperCase(), sourceAssetId: assetId, frame: 'last' as const };
  const frame = await store.extractFrame(frameRequest);
  const frameBefore = await immutableRecord(f.options.root, frame);
  assert.deepEqual(await store.extractFrame({ ...frameRequest, assetId: frame.id.toLowerCase(), projectId: projectId.toLowerCase(), sourceAssetId: assetId.toLowerCase() }), frame);
  await assertUnchanged(t, f.options.root, frameBefore, frame);
  const prepare = { projectId, assetId: letterUuid().toUpperCase(), sourceAssetId: frame.id, role: 'last_frame' as const,
    profile: { kind: 'fit-png-v1' as const, width: 32, height: 24, fit: 'contain' as const, background: 'black' as const } };
  const prepared = await store.prepareImage(prepare);
  const preparedBefore = await immutableRecord(f.options.root, prepared);
  assert.deepEqual(await store.prepareImage({ ...prepare, projectId: projectId.toLowerCase(), assetId: prepared.id.toLowerCase(), sourceAssetId: frame.id.toLowerCase() }), prepared);
  await assertUnchanged(t, f.options.root, preparedBefore, prepared);
  await assertUnchanged(t, f.options.root, before, first);
});

test('frozen take UUID case aliases are not stale and preserve literal snapshot hashes', async t => {
  const f = await ownedFixture(t); const store = await media.createMediaStore(f.options);
  const projectId = letterUuid().toUpperCase(), takeId = letterUuid();
  const source = await store.importLocal({ projectId, assetId: letterUuid().toUpperCase(), filename: 'source.mp4', origin: 'sample', filePath: f.video });
  const selection: media.ExportSelection = { exportId: letterUuid().toUpperCase(), assetId: letterUuid().toUpperCase(), projectId,
    shotId: letterUuid().toUpperCase(), takeId, sourceAssetId: source.id, sourceSha256: source.sha256,
    shotRevision: 3, selectionRevision: 2, profile: 'mp4-copy-v1' };
  const lower = media.freezeExportSelection(selection);
  const upper = media.freezeExportSelection({ ...selection, takeId: takeId.toUpperCase() });
  const current = { shotRevision: 3, selectionRevision: 2, selectedTakeId: takeId };
  assert.equal(media.isExportStale(lower, { ...current, selectedTakeId: takeId.toUpperCase() }), false);
  assert.equal(media.isExportStale(upper, current), false);
  for (const frozen of [lower, upper]) {
    const literal = JSON.stringify(frozen), expected = sha(JSON.stringify({ version: 1, selection: frozen.selection }));
    assert.equal(frozen.snapshotSha256, expected);
    assert.equal(media.isExportStale(frozen, { ...current, selectedTakeId: takeId.slice(0, 18).toUpperCase() + takeId.slice(18) }), false);
    for (const changed of [{ ...current, selectedTakeId: letterUuid() }, { ...current, selectedTakeId: null },
      { ...current, shotRevision: 4 }, { ...current, selectionRevision: 3 }]) assert.equal(media.isExportStale(frozen, changed), true);
    assert.equal(JSON.stringify(frozen), literal);
    t.diagnostic(JSON.stringify({ takeId: frozen.selection.takeId, snapshotSha256Before: expected, snapshotSha256After: frozen.snapshotSha256 }));
  }
  assert.notEqual(lower.snapshotSha256, upper.snapshotSha256, 'literal historical spellings retain distinct hashes');
  const tampered = structuredClone(upper); tampered.selection.takeId = takeId;
  assert.throws(() => media.isExportStale(tampered, current), /SNAPSHOT_HASH_MISMATCH/);
  const output = await store.exportSelected(upper);
  const before = await immutableRecord(f.options.root, output);
  assert.equal(output.provenance?.snapshotSha256, upper.snapshotSha256);
  assert.deepEqual(output.provenance?.selection, upper.selection);
  assert.deepEqual(await store.exportSelected(structuredClone(upper)), output);
  await assert.rejects(store.exportSelected(tampered), /SNAPSHOT_HASH_MISMATCH/);
  await assert.rejects(store.exportSelected(lower), /ASSET_ID_CONFLICT/, 'a newly frozen literal snapshot cannot replace existing frozen evidence');
  await assertUnchanged(t, f.options.root, before, output);
});

test('staleness comparison rejects malformed current take IDs before comparison', () => {
  const takeId = letterUuid();
  const frozen = media.freezeExportSelection({ exportId: letterUuid(), assetId: letterUuid(), projectId: letterUuid(), shotId: letterUuid(), takeId,
    sourceAssetId: letterUuid(), sourceSha256: 'a'.repeat(64), shotRevision: 3, selectionRevision: 2, profile: 'mp4-copy-v1' });
  for (const selectedTakeId of [` ${takeId}`, `${takeId} `, `${takeId}\n`, `{${takeId}}`, takeId.replaceAll('-', ''), 'not-a-uuid', 42, undefined]) {
    for (const shotRevision of [3, 4]) {
      assert.throws(() => media.isExportStale(frozen, { shotRevision, selectionRevision: 2, selectedTakeId: selectedTakeId as string }), /INVALID_ID/);
    }
  }
});

test('uppercase generated manifests remain replayable without normalizing opaque UUID-shaped IDs', async t => {
  const f = await ownedFixture(t); const store = await media.createMediaStore(f.options);
  const projectId = letterUuid().toUpperCase();
  const identity = { provider: 'fixture-case', jobId: letterUuid().toUpperCase(), outputId: letterUuid().toUpperCase() };
  const request = { projectId, filename: 'source.mp4', remoteIdentity: identity };
  const first = await store.importGeneratedOutput(request, chunks(f.bytes));
  assert.equal(first.projectId, projectId, 'first publication retains literal uppercase history');
  const before = await immutableRecord(f.options.root, first);
  const reopened = await media.createMediaStore(f.options);
  assert.deepEqual(await reopened.importGeneratedOutput({ ...request, projectId: projectId.toLowerCase() }, chunks(f.bytes)), first);
  assert.deepEqual(await reopened.retrieveGeneratedOutput({ ...request, projectId: projectId.toLowerCase(), url: 'invalid-url:owned-replay' }), first);
  assert.equal(first.provenance?.remoteIdentitySha256, sha(JSON.stringify([projectId.toLowerCase(), identity.provider, identity.jobId, identity.outputId])));
  const ids = new Set([first.id]);
  for (const changed of [{ ...identity, jobId: identity.jobId.toLowerCase() }, { ...identity, outputId: identity.outputId.toLowerCase() },
    { ...identity, provider: 'fixture-other' }, { ...identity, jobId: ` ${identity.jobId}` }, { ...identity, outputId: `${identity.outputId} ` }]) {
    const other = await reopened.importGeneratedOutput({ ...request, remoteIdentity: changed }, chunks(f.bytes));
    assert.ok(!ids.has(other.id), 'opaque identifier change must create a different remote identity'); ids.add(other.id);
    assert.equal(other.provenance?.remoteIdentitySha256, sha(JSON.stringify([projectId.toLowerCase(), changed.provider, changed.jobId, changed.outputId])));
  }
  assert.throws(() => media.generatedAssetId(projectId, { ...identity, provider: identity.provider.toUpperCase() }), /INVALID_PROVIDER/, 'invalid provider case is rejected, not folded');
  await assert.rejects(reopened.importGeneratedOutput({ ...request, filename: 'other.mp4' }, chunks(f.bytes)), /ASSET_ID_CONFLICT/);
  await assert.rejects(reopened.importGeneratedOutput({ ...request, filename: 'SOURCE.MP4' }, chunks(f.bytes)), /ASSET_ID_CONFLICT/, 'non-UUID fields remain case-sensitive');
  const changedVideo = join(f.inputs, 'changed.mp4');
  ff(['-f', 'lavfi', '-i', 'color=red:size=64x48:rate=6:duration=1', '-frames:v', '6', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', changedVideo]);
  const differentBytes = await readFile(changedVideo); assert.notEqual(sha(differentBytes), first.sha256);
  await assert.rejects(reopened.importGeneratedOutput(request, chunks(differentBytes)), /ASSET_ID_CONFLICT/);
  assert.equal((await readdir(join(f.options.root, 'records'))).length, ids.size);
  await assertUnchanged(t, f.options.root, before, first);
});

test('malformed UUID inputs are rejected without consuming bytes or repairing identity', async t => {
  const f = await ownedFixture(t); const store = await media.createMediaStore(f.options);
  const projectId = letterUuid(), assetId = letterUuid();
  const selection: media.ExportSelection = { exportId: letterUuid(), assetId, projectId, shotId: letterUuid(), takeId: letterUuid(), sourceAssetId: letterUuid(),
    sourceSha256: sha(f.bytes), shotRevision: 3, selectionRevision: 2, profile: 'mp4-copy-v1' };
  for (const bad of [` ${projectId}`, `${projectId} `, `${projectId}\n`, `${projectId}\r`, `\t${projectId}`, `{${projectId}}`, projectId.replaceAll('-', ''), 'not-a-uuid', null, 42, undefined]) {
    const invalid = bad as string;
    assert.throws(() => media.generatedAssetId(invalid, remoteIdentity), /INVALID_ID/);
    let consumed = false; const untouched = async function* () { consumed = true; yield f.bytes; };
    await assert.rejects(store.importGeneratedOutput({ projectId: invalid, filename: 'source.mp4', remoteIdentity }, untouched()), /INVALID_ID/);
    await assert.rejects(store.retrieveGeneratedOutput({ projectId: invalid, filename: 'source.mp4', remoteIdentity, url: 'not-a-url' }), /INVALID_ID/);
    for (const ref of [{ projectId: invalid, assetId }, { projectId, assetId: invalid }]) {
      await assert.rejects(store.importStream({ ...ref, filename: 'source.mp4', origin: 'sample' }, untouched()), /INVALID_ID/);
      await assert.rejects(store.openAsset(ref), /INVALID_ID/);
    }
    for (const key of ['assetId', 'exportId', 'projectId', 'shotId', 'takeId', 'sourceAssetId'] as const) {
      assert.throws(() => media.freezeExportSelection({ ...selection, [key]: invalid }), /INVALID_ID/);
    }
    assert.equal(consumed, false, 'reject invalid identity before reading media');
  }
  assert.deepEqual(await readdir(join(f.options.root, 'records')), []);
  assert.deepEqual(await readdir(join(f.options.root, 'objects')), []);
  assert.deepEqual(await readdir(join(f.options.root, 'staging')), []);
  await assert.rejects(lstat(join(f.options.root, '.active-operation')), { code: 'ENOENT' });
});

test('generated lower-to-upper project UUID replay returns exact persisted identity', async t => {
  const f = await ownedFixture(t); const store = await media.createMediaStore(f.options);
  const projectId = letterUuid(); const request = { projectId, filename: 'source.mp4', remoteIdentity };
  const first = await store.importGeneratedOutput(request, chunks(f.bytes));
  const before = await immutableRecord(f.options.root, first);
  assert.equal(first.projectId, projectId);
  assert.equal(media.generatedAssetId(projectId.toUpperCase(), remoteIdentity), first.id);
  const replay = await store.importGeneratedOutput({ ...request, projectId: projectId.toUpperCase() }, chunks(f.bytes));
  assert.deepEqual(replay, first, 'case alias must return the original literal asset, not a canonical rewrite');
  const reopened = await media.createMediaStore(f.options);
  const retrieved = await reopened.retrieveGeneratedOutput({ ...request, projectId: projectId.toUpperCase(), url: 'not-a-url:already-owned' });
  assert.deepEqual(retrieved, first, 'owned replay must not try network retrieval');
  assert.deepEqual(await readdir(join(f.options.root, 'records')), [`${first.id}.json`]);
  await assertUnchanged(t, f.options.root, before, first);
});
