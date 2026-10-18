import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import * as provider from '../src/index.ts';

// Offline fixtures: supplied catalog prices are metadata, not a provider quote.
const H3 = 'minimax/hailuo-3';
const capability = {
  modelId: H3, name: 'Hailuo 3', durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  resolutions: ['2K'], aspectRatios: ['16:9'], frameRoles: ['first_frame', 'last_frame'],
  seedSupported: false, generateAudioSupported: true, availability: 'unknown', blocker: null,
};
const intent = {
  prompt: '  Literal request; no edits.  ',
  controls: {modelId: H3, durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false},
  bindings: {firstFrameAssetId: 'first', lastFrameAssetId: 'last'},
};
const frames = {
  firstFrame: {assetId: 'first', url: 'data:image/png;base64,AQID'},
  lastFrame: {assetId: 'last', url: 'data:image/png;base64,BAUG'},
};
const request = provider.compileVideoRequest(intent, capability, frames);
const pricing = {
  provider: 'openrouter', modelId: H3, currency: 'USD',
  pricingSkus: {duration_seconds: '0.13', reference_images: '0.04'},
};

function estimate(...args) {
  assert.equal(typeof provider.estimateH3VideoCost, 'function', 'the isolated H3 estimator must be exported');
  return provider.estimateH3VideoCost(...[request, capability, pricing].map((fallback, i) => i < args.length ? args[i] : fallback));
}

function unknown(result, reason) {
  assert.equal(result.status, 'unknown');
  assert.equal(result.estimatedCostUsd, null);
  assert.equal(typeof result.reason, 'string');
  if (reason) assert.equal(result.reason, reason);
  assert.equal('lineItems' in result, false, 'never publish a partial price');
}

function withRates(duration, images) {
  return {...pricing, pricingSkus: {duration_seconds: duration, reference_images: images}};
}

function compiled(bodyPatch) {
  const body = {...structuredClone(request.body), ...bodyPatch};
  // Use the real compiler for regular requests; this creates a persisted envelope
  // with independently chosen body controls for malformed/unsupported boundary tests.
  const bodyJson = JSON.stringify(body);
  return {...request, modelId: body.model, body, bodyJson,
    bodySha256: createHash('sha256').update(bodyJson).digest('hex')};
}

test('adds decimal USD in microdollars without floating-point rounding', () => {
  for (const [duration, images, seconds, expected] of [
    ['0.10', '0.20', 5, '0.9'],
    ['0.1', '0.1', 7, '0.9'],
    ['0.1', '0.1', 12, '1.4'],
    ['0.000001', '0.000002', 5, '0.000009'],
    ['0.130000', '0.040000', 15, '2.03'],
    ['0', '0.000000', 5, '0'],
    ['199999999.999999', '0.000002', 5, '999999999.999999'],
  ]) {
    const result = estimate(compiled({duration: seconds}), capability, withRates(duration, images));
    assert.equal(result.status, 'estimated');
    assert.equal(result.estimatedCostUsd, expected);
    assert.equal(result.lineItems[0].unitPriceUsd, duration, 'preserve the literal catalog rate');
    assert.match(result.estimatedCostUsd, /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/);
  }
});

test('does not normalize prices outside the existing USD grammar', () => {
  for (const bad of [
    '', ' ', ' 0.13', '0.13 ', '\n0.13', '0.13\n', '+0.13', '-0', '-0.13',
    '00', '01.3', '.13', '0.', '1e-2', '1E2', '0x10', '1_000', '1,000',
    'NaN', 'Infinity', '0.0000001', '1000000000', '999999999.9999999',
    '０.１３', 0.13, 0, null, undefined, true, {}, [], '9'.repeat(10000),
  ]) {
    for (const rates of [withRates(bad, '0.04'), withRates('0.13', bad)]) {
      unknown(estimate(request, capability, rates), 'invalid_pricing');
    }
  }
});

