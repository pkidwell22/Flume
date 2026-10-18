import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import * as provider from '../src/index.ts';

import {paired, intent, frames} from './helpers.mjs';
export const sha = (body) => createHash('sha256').update(body, 'utf8').digest('hex');

test('compile preserves exact roles, prompt, explicit false/zero and hashed bytes', () => {
  assert.equal(typeof provider.compileVideoRequest, 'function', 'compileVideoRequest must be implemented');
  const result = provider.compileVideoRequest(intent, paired, frames);
  assert.equal(result.provider, 'openrouter');
  assert.equal(result.modelId, paired.modelId);
  assert.deepEqual(result.body, {
    model: paired.modelId, prompt: intent.prompt, duration: 4, resolution: '720p',
    aspect_ratio: '16:9', generate_audio: false, seed: 0,

    frame_images: [
      {type: 'image_url', image_url: {url: frames.firstFrame.url}, frame_type: 'first_frame'},
      {type: 'image_url', image_url: {url: frames.lastFrame.url}, frame_type: 'last_frame'},
    ],
  });
  assert.equal(result.bodyJson, JSON.stringify(result.body));
  assert.equal(result.bodySha256, sha(result.bodyJson));
  assert.ok(Object.isFrozen(result.body.frame_images[0].image_url));
  assert.deepEqual(provider.compileVideoRequest(intent, paired, frames), result);
});

test('multi-megabyte prepared images compile without an unbounded regex stack', () => {
  const dataUri = 'data:image/png;base64,' + 'A'.repeat(4 * 1024 * 1024);
  const request = provider.compileVideoRequest(intent, paired, {...frames, firstFrame: {...frames.firstFrame, url: dataUri}});
  assert.equal(request.body.frame_images[0].image_url.url, dataUri);
  assert.equal(request.bodySha256, sha(request.bodyJson));
});

test('unsupported intent is rejected without coercion, role demotion or draft mutation', () => {
  const invalid = structuredClone(intent);
  invalid.controls.durationSeconds = 0;
  invalid.controls.resolution = '720P';
  invalid.controls.modelId = ' google/veo-3.1';
  const original = structuredClone(invalid);
  assert.throws(() => provider.compileVideoRequest(invalid, paired, frames), {name: 'ProviderValidationError'});
  assert.deepEqual(invalid, original);
  assert.equal(typeof provider.validateVideoIntent, 'function');
  const issues = provider.validateVideoIntent(invalid, paired, frames);
  assert.deepEqual(issues.map(x => x.field).sort(), ['controls.durationSeconds', 'controls.modelId', 'controls.resolution']);
  for (const mutation of [
    c => {c.seedSupported = false;},
    c => {c.frameRoles = ['first_frame'];},
    c => {c.modelId = 'another/model';},
  ]) {
    const cap = structuredClone(paired); mutation(cap);
    assert.throws(() => provider.compileVideoRequest(intent, cap, frames), {name: 'ProviderValidationError'});
  }
});

test('bound asset identity must agree with the explicit frame role', () => {
  const swapped = {firstFrame: frames.lastFrame, lastFrame: frames.firstFrame};
  assert.throws(() => provider.compileVideoRequest(intent, paired, swapped), {name: 'ProviderValidationError'});
  assert.throws(() => provider.compileVideoRequest(intent, paired, {firstFrame: null, lastFrame: frames.lastFrame}), {name: 'ProviderValidationError'});
  const cleared = structuredClone(intent); cleared.bindings.lastFrameAssetId = null;
  assert.throws(() => provider.compileVideoRequest(cleared, paired, frames), {name: 'ProviderValidationError'});
  const request = provider.compileVideoRequest(cleared, paired, {...frames, lastFrame: null});
  assert.equal(request.body.frame_images.length, 1);
  assert.equal(request.body.frame_images[0].frame_type, 'first_frame');
});

test('unknown controls and unsafe reference locations fail rather than silently changing intent', () => {
  for (const url of ['file:///private/frame.png', 'http://example.com/frame.png', ' https://example.com/frame.png', 'https://name:pass@example.com/frame.png', 'data:text/html;base64,AQID', 'data:image/png;base64,!?']) {
    assert.throws(() => provider.compileVideoRequest(intent, paired, {...frames, firstFrame: {...frames.firstFrame, url}}), {name: 'ProviderValidationError'});
  }
  assert.throws(() => provider.compileVideoRequest({...intent, controls: {...intent.controls, unexpected: false}}, paired, frames), {name: 'ProviderValidationError'});
  assert.throws(() => provider.compileVideoRequest({...intent, controls: {...intent.controls, generateAudio: 'false'}}, paired, frames), {name: 'ProviderValidationError'});
});
