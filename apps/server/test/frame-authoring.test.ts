import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FrameAuthoringError, type FrameDraftInput, type FrameReviewView} from '../src/frame-authoring.ts';
import {createSqlFrameAuthoringStore} from '../src/frame-authoring-store.ts';
import {
  AGENT, OPERATOR, OTHER_PROJECT, PROJECT, SHOT, SOURCE_ASSET, codeOf, deferred, harness,
  pngBytes, sha256, jpegBytes,
} from './frame-authoring-fixtures.ts';
import type {harness as HarnessFactory} from './frame-authoring-fixtures.ts';
type Harness = ReturnType<typeof HarnessFactory>;

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof FrameAuthoringError, `expected FrameAuthoringError, got ${String(error)}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
    return true;
  });
}
async function createReview(h: Harness, overrides: Partial<FrameDraftInput> = {}): Promise<{view: FrameReviewView; record: Awaited<ReturnType<Harness['store']['getReview']>>}> {
  const {service, draft, store} = h;
  const view = await service.createReview({actor: OPERATOR, draft: {...draft, ...overrides}});
  return {view, record: await store.getReview(PROJECT, view.reviewId)};
}
async function approvedReview(h: Harness, overrides: Partial<FrameDraftInput> = {}): Promise<FrameReviewView> {
  const {view} = await createReview(h, overrides);
  await h.service.approve({actor: OPERATOR, projectId: PROJECT, reviewId: view.reviewId});
  return view;
}

test('draft persists one immutable operator-visible review without dispatching', async () => {
  const h = harness();
  const {view, record} = await createReview(h);
  assert.ok(record);
  assert.deepEqual(Object.keys(view).sort(), ['aspectRatio', 'blockers', 'estimateUsd', 'expectedRevision', 'modelId', 'projectId', 'prompt', 'requestHash', 'reviewId', 'role', 'shotId', 'sourceAssetId', 'status'].sort());
  assert.equal(view.status, 'pending');
  assert.equal(view.estimateUsd, null, 'unknown estimate must stay null, never 0');
  assert.equal(view.prompt, h.draft.prompt);
  assert.equal(view.role, 'first_frame');
  assert.match(view.requestHash, /^[0-9a-f]{64}$/);
  assert.equal(record.requestHash, view.requestHash);
  assert.equal(record.sourceAssetId, SOURCE_ASSET);
  assert.equal(record.sourceAssetSha256, sha256(h.sourceBytes));
  assert.equal(record.envelope!.provider, 'openrouter');
  assert.equal(record.envelope!.bodySha256, sha256(record.envelope!.body));
  assert.equal(h.provider.submitCalls.length, 0);
  assert.equal(h.provider.prepareCalls.length, 1);
  assert.equal(h.store.bindingLog.length, 0, 'drafting never binds');
  assert.ok(!JSON.stringify(view).includes('reference'), 'no envelope leaks into the review DTO');

  const again = await h.service.createReview({actor: OPERATOR, draft: h.draft});
  assert.equal(again.requestHash, view.requestHash, 'review hash is deterministic');
  assert.notEqual(again.reviewId, view.reviewId);
  const estimate = await h.service.createReview({actor: OPERATOR, draft: {...h.draft, prompt: 'estimated frame'}});
  assert.equal(estimate.estimateUsd, null);
});

test('draft requires the current shot revision, project ownership and an image source asset', async () => {
  const h = harness();
  await rejects(h.service.createReview({actor: OPERATOR, draft: {...h.draft, expectedRevision: 2}}), 'REVISION_CONFLICT');
  await rejects(h.service.createReview({actor: OPERATOR, draft: {...h.draft, shotId: '00000002-0000-4000-8000-0000000000ff'}}), 'SHOT_NOT_FOUND');
  await rejects(h.service.createReview({actor: {id: OPERATOR.id, kind: 'operator', projectIds: [OTHER_PROJECT]}, draft: h.draft}), 'FORBIDDEN');
  await rejects(h.service.createReview({actor: OPERATOR, draft: {...h.draft, sourceAssetId: '00000007-0000-4000-8000-0000000000aa'}}), 'SOURCE_ASSET_NOT_FOUND');
  await rejects(h.service.createReview({actor: OPERATOR, draft: {...h.draft, sourceAssetId: '00000007-0000-4000-8000-0000000000cc'}}), 'SOURCE_ASSET_NOT_FOUND');
  await rejects(h.service.createReview({actor: OPERATOR, draft: {...h.draft, sourceUrl: 'https://example.com/x.png'}}), 'INVALID_DRAFT');

  const bytes = h.sourceBytes.slice();
  bytes[20] = (bytes[20] + 1) % 256;
  h.media.seedOwned(PROJECT, SOURCE_ASSET, bytes);
  await rejects(h.service.createReview({actor: OPERATOR, draft: h.draft}), 'SOURCE_ASSET_INTEGRITY');

  const video = '00000007-0000-4000-8000-0000000000dd';
  const videoHarness = harness();
  videoHarness.media.seedOwned(PROJECT, video, videoHarness.sourceBytes);
  await assert.rejects(videoHarness.service.createReview({actor: OPERATOR, draft: {...videoHarness.draft, sourceAssetId: video}}), error => {
    assert.equal(codeOf(error), 'SOURCE_ASSET_NOT_FOUND');
    return true;
  });
});

test('blocked capability is persisted as a reviewable blocked review that cannot be approved', async () => {
  const h = harness({provider: {capabilities: [{
    modelId: 'google/gemini-2.5-flash-image', name: 'Gemini image', aspectRatios: ['1:1'],
    availability: 'available', blocker: null,
  }]}});
  const {view} = await createReview(h);
  assert.equal(view.status, 'blocked');
  assert.deepEqual(view.blockers.map(blocker => blocker.code), ['unsupported_aspect_ratio']);
  assert.equal(view.estimateUsd, null);
  assert.equal(h.provider.submitCalls.length, 0);
  await rejects(h.service.approve({actor: OPERATOR, projectId: PROJECT, reviewId: view.reviewId}), 'REVIEW_BLOCKED');

  const unavailable = harness({provider: {capabilities: []}});
  const blocked = await createReview(unavailable);
  assert.equal(blocked.view.status, 'blocked');
  assert.deepEqual(blocked.view.blockers.map(blocker => blocker.code), ['model_unavailable']);
});

test('approval is operator-only, single-use and rejects tampered or stale reviews', async () => {
  const h = harness();
  const {view, record} = await createReview(h);
  assert.ok(record);
  await rejects(h.service.approve({actor: AGENT, projectId: PROJECT, reviewId: view.reviewId}), 'APPROVAL_REQUIRES_OPERATOR');
  await rejects(h.service.approve({actor: OPERATOR, projectId: OTHER_PROJECT, reviewId: view.reviewId}), 'REVIEW_NOT_FOUND');

  const approved = await h.service.approve({actor: OPERATOR, projectId: PROJECT, reviewId: view.reviewId});
  assert.equal(approved.status, 'approved');
  assert.equal((await h.store.getReview(PROJECT, view.reviewId))!.approvedBy, OPERATOR.id);
  assert.equal(h.provider.submitCalls.length, 0, 'approval never submits');
  await rejects(h.service.approve({actor: OPERATOR, projectId: PROJECT, reviewId: view.reviewId}), 'REVIEW_NOT_APPROVABLE');

  const tampered = await createReview(h, {prompt: 'tampered candidate'});
  h.store.tamperReview(tampered.view.reviewId, {prompt: 'mutated after review'});
  await rejects(h.service.approve({actor: OPERATOR, projectId: PROJECT, reviewId: tampered.view.reviewId}), 'REVIEW_INTEGRITY');

  const stale = await createReview(h, {expectedRevision: 3, prompt: 'stale candidate'});
  h.store.bumpShot(PROJECT, SHOT);
  await rejects(h.service.approve({actor: OPERATOR, projectId: PROJECT, reviewId: stale.view.reviewId}), 'STALE_REVIEW');
  // Approved snapshot identity is unchanged by later drafts or edits.
  assert.deepEqual((await h.store.getReview(PROJECT, record.reviewId))!.prompt, h.draft.prompt);
});

test('submit is single-flight, requires operator approval and never retries an unknown acceptance', async () => {
  const h = harness();
  const {view} = await createReview(h);
  await rejects(h.service.submit({actor: OPERATOR, projectId: PROJECT, reviewId: view.reviewId}), 'REVIEW_NOT_APPROVED');

  const gate = deferred();
  const accepted = pngBytes(64, 64);
  h.provider.submit = async envelope => {
    h.provider.submitCalls.push(envelope);
    await gate.promise;
    return {status: 'accepted', receipt: {providerModelId: envelope.modelId, providerReceiptId: 'gen-fixture-1', costUsd: '0.039'},
      image: {mimeType: 'image/png', width: 64, height: 64, sha256: sha256(accepted), bytes: accepted}};
  };
  await h.service.approve({actor: OPERATOR, projectId: PROJECT, reviewId: view.reviewId});
  const first = h.service.submit({actor: OPERATOR, projectId: PROJECT, reviewId: view.reviewId});
  await rejects(h.service.submit({actor: OPERATOR, projectId: PROJECT, reviewId: view.reviewId}), 'SUBMISSION_IN_PROGRESS');
  await rejects(h.service.submit({actor: AGENT, projectId: PROJECT, reviewId: view.reviewId}), 'SUBMISSION_REQUIRES_OPERATOR');
  gate.resolve();
  const outcome = await first;
  assert.equal(h.provider.submitCalls.length, 1);
  assert.equal(outcome.review.status, 'submitted');
  assert.equal(outcome.error, null);
  assert.deepEqual(outcome.image!.bytes, accepted);
  await rejects(h.service.submit({actor: OPERATOR, projectId: PROJECT, reviewId: view.reviewId}), 'REVIEW_ALREADY_SUBMITTED');

  const unknownHarness = harness();
  unknownHarness.provider.submit = async envelope => {
    unknownHarness.provider.submitCalls.push(envelope);
    return {status: 'acceptance_unknown', error: {code: 'provider_acceptance_unknown'}};
  };
  const unknownReview = await approvedReview(unknownHarness);
  const unknown = await unknownHarness.service.submit({actor: OPERATOR, projectId: PROJECT, reviewId: unknownReview.reviewId});
  assert.equal(unknown.review.status, 'acceptance_unknown');
  assert.equal(unknown.error!.code, 'provider_acceptance_unknown');
  assert.equal(unknownHarness.provider.submitCalls.length, 1);
  await rejects(unknownHarness.service.submit({actor: OPERATOR, projectId: PROJECT, reviewId: unknownReview.reviewId}), 'ACCEPTANCE_UNKNOWN_NO_RETRY');
  assert.equal(unknownHarness.provider.submitCalls.length, 1, 'unknown acceptance must never be resubmitted');
});

test('provider refusal is recorded safely once and cannot be resubmitted', async () => {
  const h = harness();
  h.provider.submit = async envelope => {
    h.provider.submitCalls.push(envelope);
    return {status: 'blocked', error: {code: 'provider_authentication_required', message: 'A valid server-side OpenRouter credential is not configured.'}};
  };
  const review = await approvedReview(h);
  const outcome = await h.service.submit({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId});
  assert.equal(outcome.review.status, 'failed');
  assert.equal(outcome.image, null);
  assert.equal(outcome.error!.code, 'provider_authentication_required');
  assert.ok(!JSON.stringify(outcome).includes('fixture-only-not-a-real-key'));
  await rejects(h.service.submit({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId}), 'REVIEW_NOT_APPROVED');
  assert.equal(h.provider.submitCalls.length, 1);
});

test('result import is explicit, operator-only and verifies mime, size, hash and dimensions', async () => {
  const h = harness();
  const review = await approvedReview(h);
  await rejects(h.service.importResult({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId, mimeType: 'image/png', bytes: pngBytes()}), 'REVIEW_NOT_SUBMITTED');

  const outcome = await h.service.submit({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId});
  const bytes = outcome.image!.bytes;
  await rejects(h.service.importResult({actor: AGENT, projectId: PROJECT, reviewId: review.reviewId, mimeType: 'image/png', bytes}), 'IMPORT_REQUIRES_OPERATOR');
  await rejects(h.service.importResult({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId, mimeType: 'image/jpeg', bytes}), 'RESULT_MIME_MISMATCH');
  await rejects(h.service.importResult({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId, mimeType: 'image/png', bytes: new Uint8Array([...bytes.slice(0, 30), 9])}), 'RESULT_INTEGRITY_MISMATCH');
  await rejects(h.service.importResult({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId, mimeType: 'image/gif', bytes}), 'INVALID_RESULT_IMPORT');
  assert.equal(h.media.imports.length, 0, 'failed validation must not write owned media');

  const result = await h.service.importResult({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId, mimeType: 'image/png', bytes});
  assert.deepEqual(Object.keys(result).sort(), ['assetId', 'height', 'mimeType', 'projectId', 'reviewId', 'sha256', 'width'].sort());
  assert.equal(result.reviewId, review.reviewId);
  assert.equal(result.sha256, sha256(bytes));
  assert.equal(result.width, 64);
  assert.equal(result.height, 64);
  assert.equal(h.media.imports.length, 1);
  assert.equal(h.store.bindingLog.length, 0, 'importing a result never auto-binds');
  assert.equal((await h.store.getReview(PROJECT, review.reviewId))!.status, 'result_ready');
  await rejects(h.service.importResult({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId, mimeType: 'image/png', bytes}), 'RESULT_ALREADY_IMPORTED');
  assert.equal(h.media.imports.length, 1, 'repeat import is not a second media write');
  await assert.rejects(h.service.importResult({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId, mimeType: 'image/png', bytes: new Uint8Array(13 * 1024 * 1024)}), error => {
    const code = codeOf(error);
    assert.ok(code !== undefined && ['INVALID_RESULT_IMPORT', 'RESULT_ALREADY_IMPORTED'].includes(code));
    return true;
  });
});

test('bind is explicit, role/source bound and optimistic about shot revision', async () => {
  const h = harness();
  const review = await approvedReview(h, {role: 'first_frame'});
  const submitted = await h.service.submit({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId});
  await rejects(h.service.bind({actor: OPERATOR, projectId: PROJECT, shotId: SHOT, expectedRevision: 3, role: 'first_frame', reviewId: review.reviewId}), 'REVIEW_NOT_READY');
  const result = await h.service.importResult({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId, mimeType: submitted.image!.mimeType, bytes: submitted.image!.bytes});

  await rejects(h.service.bind({actor: AGENT, projectId: PROJECT, shotId: SHOT, expectedRevision: 3, role: 'first_frame', reviewId: review.reviewId}), 'BIND_REQUIRES_OPERATOR');
  await rejects(h.service.bind({actor: OPERATOR, projectId: PROJECT, shotId: SHOT, expectedRevision: 3, role: 'last_frame', reviewId: review.reviewId}), 'ROLE_MISMATCH');
  await rejects(h.service.bind({actor: OPERATOR, projectId: OTHER_PROJECT, shotId: SHOT, expectedRevision: 3, role: 'first_frame', reviewId: review.reviewId}), 'REVIEW_NOT_FOUND');

  const bound = await h.service.bind({actor: OPERATOR, projectId: PROJECT, shotId: SHOT, expectedRevision: 3, role: 'first_frame', reviewId: review.reviewId});
  assert.deepEqual(bound, {projectId: PROJECT, shotId: SHOT, revision: 4, role: 'first_frame', assetId: result.assetId,
    bindings: {firstFrameAssetId: result.assetId, lastFrameAssetId: null}});
  assert.equal(h.store.bindingLog.length, 1);
  assert.equal((await h.store.getReview(PROJECT, review.reviewId))!.status, 'bound');

  const lastHarness = harness();
  const lastReview = await approvedReview(lastHarness, {role: 'last_frame', prompt: 'last frame candidate'});
  // A pre-existing opposite binding must survive an explicit last-frame bind.
  await lastHarness.store.bindFrame({projectId: PROJECT, shotId: SHOT, expectedRevision: 3, role: 'first_frame',
    assetId: SOURCE_ASSET, reviewId: '00000003-0000-4000-8000-0000000000ff', actorId: OPERATOR.id}).catch(() => null);
  const lastSubmitted = await lastHarness.service.submit({actor: OPERATOR, projectId: PROJECT, reviewId: lastReview.reviewId});
  await lastHarness.service.importResult({actor: OPERATOR, projectId: PROJECT, reviewId: lastReview.reviewId, mimeType: lastSubmitted.image!.mimeType, bytes: lastSubmitted.image!.bytes});
  const shotBefore = await lastHarness.store.getShot(PROJECT, SHOT);
  assert.ok(shotBefore);
  const lastBound = await lastHarness.service.bind({actor: OPERATOR, projectId: PROJECT, shotId: SHOT,
    expectedRevision: shotBefore.revision, role: 'last_frame', reviewId: lastReview.reviewId});
  assert.equal(lastBound.bindings.firstFrameAssetId, shotBefore.bindings.firstFrameAssetId);
  assert.equal(lastBound.bindings.lastFrameAssetId, lastBound.assetId);
  await rejects(lastHarness.service.bind({actor: OPERATOR, projectId: PROJECT, shotId: SHOT, expectedRevision: 3, role: 'last_frame', reviewId: lastReview.reviewId}), 'REVISION_CONFLICT');
});

test('durable SQL store is parameterized, immutable on review identity and binds exactly one frame', async () => {
  const calls: {text: string; params: unknown[]}[] = [];
  const sql = {query: async (text: string, params: unknown[] = []) => {calls.push({text, params}); return {rows: [], rowCount: 0};}};
  const store = createSqlFrameAuthoringStore(sql);
  const record = {
    reviewId: '00000003-0000-4000-8000-000000000003', projectId: PROJECT, shotId: SHOT, expectedRevision: 3,
    role: 'first_frame' as const, prompt: "literal ' OR 1=1; DROP TABLE flume.shots; --", modelId: 'google/gemini-2.5-flash-image',
    aspectRatio: '16:9', sourceAssetId: SOURCE_ASSET, sourceAssetSha256: sha256(pngBytes()), requestHash: 'b'.repeat(64),
    status: 'pending' as const, blockers: [], estimateUsd: null,
    envelope: {provider: 'openrouter' as const, modelId: 'google/gemini-2.5-flash-image', body: '{"a":1}', bodySha256: 'c'.repeat(64)},
    createdBy: OPERATOR.id, createdByKind: 'operator' as const, approvedBy: null, resultAssetId: null,
    output: null, providerModelId: null, providerReceiptId: null, errorCode: null,
  };
  await store.insertReview(record);
  const insert = calls.at(-1)!;
  assert.match(insert.text, /INSERT INTO flume\.frame_reviews/);
  assert.ok(!insert.text.includes('DROP TABLE'));
  assert.ok(insert.params.includes(record.prompt), 'prompt travels as a bound parameter');
  assert.ok(insert.params.includes(record.requestHash));

  await store.transition({projectId: PROJECT, reviewId: record.reviewId, from: ['pending'], to: 'approved', patch: {approvedBy: OPERATOR.id}});
  const transition = calls.at(-1)!;
  assert.match(transition.text, /UPDATE flume\.frame_reviews/);
  assert.match(transition.text, /status = \$3/);
  assert.ok(!/SET[^;]*prompt/.test(transition.text), 'review identity columns are never updated');
  assert.ok(!/SET[^;]*request_hash/.test(transition.text));
  const flat = transition.params.flatMap(value => Array.isArray(value) ? value : [value]);
  assert.ok(flat.includes('pending') && flat.includes('approved'));

  await store.bindFrame({projectId: PROJECT, shotId: SHOT, expectedRevision: 3, role: 'last_frame', assetId: '0000000b-0000-4000-8000-00000000000b', reviewId: record.reviewId, actorId: OPERATOR.id});
  const bind = calls.at(-1)!;
  assert.match(bind.text, /jsonb_set/);
  assert.match(bind.text, /frame_bindings/);
  assert.match(bind.text, /status = 'result_ready'/);
  assert.equal(calls.filter(call => call.text.includes('frame_bindings')).length, 1, 'bind is one statement');
  assert.ok(bind.params.includes('{lastFrameAssetId}'), 'only the requested role path is written');
  assert.ok(!bind.text.includes('{firstFrameAssetId}'), 'the opposite frame is never cleared');
  assert.ok(!bind.text.includes('{lastFrameAssetId}'), 'role path is a parameter, not interpolated');
});

test('service DTOs and errors never expose envelopes, credentials or raw provider failures', async () => {
  const h = harness();
  h.provider.submit = async envelope => {
    h.provider.submitCalls.push(envelope);
    return {status: 'failed', error: {code: 'provider_invalid_request', message: 'OpenRouter rejected the image parameters. Preserve the draft and review its controls.'}};
  };
  const review = await approvedReview(h);
  const outcome = await h.service.submit({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId});
  const serialized = JSON.stringify(outcome);
  assert.ok(!serialized.includes('envelope'));
  assert.ok(!serialized.includes('fixture-only-not-a-real-key'));
  assert.ok(!serialized.includes('raw provider detail'));
  const view = await h.service.getReview({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId});
  assert.equal(view.status, 'failed');
  assert.deepEqual(Object.keys(view).sort(), Object.keys(review).sort());
  await assert.rejects(h.service.getReview({actor: AGENT, projectId: OTHER_PROJECT, reviewId: review.reviewId}), error => codeOf(error) === 'FORBIDDEN');
  assert.ok(jpegBytes().length > 0);
});

// --- Wave 2 safety regressions: revision binding, SQL bind atomicity, import orphans, cost cap ---

async function submittedReview(h: Harness, overrides: Partial<FrameDraftInput> = {}) {
  const review = await approvedReview(h, overrides);
  const outcome = await h.service.submit({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId});
  assert.ok(outcome.image, 'fixture provider must return an accepted image');
  return {review, image: outcome.image!};
}

async function importedReview(h: Harness, overrides: Partial<FrameDraftInput> = {}) {
  const {review, image} = await submittedReview(h, overrides);
  const result = await h.service.importResult({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId, mimeType: image.mimeType, bytes: image.bytes});
  return {review, image, result};
}

test('bind requires the client revision AND the frozen review revision to match the live shot', async () => {
  const h = harness();
  const {review, result} = await importedReview(h);
  h.store.bumpShot(PROJECT, SHOT); // live shot is now 4, the review is frozen at 3
  const shotAfterBump = await h.store.getShot(PROJECT, SHOT);
  assert.equal(shotAfterBump!.revision, 4);

  // Echoing the *current* shot revision is not enough: the review was drafted against revision 3.
  await rejects(h.service.bind({actor: OPERATOR, projectId: PROJECT, shotId: SHOT, expectedRevision: 4, role: 'first_frame', reviewId: review.reviewId}), 'REVIEW_REVISION_MISMATCH');
  assert.deepEqual(await h.store.getShot(PROJECT, SHOT), shotAfterBump, 'a refused bind changes nothing');
  assert.equal(h.store.bindingLog.length, 0);
  assert.equal((await h.store.getReview(PROJECT, review.reviewId))!.status, 'result_ready');

  // A stale client revision still reports the conflict first.
  await rejects(h.service.bind({actor: OPERATOR, projectId: PROJECT, shotId: SHOT, expectedRevision: 3, role: 'first_frame', reviewId: review.reviewId}), 'REVISION_CONFLICT');
  assert.equal((await h.store.getReview(PROJECT, review.reviewId))!.status, 'result_ready');
  assert.ok(result.assetId);
});

test('shot revisions must be positive whole numbers', async () => {
  const h = harness();
  await rejects(h.service.createReview({actor: OPERATOR, draft: {...h.draft, expectedRevision: 0}}), 'INVALID_DRAFT');
  const {review} = await importedReview(h);
  await rejects(h.service.bind({actor: OPERATOR, projectId: PROJECT, shotId: SHOT, expectedRevision: 0, role: 'first_frame', reviewId: review.reviewId}), 'INVALID_BIND');
  await rejects(h.service.approveAndSubmit({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId, expectedRevision: 0, maxCostUsd: '1.00'}), 'INVALID_REQUEST');
  assert.equal(h.provider.submitCalls.length, 1, 'a refused revision never submits');
});

test('concurrent imports of one review converge on exactly one owned asset', async () => {
  const h = harness();
  const {review, image} = await submittedReview(h);
  const assetsBefore = h.store.assetSnapshot().size;
  const gate = deferred();
  const realImport = h.media.importOwned.bind(h.media);
  h.media.importOwned = async input => {
    await gate.promise;
    return realImport(input);
  };

  const first = h.service.importResult({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId, mimeType: image.mimeType, bytes: image.bytes});
  const second = h.service.importResult({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId, mimeType: image.mimeType, bytes: image.bytes});
  gate.resolve();
  const [a, b] = await Promise.allSettled([first, second]);
  const fulfilled = [a, b].filter(settled => settled.status === 'fulfilled');
  const rejected = [a, b].find(settled => settled.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one caller may record the result');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.ok(['RESULT_ALREADY_IMPORTED', 'RESULT_IMPORT_IN_PROGRESS'].includes(codeOf(rejected.reason)!), `unexpected loser code ${codeOf(rejected.reason)}`);
  const winner = (fulfilled[0] as PromiseFulfilledResult<{assetId: string}>).value;

  assert.equal(h.store.assetSnapshot().size, assetsBefore + 1, 'exactly one owned asset, never an orphan');
  assert.equal(h.store.claimSnapshot().size, 1, 'one durable import claim for the review');
  assert.equal(h.store.importClaimLog.filter(entry => entry.status === 'claimed').length, 1);
  assert.equal((await h.store.findResult(PROJECT, review.reviewId))!.assetId, winner.assetId);
  assert.equal((await h.store.getReview(PROJECT, review.reviewId))!.status, 'result_ready');
});

test('an import claim held by a different intent is refused before any media write', async () => {
  const h = harness();
  const {review, image} = await submittedReview(h);
  const owner = '0000000e-0000-4000-8000-000000000001';
  const seeded = await h.store.claimResultImport({projectId: PROJECT, reviewId: review.reviewId, assetId: owner, sha256: 'e'.repeat(64), actorId: AGENT.id});
  assert.equal(seeded.status, 'claimed');
  const assetsBefore = h.store.assetSnapshot().size;

  await rejects(h.service.importResult({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId, mimeType: image.mimeType, bytes: image.bytes}), 'RESULT_IMPORT_IN_PROGRESS');
  assert.equal(h.media.imports.length, 0, 'a foreign claim never reaches owned media');
  assert.equal(h.store.assetSnapshot().size, assetsBefore);
  assert.equal(h.store.importClaimLog.at(-1)!.status, 'in_progress');
  assert.equal((await h.store.getReview(PROJECT, review.reviewId))!.status, 'submitted');
});

test('an interrupted import resumes the same owned identity instead of allocating a second asset', async () => {
  const h = harness();
  const {review, image} = await submittedReview(h);
  const assetsBefore = h.store.assetSnapshot().size;
  const realInsert = h.store.insertResult.bind(h.store);
  let failOnce = true;
  h.store.insertResult = async row => {
    if (failOnce) { failOnce = false; throw new Error('FIXTURE_CRASH_BEFORE_RESULT_ROW'); }
    return realInsert(row);
  };

  await assert.rejects(h.service.importResult({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId, mimeType: image.mimeType, bytes: image.bytes}));
  assert.equal(h.store.assetSnapshot().size, assetsBefore + 1, 'the claimed asset exists but no result row does');
  assert.equal(await h.store.findResult(PROJECT, review.reviewId), null);
  assert.equal(h.store.claimSnapshot().get(review.reviewId)!.status, 'importing');

  const resumed = await h.service.importResult({actor: OPERATOR, projectId: PROJECT, reviewId: review.reviewId, mimeType: image.mimeType, bytes: image.bytes});
  assert.equal(h.store.assetSnapshot().size, assetsBefore + 1, 'resume reuses the claimed identity, no second asset');
  assert.equal(h.store.importClaimLog.at(-1)!.status, 'resume');
  assert.equal(resumed.sha256, sha256(image.bytes));
  assert.equal(resumed.assetId, h.store.claimSnapshot().get(review.reviewId)!.assetId);
  assert.equal(h.store.claimSnapshot().get(review.reviewId)!.status, 'imported');
  assert.equal((await h.store.getReview(PROJECT, review.reviewId))!.status, 'result_ready');
});

test('SQL bind is one statement that gates every write on the review precondition and audits the role', async () => {
  const calls: {text: string; params: unknown[]}[] = [];
  const sql = {query: async (text: string, params: unknown[] = []) => {calls.push({text, params}); return {rows: [], rowCount: 0};}};
  const store = createSqlFrameAuthoringStore(sql);
  const bound = await store.bindFrame({
    projectId: PROJECT, shotId: SHOT, expectedRevision: 3, role: 'last_frame',
    assetId: '0000000b-0000-4000-8000-00000000000b', reviewId: '00000003-0000-4000-8000-000000000003', actorId: OPERATOR.id,
  });
  assert.equal(bound, null, 'no rows means nothing happened');
  assert.equal(calls.length, 1, 'bind is exactly one statement');
  const bind = calls[0]!;
  assert.match(bind.text, /FROM pre/, 'the shot write can only fire for a row produced by the gated pre-CTE');
  assert.match(bind.text, /FOR UPDATE OF r, s/, 'concurrent binds re-evaluate the predicate against the committed winner');
  assert.match(bind.text, /r\.status = 'result_ready'/);
  assert.match(bind.text, /r\.shot_revision = \$5/);
  assert.match(bind.text, /s\.revision = \$5/);
  assert.match(bind.text, /r\.role = \$8::text/);
  assert.match(bind.text, /SELECT gen_random_uuid\(\), b\.project_id, b\.id, \$8::text/, 'audit role is the role, not the jsonb path');
  assert.equal(bind.params[7], 'last_frame', 'role travels as its own parameter');
  assert.equal(bind.params.filter(value => value === '{lastFrameAssetId}').length, 1, 'the jsonb path is used once, for the write');
  assert.match(bind.text, /to_jsonb\(rv\.review_row\)/, 'the returned review is the post-update row from the reviewed CTE');
  assert.ok(!/JOIN flume\.frame_reviews r ON/.test(bind.text), 'never re-read the pre-update snapshot for the returned state');
  assert.ok(!/status = 'bound'[\s\S]*RETURNING \*/.test(bind.text));
});

test('SQL import claim is one insert-or-read keyed by review and fails closed when unreadable', async () => {
  const calls: {text: string; params: unknown[]}[] = [];
  const sql = {query: async (text: string, params: unknown[] = []) => {calls.push({text, params}); return {rows: [], rowCount: 0};}};
  const store = createSqlFrameAuthoringStore(sql);
  const claim = await store.claimResultImport({
    projectId: PROJECT, reviewId: '00000003-0000-4000-8000-000000000003',
    assetId: '0000000b-0000-4000-8000-00000000000c', sha256: 'd'.repeat(64), actorId: OPERATOR.id,
  });
  assert.equal(claim.status, 'unavailable', 'an unreadable claim state refuses rather than guesses');
  assert.match(calls[0]!.text, /INSERT INTO flume\.frame_result_imports/);
  assert.match(calls[0]!.text, /ON CONFLICT \(review_id\) DO NOTHING/);
  assert.match(calls[0]!.text, /r\.status = 'submitted'/);
  assert.ok(calls[0]!.params.includes('d'.repeat(64)));
});

test('approval persists the approved maximum and approving actor; a below-estimate cap records nothing', async () => {
  const prepare = (input: {modelId: string; prompt: string}) => {
    const body = JSON.stringify({model: input.modelId, prompt: input.prompt});
    return {envelope: {provider: 'openrouter' as const, modelId: input.modelId, body, bodySha256: sha256(body)}, estimateUsd: '0.04', blockers: []};
  };
  const h = harness({provider: {prepare}});
  const {view} = await createReview(h);
  assert.equal(view.estimateUsd, 0.04);

  const outcome = await h.service.approveAndSubmit({actor: OPERATOR, projectId: PROJECT, reviewId: view.reviewId, expectedRevision: 3, maxCostUsd: '0.05'});
  assert.equal(outcome.review.status, 'submitted');
  const stored = await h.store.getReview(PROJECT, view.reviewId);
  assert.equal(stored!.approvedBy, OPERATOR.id, 'the approving actor is durably recorded');
  assert.equal(stored!.approvedMaxCostUsd, 0.05, 'the approved spend ceiling is durably recorded');

  const below = await createReview(h, {prompt: 'cap too low'});
  await rejects(h.service.approveAndSubmit({actor: OPERATOR, projectId: PROJECT, reviewId: below.view.reviewId, expectedRevision: 3, maxCostUsd: '0.01'}), 'COST_CAP_EXCEEDED');
  const untouched = await h.store.getReview(PROJECT, below.view.reviewId);
  assert.equal(untouched!.status, 'pending');
  assert.equal(untouched!.approvedBy, null);
  assert.equal(untouched!.approvedMaxCostUsd, null);
  assert.equal(h.provider.submitCalls.length, 1, 'a refused cap never spends');

  // An approval recorded without a ceiling may not authorize a later spend.
  const uncapped = await createReview(h, {prompt: 'approve without cap'});
  await h.service.approve({actor: OPERATOR, projectId: PROJECT, reviewId: uncapped.view.reviewId});
  await rejects(h.service.approveAndSubmit({actor: OPERATOR, projectId: PROJECT, reviewId: uncapped.view.reviewId, expectedRevision: 3, maxCostUsd: '0.05'}), 'APPROVAL_CAP_MISSING');
  assert.equal(h.provider.submitCalls.length, 1);
});
