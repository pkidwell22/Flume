import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import * as provider from '../src/index.ts';

// Offline fixtures only: catalog prices are metadata, never a provider quote.
const WAN = 'alibaba/wan-2.7';
const capability = {
  modelId: WAN, name: 'Wan 2.7', durations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
  resolutions: ['720p', '1080p'], aspectRatios: ['16:9'], frameRoles: ['first_frame', 'last_frame'],
  seedSupported: false, generateAudioSupported: false, availability: 'unknown', blocker: null,
};
const intent = {
  prompt: '  A red cup turns slowly on a pale surface.\nKeep it literal.  ',
  controls: {modelId: WAN, durationSeconds: 5, resolution: '720p', aspectRatio: '16:9', generateAudio: false},
  bindings: {firstFrameAssetId: null, lastFrameAssetId: null},
};
const request = provider.compileVideoRequest(intent, capability, {firstFrame: null, lastFrame: null});
const pricing = {
  provider: 'openrouter', modelId: WAN, currency: 'USD', pricingSkus: {duration_seconds: '0.1'},
};

function estimate(...args) {
  assert.equal(typeof provider.estimateWanVideoCost, 'function', 'the isolated Wan estimator must be exported');
  return provider.estimateWanVideoCost(...[request, capability, pricing].map((fallback, i) => i < args.length ? args[i] : fallback));
}
function unknown(result, reason) {
  assert.equal(result.status, 'unknown');
  assert.equal(result.estimatedCostUsd, null);
  assert.equal(typeof result.reason, 'string');
  if (reason) assert.equal(result.reason, reason);
  assert.equal('lineItems' in result, false, 'never publish a partial price');
}
function withRate(rate) {
  return {...pricing, pricingSkus: {duration_seconds: rate}};
}
function compiled(bodyPatch) {
  const body = {...structuredClone(request.body), ...bodyPatch};
  const bodyJson = JSON.stringify(body);
  return {...request, modelId: body.model, body, bodyJson,
    bodySha256: createHash('sha256').update(bodyJson).digest('hex')};
}
function withFrames(firstFrame, lastFrame) {
  return provider.compileVideoRequest({...intent, bindings: {
    firstFrameAssetId: firstFrame?.assetId ?? null, lastFrameAssetId: lastFrame?.assetId ?? null,
  }}, capability, {firstFrame, lastFrame});
}

test('prices exactly Wan 2.7 at the observed flat per-second duration rate', () => {
  const result = estimate();
  assert.deepEqual(result, {
    status: 'estimated', provider: 'openrouter', modelId: WAN, currency: 'USD',
    bodySha256: request.bodySha256, estimatedCostUsd: '0.5',
    basis: 'catalog_pricing_skus',
    label: 'Catalog-based estimate; not a quote or provider-enforced spend cap.',
    providerEnforcedSpendCap: false,
    lineItems: [{sku: 'duration_seconds', quantity: 5, unitPriceUsd: '0.1', estimatedCostUsd: '0.5'}],
  });
});

test('adds decimal USD in microdollars without floating-point rounding', () => {
  for (const [duration, rate, expected] of [
    [2, '0.1', '0.2'],
    [10, '0.1', '1'],
    [7, '0.13', '0.91'],
    [3, '0.000001', '0.000003'],
    [5, '0.130000', '0.65'],
    [4, '0', '0'],
  ]) {
    const result = estimate(compiled({duration}), capability, withRate(rate));
    assert.equal(result.status, 'estimated');
    assert.equal(result.estimatedCostUsd, expected);
    assert.equal(result.lineItems.length, 1);
    assert.equal(result.lineItems[0].unitPriceUsd, rate, 'preserve the literal catalog rate');
    assert.equal(result.lineItems[0].quantity, duration);
  }
});

test('returns unknown instead of rounding or clipping above the USD maximum', () => {
  unknown(estimate(compiled({duration: 10}), capability, withRate('999999999.999999')), 'estimate_out_of_range');
});

test('requires every charged Wan SKU and refuses unfamiliar units or add-on SKUs', () => {
  unknown(estimate(request, capability, {...pricing, pricingSkus: {}}), 'missing_pricing_sku');
  unknown(estimate(request, capability, {...pricing, pricingSkus: {reference_images: '0.04'}}), 'unsupported_pricing_units');
  for (const [key, value] of [
    ['reference_images', '0.04'], ['audio', '0'], ['duration_seconds_720p', '0.1'],
    ['discount', '-0.01'], ['duration_seconds ', '0.1'],
  ]) unknown(estimate(request, capability, {...pricing, pricingSkus: {duration_seconds: '0.1', [key]: value}}), 'unsupported_pricing_units');
  for (const bad of ['', ' 0.1', '0.1 ', '\n0.1', '+0.1', '-0.1', '00', '01', '.1', '0.', '1e-1', 'NaN', 'Infinity', '0.0000001', 0.1, null, undefined, true]) {
    unknown(estimate(request, capability, withRate(bad)), 'invalid_pricing');
  }
});

test('requires explicit, well-formed provider, currency and model pricing metadata', () => {
  for (const bad of [
    null, undefined, false, [], '0.1', {},
    {...pricing, provider: 'minimax'}, {...pricing, currency: 'EUR'}, {...pricing, discount: '0'},
    {...pricing, pricingSkus: null}, {...pricing, pricingSkus: []}, {...pricing, pricingSkus: '0.1'},
  ]) unknown(estimate(request, capability, bad));
});

