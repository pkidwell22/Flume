import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import * as fa from '../src/frame-authoring.js';

const projectId = '00000001-0000-4000-8000-000000000001';
const shotId = '00000002-0000-4000-8000-000000000002';
const sourceAssetId = '00000007-0000-4000-8000-000000000007';
const reviewId = '00000003-0000-4000-8000-000000000003';
const assetId = '00000009-0000-4000-8000-000000000009';
const sha = 'a'.repeat(64);

const draft = {
  projectId, shotId, expectedRevision: 3, role: 'first_frame',
  prompt: '  wide establishing frame, literal café 🟠\nkeep spacing  ',
  modelId: 'google/gemini-2.5-flash-image', aspectRatio: '16:9', sourceAssetId,
};

const reviewView: fa.FrameReviewView = {
  reviewId, projectId, shotId, expectedRevision: 3, role: 'first_frame',
  prompt: draft.prompt, modelId: draft.modelId, aspectRatio: '16:9', sourceAssetId,
  requestHash: 'b'.repeat(64), status: 'pending', blockers: [], estimateUsd: null,
};

const resultView: fa.FrameResultView = {
  assetId, projectId, reviewId, mimeType: 'image/png', width: 1024, height: 576, sha256: sha,
};

test('draft schema is strict, preserves literal prompt bytes and requires platform ids', () => {
  assert.equal(typeof fa.FrameReviewDraftSchema?.parse, 'function', 'FrameReviewDraftSchema must be implemented');
  assert.deepEqual(fa.FrameReviewDraftSchema.parse(draft), draft);
  assert.deepEqual(fa.FrameReviewDraftSchema.parse({...draft, sourceAssetId: null}), {...draft, sourceAssetId: null});
  const {sourceAssetId: _omit, ...withoutSource} = draft;
  assert.deepEqual(fa.FrameReviewDraftSchema.parse(withoutSource), {...withoutSource, sourceAssetId: null});
  for (const bad of [
    {...draft, projectId: 'not-a-uuid'},
    {...draft, shotId: '00000002-0000-4000-8000'},
    {...draft, expectedRevision: -1},
    {...draft, expectedRevision: 1.5},
    {...draft, role: 'first'},
    {...draft, role: 'FIRST_FRAME'},
    {...draft, prompt: ''},
    {...draft, prompt: '   \n\t '},
    {...draft, prompt: 'x'.repeat(fa.MAX_FRAME_PROMPT_CHARS + 1)},
    {...draft, modelId: ' google/gemini-2.5-flash-image'},
    {...draft, modelId: 'gemini'},
    {...draft, aspectRatio: '16x9'},
    {...draft, aspectRatio: '016:9'},
    // No arbitrary source locations: only a project-owned asset id may be referenced.
    {...draft, sourceUrl: 'https://example.com/frame.png'},
    {...draft, sourceAssetId: 'https://example.com/frame.png'},
    {...draft, extra: true},
  ]) assert.equal(fa.FrameReviewDraftSchema.safeParse(bad).success, false, JSON.stringify(bad));

  // Validation must not rewrite the literal prompt or role.
  const parsed = fa.FrameReviewDraftSchema.parse(draft);
  assert.equal(parsed.prompt, draft.prompt);
  assert.equal(parsed.role, 'first_frame');
});

test('review DTO is exact: unknown/private fields are rejected and never projected', () => {
  assert.equal(fa.FrameReviewViewSchema.safeParse(reviewView).success, true);
  for (const extra of [
    {envelope: {body: '{}'}}, {providerReceipt: {id: 'gen-secret'}}, {approvedBy: 'operator'},
    {apiKey: 'sk-or-private'}, {errorCode: 'provider_raw'}, {rawProviderError: 'text'},
  ]) assert.equal(fa.FrameReviewViewSchema.safeParse({...reviewView, ...extra}).success, false, JSON.stringify(extra));
  assert.equal(fa.FrameReviewViewSchema.safeParse({...reviewView, estimateUsd: 0}).success, true);
  assert.equal(fa.FrameReviewViewSchema.safeParse({...reviewView, estimateUsd: -1}).success, false);
  assert.equal(fa.FrameReviewViewSchema.safeParse({...reviewView, estimateUsd: 'unknown'}).success, false);
  assert.equal(fa.FrameReviewViewSchema.safeParse({...reviewView, role: 'left'}).success, false);

  const record: fa.FrameReviewRecord = {
    ...reviewView, sourceAssetSha256: sha, envelope: {provider: 'openrouter', modelId: draft.modelId, body: '{"secret":"body"}', bodySha256: sha},
    createdBy: '00000004-0000-4000-8000-000000000004', createdByKind: 'operator', approvedBy: null,
    resultAssetId: null, output: null, providerModelId: null, providerReceiptId: null, errorCode: null,
  };
  const view = fa.toFrameReviewView(record);
  assert.deepEqual(view, reviewView);
  assert.deepEqual(fa.FrameReviewViewSchema.parse(view), view);
  assert.ok(!JSON.stringify(view).includes('secret'));
});

