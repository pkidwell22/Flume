import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as media from '../src/index.ts';
import { fixture, projectId, sha } from './support.ts';

test('owned provider-output import is idempotent by exact remote identity, not by a URL or filename', async t => {
  const f = await fixture(t); const store = await media.createMediaStore(f.options); const bytes = await readFile(f.video);
  const request = { projectId, filename: 'output.mkv', remoteIdentity: { provider: 'test-fixture', jobId: 'synthetic-job', outputId: 'output-0' } };
  assert.equal(typeof store.importGeneratedOutput, 'function', 'owned generated-output port required');
  const one = await store.importGeneratedOutput(request, (async function* () { yield bytes; })());
  const two = await store.importGeneratedOutput(request, (async function* () { yield bytes; })());
  assert.equal(one.id, two.id); assert.equal(one.sha256, sha(bytes));
  assert.equal(one.origin, 'generated', 'synthetic test of provenance label, not live provider evidence');
  assert.equal(one.id, media.generatedAssetId(projectId, request.remoteIdentity));
  assert.equal(one.provenance?.kind, 'provider-output');
  assert.ok(!JSON.stringify(one).includes('synthetic-job'), 'public asset carries identity hash, not private receipt');
  assert.equal((await readdir(join(f.options.root, 'records'))).length, 1);
  const other = { ...request, remoteIdentity: { ...request.remoteIdentity, outputId: 'output-1' } };
  assert.notEqual(media.generatedAssetId(projectId, other.remoteIdentity), one.id);
  await assert.rejects(store.importGeneratedOutput({ ...request, filename: 'changed.mkv' }, (async function* () { yield bytes; })()), /ASSET_ID_CONFLICT/);
  assert.equal((await readdir(join(f.options.root, 'records'))).length, 1);
});

test('retrieval replays already-owned identities without refetch and rejects untrusted media URLs', async t => {
  const f = await fixture(t); const store = await media.createMediaStore({ ...f.options, downloadPolicy: { allowedHosts: ['media.example.com'] } });
  const bytes = await readFile(f.video);
  const request = { projectId, filename: 'output.mkv', remoteIdentity: { provider: 'test-fixture', jobId: 'synthetic-retrieval', outputId: '0' } };
  const owned = await store.importGeneratedOutput(request, (async function* () { yield bytes; })());
  assert.equal(typeof store.retrieveGeneratedOutput, 'function', 'safe retrieval adapter required');
  assert.equal((await store.retrieveGeneratedOutput({ ...request, url: 'https://expired.invalid/object' })).id, owned.id);
  await assert.rejects(store.retrieveGeneratedOutput({ ...request, remoteIdentity: { ...request.remoteIdentity, outputId: '1' }, url: 'https://127.0.0.1/private' }), /REMOTE_URL_REJECTED/);
  assert.equal((await readdir(join(f.options.root, 'records'))).length, 1);
  assert.deepEqual(await readdir(join(f.options.root, 'staging')), []);
});
