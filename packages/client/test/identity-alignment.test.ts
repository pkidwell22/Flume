import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as domain from '@flume/domain';
import { FlumeClient } from '../src/index.js';

const projectId = 'aabbccdd-0000-4000-8000-000000000001';
const commandId = '42B3DC54-6022-473E-94F2-2417A5AE42E4';
const reviewId = 'f3456789-1234-4234-8234-123456789abc';

test('platform UUID validation rejects malformed tokens without changing valid spelling', () => {
  const uppercase = projectId.toUpperCase();
  assert.equal(domain.IdSchema.parse(uppercase), uppercase);
  for (const invalid of ['project-1', ` ${projectId}`, `${projectId}\n`, `{${projectId}}`, projectId.replaceAll('-', ''), 42, undefined]) {
    assert.equal(domain.IdSchema.safeParse(invalid).success, false, `must reject ${JSON.stringify(invalid)}`);
  }
  const command = { type: 'generation.prepare', commandId, projectId: uppercase, shotId: reviewId, expectedRevision: 1 };
  assert.deepEqual(domain.CommandSchema.parse(command), command);
  const controls = { modelId: 'Vendor/Model-MiXeD:rev_01', durationSeconds: 0, resolution: '2K', aspectRatio: '16:9', generateAudio: false, seed: 0 };
  assert.deepEqual(domain.ControlsSchema.parse(controls), controls, 'provider/model identity and zero/false stay literal');
});

test('public approval limit accepts 100 and rejects 101 before dispatch', () => {
  const command = { type: 'generation.approve', commandId, projectId, reviewId, maxAttempts: 100, maxCostUsd: '0.00' };
  assert.equal(domain.GenerationApproveCommandSchema.safeParse({ ...command, maxAttempts: 101 }).success, false);
  assert.deepEqual(domain.GenerationApproveCommandSchema.parse(command), command);
  assert.equal((domain as unknown as Record<string, unknown>).MAX_APPROVAL_ATTEMPTS, 100);
});

test('upload UUID aliases preserve multipart spelling and return the canonical persisted asset', async () => {
  const asset = { id: 'abcdef12-0000-4000-8000-000000000002', projectId, filename: 'start.png', kind: 'image', origin: 'imported', sha256: 'a'.repeat(64), mediaUrl: '/api/media/abcdef12-0000-4000-8000-000000000002', width: 2, height: 2 };
  let calls = 0;
  const client = new FlumeClient({ fetch: async (_url, init) => {
    calls++;
    assert.ok(init?.body instanceof FormData);
    assert.equal(init.body.get('projectId'), projectId.toUpperCase(), 'caller spelling is not rewritten');
    return Response.json(asset);
  } });
  assert.deepEqual(await client.uploadAsset(projectId.toUpperCase(), new Blob(['owned fixture bytes'], { type: 'image/png' }), 'start.png'), asset);
  assert.equal(calls, 1);
  await assert.rejects(client.uploadAsset(` ${projectId}`, new Blob(['x']), 'start.png'), error => error instanceof Error && 'code' in error && error.code === 'invalid_upload');
  assert.equal(calls, 1, 'malformed identity never reaches the transport');
});