test('returns unknown instead of rounding or clipping a total above the USD maximum', () => {
  for (const rates of [
    withRates('199999999.999999', '0.000003'),
    withRates('999999999.999999', '0'),
    withRates('0', '999999999.999999'),
  ]) unknown(estimate(request, capability, rates), 'estimate_out_of_range');
});

test('requires explicit well-formed provider, currency and pricing metadata', () => {
  for (const bad of [
    null, undefined, false, [], '0.73', {},
    {...pricing, provider: 'minimax'}, {...pricing, provider: undefined},
    {...pricing, currency: 'usd'}, {...pricing, currency: 'EUR'}, {...pricing, currency: undefined},
    {...pricing, discount: '0'},
    {...pricing, pricingSkus: null}, {...pricing, pricingSkus: []},
    {...pricing, pricingSkus: '0.13'}, {...pricing, pricingSkus: 0.13},
    {...pricing, pricingSkus: Object.create(pricing.pricingSkus)},
  ]) unknown(estimate(request, capability, bad));
});

test('requires every charged SKU and never fills absent rates from defaults', () => {
  for (const skus of [{}, {duration_seconds: '0.13'}, {reference_images: '0.04'}]) {
    unknown(estimate(request, capability, {...pricing, pricingSkus: skus}), 'missing_pricing_sku');
  }
});

test('refuses unfamiliar units, tier shapes and extra price components even at zero', () => {
  for (const [key, value] of [
    ['per-video-second', '0.13'], ['generate', '0'], ['audio', '0'],
    ['duration_seconds_2K', '0.13'], ['minimax/duration_seconds', '0.13'],
    ['discount', '-0.01'], ['reference_images ', '0.04'],
  ]) {
    unknown(estimate(request, capability, {...pricing, pricingSkus: {...pricing.pricingSkus, [key]: value}}), 'unsupported_pricing_units');
  }
  for (const value of [{USD: '0.13'}, {unit: 'seconds', price: '0.13'}, ['0.13']]) {
    unknown(estimate(request, capability, withRates(value, '0.04')), 'invalid_pricing');
  }
});

test('never repairs or substitutes any request, capability or pricing model identity', () => {
  for (const modelId of [
    'minimax/hailuo-02', 'Minimax/hailuo-3', 'minimax/hailuo-3:free',
    ' minimax/hailuo-3', 'minimax/hailuo-3 ', 'minimax/hailuo-3\n', 'h3', '', null,
  ]) {
    unknown(estimate(compiled({model: modelId})));
    unknown(estimate(request, {...capability, modelId}));
    unknown(estimate(request, capability, {...pricing, modelId}));
    unknown(estimate(compiled({model: modelId}), {...capability, modelId}, {...pricing, modelId}));
  }
});

test('binds the estimate to a validated exact compiled body and hash', () => {
  for (const bad of [
    null, undefined, {}, [], {...request, provider: 'another'},
    {...request, modelId: 'another/model'}, {...request, bodySha256: '0'.repeat(64)},
    {...request, bodyJson: request.bodyJson + '\n'},
    {...request, body: {...request.body, duration: 6}},
    compiled({prompt: null}), compiled({prompt: ''}), compiled({prompt: 'x'.repeat(65537)}),
    compiled({duration: '5'}), compiled({generate_audio: undefined}),
    compiled({provider: {quality: 'premium'}}), compiled({n: 2}),
    compiled({frame_images: []}), compiled({frame_images: [{...request.body.frame_images[0], frame_type: 'reference'}]}),
  ]) unknown(estimate(bad));
});

test('estimates only explicitly listed integer durations inside the understood H3 bounds', () => {
  for (const duration of capability.durations) {
    assert.equal(estimate(compiled({duration})).status, 'estimated');
  }
  for (const duration of [0, -0, -5, 4, 16, 5.5, Number.MAX_SAFE_INTEGER, Infinity, NaN]) {
    unknown(estimate(compiled({duration}), {...capability, durations: [duration]}));
  }
  unknown(estimate(request, {...capability, durations: [6]}), 'unsupported_controls');
});

