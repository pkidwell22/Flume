import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { createCommandService } from '../src/index.ts';
import { projectReferenceReceipt, referenceReceiptSchema, type ReferenceProvenanceRow } from '../src/reference-provenance.ts';

// Synthetic fixtures only. No PostgreSQL, no owned media, no provider.
const projectId = '7f0d0a58-0000-4000-8000-000000000001';
const otherProjectId = '7f0d0a58-0000-4000-8000-000000000009';
const shotId = '7f0d0a58-0000-4000-8000-000000000002';
const attemptId = '7f0d0a58-0000-4000-8000-000000000003';
const reviewId = '7f0d0a58-0000-4000-8000-000000000004';
const firstAsset = '7f0d0a58-0000-4000-8000-000000000005';
const lastAsset = '7f0d0a58-0000-4000-8000-000000000006';
const firstSha = 'a'.repeat(64), lastSha = 'b'.repeat(64), requestHash = 'c'.repeat(64);
const actor = { id: '11111111-1111-4111-8111-111111111111', kind: 'operator' as const, projectIds: '*' as const };

function row(snapshot: unknown, overrides: Record<string, unknown> = {}): ReferenceProvenanceRow {
  return {
    attempt_id: attemptId, attempt_project_id: projectId, attempt_shot_id: shotId, attempt_shot_revision: 3,
    review_id: reviewId, review_id_row: reviewId, review_project_id: projectId, review_shot_id: shotId, review_shot_revision: 3,
    request_hash: requestHash, recorded_at: new Date('2026-05-01T10:00:00.000Z'), snapshot, ...overrides,
  } as ReferenceProvenanceRow;
}
function bound(bindings: Record<string, unknown>, assets?: unknown) {
  return { projectId, shotId, shotRevision: 3, prompt: 'Direction', controls: {}, bindings, ...(assets === undefined ? {} : { assets }) };
}
const both = (first: string | null, last: string | null) => ({ firstFrameAssetId: first, lastFrameAssetId: last });
const frozen = (...entries: Array<{ id: string; sha256: string }>) => entries;
function fakePool(rows: unknown[], seen: Array<{ sql: string; params: unknown[] }> = []) {
  const pool = { query: async (sql: string, params?: unknown[]) => { seen.push({ sql, params: params ?? [] }); return { rows, rowCount: rows.length }; } };
  return { pool: pool as unknown as Pool, seen };
}

test('a reference replaced after submit keeps the earlier identity and frozen digest', async () => {
  const snapshot = bound(both(firstAsset, lastAsset), frozen({ id: firstAsset, sha256: firstSha }, { id: lastAsset, sha256: lastSha }));
  const receipt = projectReferenceReceipt(row(snapshot));
  assert.equal(receipt.status, 'recorded');
  assert.deepEqual(receipt.references, [
    { role: 'first_frame', assetId: firstAsset, sha256: firstSha },
    { role: 'last_frame', assetId: lastAsset, sha256: lastSha },
  ]);
  assert.equal(receipt.attemptId, attemptId);
  assert.equal(receipt.reviewId, reviewId);
  assert.equal(receipt.projectId, projectId);
  assert.equal(receipt.shotId, shotId);
  assert.equal(receipt.shotRevision, 3);
  assert.equal(receipt.requestHash, requestHash);
  assert.equal(receipt.recordedAt, '2026-05-01T10:00:00.000Z');
});

test('the read is one authorized SELECT that never consults current shots, assets or writes', async () => {
  const snapshot = bound(both(firstAsset, null), frozen({ id: firstAsset, sha256: firstSha }));
  const { pool, seen } = fakePool([row(snapshot)]);
  const service = createCommandService({ pool });
  const receipt = await service.readReferenceProvenance(actor, { projectId, attemptId });
  assert.equal(receipt.status, 'recorded');
  assert.equal(seen.length, 1, 'exactly one statement');
  const [{ sql, params }] = seen;
  assert.match(sql, /^\s*SELECT/i);
  assert.match(sql, /a\.id\s*=\s*\$1/);
  assert.match(sql, /a\.project_id\s*=\s*\$2/);
  assert.match(sql, /r\.project_id\s*=\s*\$2/, 'the joined review is constrained by the same project scope');
  assert.doesNotMatch(sql, /insert|update|delete|for\s+update|lock/i, 'no write, lock or migration');
  assert.doesNotMatch(sql, /flume\.assets|flume\.shots/, 'no current-state backfill');
  assert.deepEqual(params, [attemptId, projectId]);
});