test('never repairs or substitutes any request, capability or pricing model identity', () => {
  for (const modelId of [
    'alibaba/wan-2.7-20260414', 'alibaba/wan-2.7:free', 'Alibaba/wan-2.7',
    ' alibaba/wan-2.7', 'alibaba/wan-2.7 ', 'wan-2.7', '', null,
  ]) {
    unknown(estimate(compiled({model: modelId})));
    unknown(estimate(request, {...capability, modelId}));
    unknown(estimate(request, capability, {...pricing, modelId}));
    unknown(estimate(compiled({model: modelId}), {...capability, modelId}, {...pricing, modelId}));
  }
});

test('estimates only explicitly listed integer durations inside the understood Wan bounds', () => {
  for (const duration of capability.durations) assert.equal(estimate(compiled({duration})).status, 'estimated');
  for (const duration of [1, 11, Number.MAX_SAFE_INTEGER]) {
    unknown(estimate(compiled({duration}), {...capability, durations: [duration]}), 'unsupported_controls');
  }
  // Non-positive or fractional durations are not valid compiled bodies at all.
  for (const duration of [0, -0, -2, 5.5, Infinity, NaN]) unknown(estimate(compiled({duration}), {...capability, durations: [duration]}));
  unknown(estimate(request, {...capability, durations: [6]}), 'unsupported_controls');
});

test('rejects resolutions, ratios, audio and seeds outside the verified Wan profile', () => {
  for (const patch of [
    {resolution: '4K'}, {resolution: '720P'}, {resolution: '1080P'}, {resolution: '720p '},
    {aspect_ratio: '9:16'}, {aspect_ratio: '1:1'}, {aspect_ratio: '16:9 '},
    {generate_audio: true}, {generate_audio: 'false'},
    {seed: 0}, {seed: -0}, {seed: 10}, {seed: null}, {seed: undefined},
  ]) {
    const cap = {...capability, resolutions: ['720p', '1080p', '4K'], aspectRatios: ['16:9', '9:16', '1:1'], seedSupported: true};
    unknown(estimate(compiled(patch), cap));
  }
  unknown(estimate(request, {...capability, resolutions: ['1080p']}), 'unsupported_controls');
  unknown(estimate(request, {...capability, aspectRatios: ['9:16']}), 'unsupported_controls');
});

test('binds the estimate to the exact compiled body and hash', () => {
  for (const bad of [
    null, undefined, {}, {...request, provider: 'another'},
    {...request, modelId: 'alibaba/wan-2.6'}, {...request, bodySha256: '0'.repeat(64)},
    {...request, bodyJson: request.bodyJson + '\n'},
    {...request, body: {...request.body, duration: 6}},
    compiled({prompt: null}), compiled({prompt: ''}), compiled({prompt: 'x'.repeat(65537)}),
    compiled({duration: '5'}), compiled({generate_audio: undefined}), compiled({n: 2}),
    compiled({frame_images: []}), compiled({frame_images: [{type: 'image_url', image_url: {url: 'data:image/png;base64,AQID'}, frame_type: 'reference'}]}),
  ]) unknown(estimate(bad));
});

test('flat duration pricing covers catalog-advertised frames without inventing an image SKU', () => {
  const first = {assetId: 'first', url: 'data:image/png;base64,AQID'};
  const last = {assetId: 'last', url: 'data:image/png;base64,BAUG'};
  for (const [req, count] of [[withFrames(first, null), 1], [withFrames(first, last), 2]]) {
    const result = estimate(req);
    assert.equal(result.status, 'estimated');
    assert.equal(result.estimatedCostUsd, '0.5');
    assert.equal(result.lineItems.length, 1);
    assert.equal(result.lineItems[0].sku, 'duration_seconds');
    assert.equal(JSON.parse(req.bodyJson).frame_images.length, count);
  }
  unknown(estimate(withFrames(null, {assetId: 'last', url: 'data:image/png;base64,BAUG'})), 'unsupported_controls');
  for (const frameRoles of [[], ['first_frame'], ['last_frame']]) {
    unknown(estimate(withFrames(first, last), {...capability, frameRoles}), 'unsupported_controls');
  }
});

test('keeps unknown for malformed capabilities and never changes availability', () => {
  for (const bad of [
    null, undefined, {}, [], {...capability, name: null},
    {...capability, durations: undefined}, {...capability, durations: [5, 5]},
    {...capability, resolutions: '720p'}, {...capability, aspectRatios: null},
    {...capability, frameRoles: ['first_frame', 'unknown']},
    {...capability, availability: 'allowed'}, {...capability, quality: 'premium'},
  ]) unknown(estimate(request, bad), 'invalid_capability');
  for (const availability of ['available', 'unknown', 'blocked']) {
    const cap = {...capability, availability, blocker: 'Keep this policy hold.'};
    const before = structuredClone(cap);
    const result = estimate(request, cap);
    assert.equal(result.status, 'estimated');
    assert.equal(result.providerEnforcedSpendCap, false);
    assert.equal('approved' in result, false);
    assert.equal('availability' in result, false);
    assert.deepEqual(cap, before);
  }
});
