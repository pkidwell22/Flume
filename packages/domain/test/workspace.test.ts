import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as domain from '../src/index.js';

const controls = { modelId: 'not-entitled/model', durationSeconds: 0, resolution: 'unsupported', aspectRatio: '2:1', generateAudio: false, seed: 0 };
const bindings = { firstFrameAssetId: '00000007-0000-4000-8000-000000000007', lastFrameAssetId: '00000008-0000-4000-8000-000000000008' };
const workspace = {
  project: { id: '00000001-0000-4000-8000-000000000001', name: 'A film', brief: '', revision: 0 },
  shots: [{ id: '00000002-0000-4000-8000-000000000002', projectId: '00000001-0000-4000-8000-000000000001', title: '', prompt: '  preserve  ', revision: 2, controls, bindings, selectedTakeId: null, selectionRevision: 0 }],
  assets: [{ id: '00000007-0000-4000-8000-000000000007', projectId: '00000001-0000-4000-8000-000000000001', filename: 'start.png', kind: 'image', origin: 'sample', sha256: 'a'.repeat(64), mediaUrl: '/api/media/start', width: 10, height: 10, provenance: { source: 'synthetic sample' } }],
  takes: [{ id: '00000005-0000-4000-8000-000000000005', projectId: '00000001-0000-4000-8000-000000000001', shotId: '00000002-0000-4000-8000-000000000002', attemptId: '00000004-0000-4000-8000-000000000004', assetId: '00000009-0000-4000-8000-000000000009', createdAt: '2026-10-17T12:00:00Z' }],
  attempts: [{ id: '00000004-0000-4000-8000-000000000004', projectId: '00000001-0000-4000-8000-000000000001', shotId: '00000002-0000-4000-8000-000000000002', shotRevision: 2, status: 'acceptance_unknown', providerJobId: null, errorCode: 'acceptance_unknown', message: 'Do not resubmit' }],
  reviews: [{ id: '00000003-0000-4000-8000-000000000003', projectId: '00000001-0000-4000-8000-000000000001', shotId: '00000002-0000-4000-8000-000000000002', shotRevision: 2, requestHash: 'b'.repeat(64), prompt: '  preserve  ', controls, bindings, estimatedCostUsd: null, blockers: [{ code: 'privacy_policy', message: 'This route is blocked' }], approved: false }],
  exports: [{ id: '0000000a-0000-4000-8000-00000000000a', projectId: '00000001-0000-4000-8000-000000000001', shotId: '00000002-0000-4000-8000-000000000002', takeId: '00000005-0000-4000-8000-000000000005', shotRevision: 2, selectionRevision: 0, status: 'queued', assetId: null, stale: true }],
  capabilities: [{ modelId: 'not-entitled/model', name: 'Model', durations: [5], resolutions: ['2K'], frameRoles: ['first', 'last'], seedSupported: false, availability: 'blocked', blocker: 'Account privacy' }],
};

test('canonical public workspace validates truthful blocked/unknown states without altering draft intent', () => {
  assert.ok('WorkspaceSchema' in domain, 'public workspace schema is exported');
  const schema = (domain as any).WorkspaceSchema;
  assert.deepEqual(schema.parse(workspace), workspace);
  for (const extra of [{ leaseVersion: 2 }, { workerId: 'private' }]) {
    assert.equal(schema.safeParse({ ...workspace, attempts: [{ ...workspace.attempts[0], ...extra }] }).success, false);
  }
  assert.equal(schema.safeParse({ ...workspace, reviews: [{ ...workspace.reviews[0], providerEnvelope: { token: 'not-public' } }] }).success, false);
  assert.equal(schema.safeParse({ ...workspace, assets: [{ ...workspace.assets[0], origin: 'live' }] }).success, false);
  assert.equal(schema.safeParse({ ...workspace, shots: [{ ...workspace.shots[0], selectionRevision: -1 }] }).success, false);
});

test('empty workspaces are complete, fresh and need no fabricated project or fixture key', () => {
  assert.ok('emptyWorkspace' in domain);
  const empty = (domain as any).emptyWorkspace();
  assert.deepEqual(empty, { project: null, shots: [], assets: [], takes: [], attempts: [], reviews: [], exports: [], capabilities: [] });
  assert.deepEqual((domain as any).WorkspaceSchema.parse(empty), empty);
  (empty as domain.Workspace).shots.push(workspace.shots[0]!);
  assert.deepEqual((domain as any).emptyWorkspace().shots, []);
});

test('receipts and errors carry exact command identity and revision conflict details', () => {
  assert.ok('CommandReceiptSchema' in domain);
  assert.ok('ApiErrorSchema' in domain);
  const receipt = { commandId: '42B3DC54-6022-473E-94F2-2417A5AE42E4', projectId: '00000001-0000-4000-8000-000000000001', resourceId: '0000000b-0000-4000-8000-00000000000b', revision: 0 };
  assert.deepEqual((domain as any).CommandReceiptSchema.parse(receipt), receipt);
  const error = { code: 'revision_conflict', message: 'Reload before editing', currentRevision: 3, details: { field: 'revision' } };
  assert.deepEqual((domain as any).ApiErrorSchema.parse(error), error);
});