test('authorization runs before the lookup, so an unwelcome project reads nothing', async () => {
  const { pool, seen } = fakePool([row(bound(both(null, null)))]);
  const service = createCommandService({ pool });
  const scoped = { id: actor.id, kind: 'operator' as const, projectIds: [otherProjectId] };
  await assert.rejects(service.readReferenceProvenance(scoped, { projectId, attemptId }), { code: 'FORBIDDEN', status: 403 });
  assert.equal(seen.length, 0, 'no statement reached the store');
});

test('an absent or cross-project attempt is a typed not-found without snapshot content', async () => {
  const { pool } = fakePool([]);
  const service = createCommandService({ pool });
  await assert.rejects(service.readReferenceProvenance(actor, { projectId, attemptId }), (error: any) => {
    assert.equal(error.code, 'PROVENANCE_NOT_FOUND');
    assert.equal(error.status, 404);
    assert.doesNotMatch(error.message, /snapshot|envelope|sha256|project/i);
    return true;
  });
});

test('malformed identifiers are rejected before any read', async () => {
  const { pool, seen } = fakePool([row(bound(both(null, null)))]);
  const service = createCommandService({ pool });
  await assert.rejects(service.readReferenceProvenance(actor, { projectId: 'not-a-uuid', attemptId }), { name: 'ZodError' });
  await assert.rejects(service.readReferenceProvenance(actor, { projectId, attemptId: 'attempt' }), { name: 'ZodError' });
  assert.equal(seen.length, 0);
});

test('the same asset in two roles keeps both roles and one frozen digest', async () => {
  // The frozen binding preserves the caller's UUID alias casing; it must match case-insensitively.
  const snapshot = bound(both(firstAsset, firstAsset.toUpperCase()), frozen({ id: firstAsset, sha256: firstSha }));
  const receipt = projectReferenceReceipt(row(snapshot));
  assert.equal(receipt.status, 'recorded');
  assert.deepEqual(receipt.references, [
    { role: 'first_frame', assetId: firstAsset, sha256: firstSha },
    { role: 'last_frame', assetId: firstAsset.toUpperCase(), sha256: firstSha },
  ]);
});

test('two null bindings are recorded with no references, not unknown', async () => {
  const receipt = projectReferenceReceipt(row(bound(both(null, null))));
  assert.equal(receipt.status, 'recorded');
  assert.deepEqual(receipt.references, []);
});

test('non-null bindings without a frozen digest stay partial with a null digest', async () => {
  const receipt = projectReferenceReceipt(row(bound(both(firstAsset, lastAsset))));
  assert.equal(receipt.status, 'partial');
  assert.deepEqual(receipt.references, [
    { role: 'first_frame', assetId: firstAsset, sha256: null },
    { role: 'last_frame', assetId: lastAsset, sha256: null },
  ]);
  const emptyAssets = projectReferenceReceipt(row(bound(both(firstAsset, null), [])));
  assert.equal(emptyAssets.status, 'partial');
  assert.deepEqual(emptyAssets.references, [{ role: 'first_frame', assetId: firstAsset, sha256: null }]);
});

test('a snapshot with no usable binding information is unknown, never "no references"', async () => {
  assert.deepEqual(projectReferenceReceipt(row({})).status, 'unknown');
  assert.deepEqual(projectReferenceReceipt(row({})).references, []);
  assert.equal(projectReferenceReceipt(row({ projectId, shotId })).status, 'unknown');
  assert.equal(projectReferenceReceipt(row(null)).status, 'unknown');
  assert.equal(projectReferenceReceipt(row('legacy')).status, 'unknown');
  // One key alone cannot assert the recorded pair; it is defensible but partial.
  assert.equal(projectReferenceReceipt(row({ bindings: { firstFrameAssetId: null } })).status, 'partial');
});

