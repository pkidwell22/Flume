import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildServer } from '../src/index.ts';
import { ServiceError } from '../src/contracts.ts';

// Fastify injection only: a stub service stands in for the store, so no PostgreSQL is involved.
const projectId = '7f0d0a58-0000-4000-8000-000000000001';
const attemptId = '7f0d0a58-0000-4000-8000-000000000003';
const shotId = '7f0d0a58-0000-4000-8000-000000000002';
const reviewId = '7f0d0a58-0000-4000-8000-000000000004';
const assetId = '7f0d0a58-0000-4000-8000-000000000005';
const receipt = {
  attemptId, reviewId, projectId, shotId, shotRevision: 3, requestHash: 'c'.repeat(64),
  recordedAt: '2026-05-01T10:00:00.000Z', status: 'recorded' as const,
  references: [{ role: 'first_frame' as const, assetId, sha256: 'a'.repeat(64) }],
};
const security = { mode: 'local-operator' as const, allowedHosts: ['127.0.0.1:4310'], allowedOrigins: ['http://127.0.0.1:4310'] };
const headers = { host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310' };
const url = (attempt = attemptId, query = `?projectId=${projectId}`) => `/api/attempts/${attempt}/provenance${query}`;

function stub(options: { receipt?: unknown; error?: Error } = {}) {
  const reads: Array<{ actor: any; input: any }> = [];
  const service = {
    health: async () => ({ ok: true, store: 'postgresql', workerAvailable: false }),
    readReferenceProvenance: async (actor: any, input: any) => {
      reads.push({ actor, input });
      if (options.error) throw options.error;
      return options.receipt ?? receipt;
    },
  };
  return { service: service as any, reads };
}

test('GET /api/attempts/:attemptId/provenance returns the recorded receipt for the authorized project', async () => {
  const { service, reads } = stub();
  const app = await buildServer({ service, security });
  try {
    const response = await app.inject({ method: 'GET', url: url(), headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), receipt);
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0]!.input, { attemptId, projectId });
    assert.equal(reads[0]!.actor.kind, 'operator', 'the existing security hook supplies the actor');
    assert.match(String(response.headers['cache-control']), /no-store/);
    for (const forbidden of ['snapshot', 'envelope', 'bodySha256', 'storageKey', 'mediaUrl']) {
      assert.equal(response.body.includes(forbidden), false, forbidden);
    }
  } finally { await app.close(); }
});

test('an absent or cross-project attempt is the same typed 404 with no record content', async () => {
  const { service } = stub({ error: new ServiceError('PROVENANCE_NOT_FOUND', 'No recorded reference history is available for this attempt.', 404) });
  const app = await buildServer({ service, security });
  try {
    const response = await app.inject({ method: 'GET', url: url(), headers });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { code: 'PROVENANCE_NOT_FOUND', message: 'No recorded reference history is available for this attempt.' });
    assert.equal(response.body.includes(projectId), false, 'the refusal does not echo project scope');
  } finally { await app.close(); }
});

test('malformed identifiers and a missing project scope are rejected before any read', async () => {
  const { service, reads } = stub();
  const app = await buildServer({ service, security });
  try {
    for (const bad of [url('not-a-uuid'), url(attemptId, ''), url(attemptId, '?projectId=nope'), url(attemptId, `?projectId=${projectId}&extra=1`)]) {
      const response = await app.inject({ method: 'GET', url: bad, headers });
      assert.equal(response.statusCode, 400, `${bad} -> ${response.body}`);
      assert.equal(response.json().code, 'INVALID_REQUEST', bad);
    }
    assert.equal(reads.length, 0, 'no lookup ran for a malformed request');
  } finally { await app.close(); }
});

test('the route is a read: no write verb is registered and failures stay in the bounded envelope', async () => {
  const { service } = stub({ error: new Error('raw store failure at flume.reviews snapshot') });
  const app = await buildServer({ service, security });
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({ method, url: url(), headers, payload: method === 'DELETE' ? undefined : {} });
      assert.ok([400, 404, 405].includes(response.statusCode), `${method} ${response.statusCode}`);
      assert.notEqual(response.statusCode, 200);
    }
    const failed = await app.inject({ method: 'GET', url: url(), headers });
    assert.equal(failed.statusCode, 500);
    assert.deepEqual(failed.json(), { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' });
    assert.equal(failed.body.includes('flume.reviews'), false, 'internal detail is not served');
  } finally { await app.close(); }
});

test('the receipt route obeys the same Host/Origin/authentication gate as every other route', async () => {
  const { service, reads } = stub();
  const app = await buildServer({ service, security });
  const guarded = await buildServer({ service, security: { ...security, mode: 'protected' } });
  try {
    assert.equal((await app.inject({ method: 'GET', url: url(), headers: { ...headers, host: 'evil.example' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: url(), headers: { ...headers, origin: 'https://evil.example' } })).statusCode, 403);
    assert.equal((await guarded.inject({ method: 'GET', url: url(), headers })).statusCode, 401);
    assert.equal(reads.length, 0, 'no unauthorized request reached the read');
  } finally { await app.close(); await guarded.close(); }
});