test('rejects resolutions, ratios, audio and seeds outside the understood pricing profile', () => {
  for (const patch of [
    {resolution: '720p'}, {resolution: '4K'}, {resolution: '2k'}, {resolution: '2K '},
    {aspect_ratio: '9:16'}, {aspect_ratio: '1:1'}, {aspect_ratio: '16:9 '},
    {generate_audio: true}, {generate_audio: 'false'},
    {seed: 0}, {seed: -0}, {seed: 10}, {seed: null}, {seed: undefined},
  ]) {
    const cap = {...capability, resolutions: ['2K', '4K', '720p'], aspectRatios: ['16:9', '9:16', '1:1'], seedSupported: true};
    unknown(estimate(compiled(patch), cap));
  }
  unknown(estimate(request, {...capability, resolutions: ['720p']}), 'unsupported_controls');
  unknown(estimate(request, {...capability, aspectRatios: ['9:16']}), 'unsupported_controls');
});

test('retains unknown for malformed, incomplete or ambiguous capabilities', () => {
  for (const bad of [
    null, undefined, {}, [], {...capability, name: null},
    {...capability, durations: undefined}, {...capability, durations: [5, 5]},
    {...capability, durations: [5, '6']}, {...capability, durations: [5, 0]},
    {...capability, durations: [5, , 6]}, {...capability, durations: Array(257).fill(5)},
    {...capability, resolutions: '2K'}, {...capability, resolutions: ['2K', '2K']},
    {...capability, resolutions: ['2K', null]}, {...capability, aspectRatios: null},
    {...capability, frameRoles: ['first_frame', 'last_frame', 'unknown']},
    {...capability, frameRoles: ['first_frame', 'last_frame', 'first_frame']},
    {...capability, seedSupported: undefined}, {...capability, seedSupported: 'false'},
    {...capability, generateAudioSupported: null}, {...capability, availability: 'allowed'},
    {...capability, blocker: false}, {...capability, quality: 'premium'},
  ]) unknown(estimate(request, bad), 'invalid_capability');
});

test('pricing neither infers entitlement nor changes an existing policy hold', () => {
  for (const availability of ['available', 'unknown', 'blocked']) {
    const cap = {...capability, availability, blocker: 'Policy hold must stay in place.'};
    const before = structuredClone(cap);
    const result = estimate(request, cap);
    assert.equal(result.status, 'estimated');
    assert.equal(result.providerEnforcedSpendCap, false);
    assert.equal('approved' in result, false);
    assert.equal('availability' in result, false);
    assert.deepEqual(cap, before);
  }
});

function withFrames(firstFrame, lastFrame) {
  return provider.compileVideoRequest({...intent, bindings: {
    firstFrameAssetId: firstFrame?.assetId ?? null, lastFrameAssetId: lastFrame?.assetId ?? null,
  }}, capability, {firstFrame, lastFrame});
}

test('charges each submitted frame entry, not distinct assets or distinct image URLs', () => {
  const same = {assetId: 'same-asset', url: frames.firstFrame.url};
  for (const [req, count, expected] of [
    [withFrames(null, null), 0, '0.65'],
    [withFrames(frames.firstFrame, null), 1, '0.69'],
    [request, 2, '0.73'],
    [withFrames(same, same), 2, '0.73'],
    [compiled({frame_images: [...request.body.frame_images].reverse()}), 2, '0.73'],
  ]) {
    const result = estimate(req);
    assert.equal(result.status, 'estimated');
    assert.equal(result.estimatedCostUsd, expected);
    assert.equal(result.lineItems.find(item => item.sku === 'reference_images')?.quantity ?? 0, count);
    assert.equal(result.lineItems.length, count ? 2 : 1);
  }
});