test('malformed, invalid and conflicting entries never produce a recorded assertion', async () => {
  const junk = projectReferenceReceipt(row(bound({ firstFrameAssetId: 'frame-one.jpg', lastFrameAssetId: null })));
  assert.equal(junk.status, 'partial');
  assert.deepEqual(junk.references, [{ role: 'first_frame', assetId: null, sha256: null }], 'junk is never exposed as an id');

  const badDigest = projectReferenceReceipt(row(bound(both(firstAsset, null), [{ id: firstAsset, sha256: 'SHA256' }])));
  assert.equal(badDigest.status, 'partial');
  assert.deepEqual(badDigest.references, [{ role: 'first_frame', assetId: firstAsset, sha256: null }]);

  const conflict = projectReferenceReceipt(row(bound(both(firstAsset, lastAsset), [
    { id: firstAsset, sha256: firstSha }, { id: firstAsset.toUpperCase(), sha256: lastSha }, { id: lastAsset, sha256: lastSha },
  ])));
  assert.equal(conflict.status, 'partial', 'a disputed digest is not a recorded one');
  assert.deepEqual(conflict.references, [
    { role: 'first_frame', assetId: firstAsset, sha256: null },
    { role: 'last_frame', assetId: lastAsset, sha256: lastSha },
  ]);

  const agree = projectReferenceReceipt(row(bound(both(firstAsset, null), [
    { id: firstAsset, sha256: firstSha }, { id: firstAsset.toUpperCase(), sha256: firstSha },
  ])));
  assert.equal(agree.status, 'recorded');
  assert.deepEqual(agree.references, [{ role: 'first_frame', assetId: firstAsset, sha256: firstSha }]);
});

test('a mismatched authoritative row fails closed with a bounded error', async () => {
  const snapshot = bound(both(firstAsset, null), frozen({ id: firstAsset, sha256: firstSha }));
  for (const mismatched of [{ review_shot_id: '7f0d0a58-0000-4000-8000-0000000000ff' }, { review_project_id: otherProjectId }, { attempt_shot_revision: 2 }, { review_id_row: '7f0d0a58-0000-4000-8000-0000000000fe' }]) {
    const { pool } = fakePool([row(snapshot, mismatched)]);
    const service = createCommandService({ pool });
    await assert.rejects(service.readReferenceProvenance(actor, { projectId, attemptId }), (error: any) => {
      assert.equal(error.code, 'PROVENANCE_INCONSISTENT');
      assert.equal(error.status, 409);
      assert.doesNotMatch(error.message, /json|snapshot|sha256|[0-9a-f]{64}/i, 'no record content in the error');
      return true;
    });
  }
});

test('the receipt carries only identity, role, digest and revision — no provider or storage material', async () => {
  const snapshot = {
    ...bound(both(firstAsset, lastAsset), frozen({ id: firstAsset, sha256: firstSha }, { id: lastAsset, sha256: lastSha })),
    estimate: { provider: 'acme', modelId: 'acme/video-1', estimatedCostUsd: '0.10', bodySha256: firstSha },
    envelope: { provider: 'acme', modelId: 'acme/video-1', body: '{"secret":"provider-payload"}', bodySha256: firstSha },
    storageKey: 'owned/secret/path.mp4', mediaUrl: 'https://provider.invalid/signed?token=abc',
  };
  const receipt = projectReferenceReceipt(row(snapshot));
  assert.deepEqual(Object.keys(receipt).sort(), ['attemptId', 'projectId', 'recordedAt', 'references', 'requestHash', 'reviewId', 'shotId', 'shotRevision', 'status']);
  assert.deepEqual(Object.keys(receipt.references[0]!).sort(), ['assetId', 'role', 'sha256']);
  const serialized = JSON.stringify(receipt);
  for (const forbidden of ['provider-payload', 'storageKey', 'mediaUrl', 'provider.invalid', 'token', 'bodySha256', 'envelope']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(referenceReceiptSchema.safeParse({ ...receipt, envelope: {} }).success, false, 'the view schema is strict');
  assert.equal(referenceReceiptSchema.safeParse(receipt).success, true);
});