test('result DTO exposes verified identity only and validates mime/hash/dimensions', () => {
  assert.deepEqual(fa.toFrameResultView({
    ...resultView, shotId, byteSize: 2048, sourceAssetId, providerModelId: 'google/gemini-2.5-flash-image',
    providerReceiptId: 'gen-1', bytes: new Uint8Array([1, 2, 3]), importedBy: 'x',
  }), resultView);
  assert.equal(fa.FrameResultViewSchema.safeParse(resultView).success, true);
  for (const bad of [
    {...resultView, mimeType: 'image/gif'}, {...resultView, mimeType: 'text/html'},
    {...resultView, sha256: 'ABC'}, {...resultView, width: 0}, {...resultView, height: -1.5},
    {...resultView, assetId: 'nope'}, {...resultView, bytes: new Uint8Array([1])},
  ]) assert.equal(fa.FrameResultViewSchema.safeParse(bad).success, false, JSON.stringify(bad));
  assert.equal(fa.FrameResultViewSchema.safeParse({...resultView, byteSize: 1}).success, false);
});

test('bind request requires an explicit role, revision and review; never a bare asset', () => {
  const request = {projectId, shotId, expectedRevision: 4, role: 'last_frame', reviewId};
  assert.deepEqual(fa.FrameBindRequestSchema.parse(request), request);
  for (const bad of [
    {...request, role: 'first'}, {...request, expectedRevision: -1}, {...request, reviewId: undefined},
    {...request, assetId}, {...request, url: 'https://example.com/x.png'}, {...request, role: undefined},
  ]) assert.equal(fa.FrameBindRequestSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test('review status machine forbids approval of blocked reviews and any retry after unknown acceptance', () => {
  assert.equal(fa.canTransitionFrameReview('pending', 'approved'), true);
  assert.equal(fa.canTransitionFrameReview('blocked', 'approved'), false);
  assert.equal(fa.canTransitionFrameReview('pending', 'blocked'), true);
  assert.equal(fa.canTransitionFrameReview('approved', 'submitting'), true);
  assert.equal(fa.canTransitionFrameReview('submitting', 'acceptance_unknown'), true);
  assert.equal(fa.canTransitionFrameReview('acceptance_unknown', 'submitting'), false);
  assert.equal(fa.canTransitionFrameReview('acceptance_unknown', 'approved'), false);
  assert.equal(fa.canTransitionFrameReview('failed', 'submitting'), false);
  assert.equal(fa.canTransitionFrameReview('submitted', 'result_ready'), true);
  assert.equal(fa.canTransitionFrameReview('result_ready', 'bound'), true);
  assert.equal(fa.canTransitionFrameReview('bound', 'result_ready'), false);
  assert.ok(Object.isFrozen(fa.FRAME_AUTHORING_TRANSITIONS));
});

test('request hash is deterministic over exact intent and envelope bytes, independent of estimate', () => {
  assert.equal(typeof fa.frameAuthoringRequestHash, 'function', 'frameAuthoringRequestHash must be implemented');
  const input: fa.FrameRequestHashInput = {
    role: 'first_frame', prompt: draft.prompt, modelId: draft.modelId, aspectRatio: '16:9',
    sourceAssetId, sourceAssetSha256: sha, envelopeSha256: 'c'.repeat(64),
  };
  const hash = fa.frameAuthoringRequestHash(input);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, fa.frameAuthoringRequestHash({...input}));
  assert.equal(hash, createHash('sha256').update(fa.canonicalFrameJson({
    role: 'first_frame', prompt: draft.prompt, modelId: draft.modelId, aspectRatio: '16:9',
    sourceAssetId, sourceAssetSha256: sha, envelopeSha256: 'c'.repeat(64),
  })).digest('hex'));
  const changedInputs: fa.FrameRequestHashInput[] = [
    {...input, prompt: input.prompt + ' '}, {...input, modelId: 'google/other-image'},
    {...input, role: 'last_frame'}, {...input, aspectRatio: '9:16'},
    {...input, sourceAssetId: null, sourceAssetSha256: null}, {...input, envelopeSha256: 'd'.repeat(64)},
  ];
  for (const changed of changedInputs) assert.notEqual(fa.frameAuthoringRequestHash(changed), hash, JSON.stringify(changed));
  // @ts-expect-error A role outside FrameRoleSchema is unrepresentable by type; the runtime guard must reject it too.
  assert.throws(() => fa.frameAuthoringRequestHash({...input, role: 'first'}), TypeError);
});

test('limits are explicit and immutable', () => {
  assert.equal(fa.MAX_FRAME_RESULT_BYTES, 12 * 1024 * 1024);
  assert.equal(fa.MAX_FRAME_REFERENCE_BYTES, 10 * 1024 * 1024);
  assert.deepEqual([...fa.FRAME_IMAGE_MIME_TYPES], ['image/png', 'image/jpeg', 'image/webp']);
  assert.ok(Object.isFrozen(fa.FRAME_AUTHORING_STATUSES));
  assert.deepEqual([...fa.FRAME_AUTHORING_STATUSES],
    ['pending', 'blocked', 'approved', 'submitting', 'submitted', 'result_ready', 'bound', 'failed', 'acceptance_unknown']);
});