test('omits only an unused image SKU, never treats a missing charged SKU as free', () => {
  const secondsOnly = {...pricing, pricingSkus: {duration_seconds: '0.13'}};
  const result = estimate(withFrames(null, null), capability, secondsOnly);
  assert.equal(result.status, 'estimated');
  assert.equal(result.estimatedCostUsd, '0.65');
  unknown(estimate(withFrames(frames.firstFrame, null), capability, secondsOnly), 'missing_pricing_sku');
  unknown(estimate(request, capability, secondsOnly), 'missing_pricing_sku');
  unknown(estimate(withFrames(null, null), capability, withRates('0.13', null)), 'invalid_pricing');
  unknown(estimate(withFrames(null, null), capability, {...pricing, pricingSkus: {reference_images: '0'}}), 'missing_pricing_sku');
});

test('does not price last-frame-only or unadvertised frame-role combinations', () => {
  unknown(estimate(withFrames(null, frames.lastFrame)), 'unsupported_controls');
  for (const frameRoles of [[], ['first_frame'], ['last_frame']]) {
    unknown(estimate(request, {...capability, frameRoles}), 'unsupported_controls');
  }
  assert.equal(estimate(withFrames(null, null), {...capability, frameRoles: []}).status, 'estimated');
});

test('refuses malformed, duplicate and extra submitted frames', () => {
  const [first, last] = request.body.frame_images;
  for (const frame_images of [
    null, {}, [first, first], [first, last, first], [null], [first, , last],
    [{...first, type: 'file'}], [{...first, image_url: {url: 'file:///private/image.png'}}],
    [{...first, frame_type: 'first'}], [{...first, extra: 'unpriced'}],
  ]) unknown(estimate(compiled({frame_images})));
});

test('accepts metadata data properties only, not inherited, hidden or executable values', () => {
  let reads = 0;
  const accessor = {...pricing.pricingSkus};
  Object.defineProperty(accessor, 'duration_seconds', {enumerable: true, get() {reads++; return '0.13';}});
  const hidden = Object.defineProperty({...pricing.pricingSkus}, 'duration_seconds', {enumerable: false, value: '0.13'});
  unknown(estimate(request, Object.create(capability)), 'invalid_capability');
  for (const bad of [
    Object.create(pricing), {...pricing, [Symbol('unpriced')]: '0'},
    {...pricing, pricingSkus: accessor}, {...pricing, pricingSkus: hidden},
    {...pricing, pricingSkus: {...pricing.pricingSkus, [Symbol('unpriced')]: '0'}},
  ]) unknown(estimate(request, capability, bad), 'invalid_pricing');
  assert.equal(reads, 0, 'pricing accessors must not be evaluated');
  const plain = Object.assign(Object.create(null), pricing);
  plain.pricingSkus = Object.assign(Object.create(null), pricing.pricingSkus);
  assert.equal(estimate(request, capability, plain).estimatedCostUsd, '0.73');
});

test('labels the exact five-second, two-frame USD estimate without spending authority', () => {
  const before = structuredClone({request, capability, pricing});
  const result = estimate();
  assert.deepEqual(result, {
    status: 'estimated', provider: 'openrouter', modelId: H3, currency: 'USD',
    bodySha256: request.bodySha256, estimatedCostUsd: '0.73',
    basis: 'catalog_pricing_skus',
    label: 'Catalog-based estimate; not a quote or provider-enforced spend cap.',
    providerEnforcedSpendCap: false,
    lineItems: [
      {sku: 'duration_seconds', quantity: 5, unitPriceUsd: '0.13', estimatedCostUsd: '0.65'},
      {sku: 'reference_images', quantity: 2, unitPriceUsd: '0.04', estimatedCostUsd: '0.08'},
    ],
  });
  assert.deepEqual({request, capability, pricing}, before);
  assert.deepEqual(estimate(), result);
});
