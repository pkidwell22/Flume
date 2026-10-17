import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileFrozen } from '../src/frozen.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/frozen-shot.json', import.meta.url), 'utf8'));

describe('frozen intent to exact H3 queued request (no submit)', () => {
  it('blocks incompatible roles before constructing a request and keeps the draft intact', () => {
    const invalid = structuredClone(fixture);
    invalid.bindings.push({ ...invalid.bindings[0], role: 'reference_image' });
    const before = structuredClone(invalid);
    expect(() => compileFrozen(invalid)).toThrow(/FRAME_REFERENCE_CONFLICT/);
    expect(invalid).toEqual(before);
  });

  it('blocks structurally invalid duration before constructing a request', () => {
    expect(() => compileFrozen({ ...fixture, controls: { ...fixture.controls, duration: 16 } })).toThrow(/Blocked contract/);
  });

  it('locks the detached snapshot and serialized request against later edits', () => {
    const draft = structuredClone(fixture);
    const result = compileFrozen(draft);
    draft.prompt.composed = 'changed';
    draft.bindings[0].uri = 'https://example.invalid/replacement.png';
    expect(result.frozenIntent).toEqual(fixture);
    expect(Object.isFrozen(result.frozenIntent.bindings[1].continuity)).toBe(true);
    expect(Object.isFrozen(result.request.body.content[1])).toBe(true);
    expect(() => { result.request.body.content[0].type = 'video_url'; }).toThrow();
    expect(result.bodyJson).toBe(JSON.stringify(result.request.body));
    expect(compileFrozen(fixture).bodyJson).toBe(result.bodyJson);
  });

  it('preserves unset vs explicit false/zero/random and transmits references under their exact role', () => {
    const referenceShot = structuredClone(fixture);
    referenceShot.bindings = [{ ...fixture.bindings[0], role: 'reference_image' }];
    referenceShot.controls = { duration: 5, resolution: '2K', ratio: '1:1' };
    const unset = compileFrozen(referenceShot);
    expect(unset.request.body).not.toHaveProperty('seed');
    expect(unset.request.body).not.toHaveProperty('aigc_watermark');
    expect(unset.request.body.content[1]).toEqual({ type: 'image_url', role: 'reference_image', image_url: { url: fixture.bindings[0].uri } });
    expect(compileFrozen({ ...referenceShot, controls: { ...referenceShot.controls, seed: -1 } }).request.body.seed).toBe(-1);
    expect(compileFrozen(fixture).request.body.seed).toBe(0);
    expect(compileFrozen(fixture).request.body.aigc_watermark).toBe(false);
    const frameUnset = { ...fixture, controls: { duration: 5, resolution: '768P' } };
    expect(compileFrozen(frameUnset).request.body).not.toHaveProperty('ratio');
  });

  it.each([
    ['model', 'other/model'], ['schemaVersion', 'stale'], ['schemaSha256', '0'.repeat(64)],
    ['semanticsVersion', 'future'], ['unexpected', true],
  ])('refuses stale identity or extra field %s', (key, value) => {
    expect(() => compileFrozen({ ...fixture, [String(key)]: value })).toThrow();
  });

  it.each(['character', 'style', 'general', 'mask', 'reference_video'])('never coerces domain role %s to reference_image', role => {
    expect(() => compileFrozen({ ...fixture, bindings: [{ ...fixture.bindings[0], role }] })).toThrow();
  });

  it('refuses unknown modality, extra controls, invalid digest, and null optionals without dropping them', () => {
    expect(() => compileFrozen({ ...fixture, bindings: [{ ...fixture.bindings[0], modality: 'video' }] })).toThrow();
    expect(() => compileFrozen({ ...fixture, controls: { ...fixture.controls, generate_audio: false } })).toThrow();
    expect(() => compileFrozen({ ...fixture, bindings: [{ ...fixture.bindings[0], sha256: 'sha256:bad' }] })).toThrow();
    expect(() => compileFrozen({ ...fixture, controls: { ...fixture.controls, seed: null } })).toThrow();
  });
  it('preserves the reviewed prompt, role order, controls, and continuity sidecar without provider leakage', () => {
    const before = structuredClone(fixture);
    const result = compileFrozen(fixture);
    expect(result).toBeDefined();
    expect(result.request).toEqual({
      method: 'POST',
      url: 'https://api.comfy.org/v2/models/minimax/minimax-h3/requests?reject_unknown_fields=true',
      body: {
        content: [
          { type: 'text', text: fixture.prompt.composed },
          { type: 'image_url', role: 'last_frame', image_url: { url: 'https://example.invalid/last.png' } },
          { type: 'image_url', role: 'first_frame', image_url: { url: 'https://example.invalid/first.png' } },
        ],
        duration: 5, resolution: '768p', ratio: '16:9', seed: 0, aigc_watermark: false,
      },
    });
    expect(result.frozenIntent).toEqual(before);
    expect(result.frozenIntent).not.toBe(fixture);
    expect(fixture).toEqual(before);
    expect(result.validation.semantic.status).toBe('pass');
    expect(result.validation.runtime.status).toBe('not-run');
    expect(result.executable).toBe(false);
    expect(result.request).not.toHaveProperty('headers');
  });
});
