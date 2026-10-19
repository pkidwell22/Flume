import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CapabilitySchema, WorkspaceSchema, emptyWorkspace, type Capability } from '../src/index.js';

const legacy: Capability = {
  modelId: 'fixture/catalog-only', name: 'Controlled catalog fixture', durations: [5], resolutions: ['1080p'],
  frameRoles: ['first', 'last'], seedSupported: false, availability: 'unknown', blocker: null,
};

test('optional capability read fields preserve exact values and do not infer account availability', () => {
  for (const generateAudioSupported of [true, false]) {
    const capability: Capability = { ...legacy, aspectRatios: ['9:16', '2:1', '16:9'], generateAudioSupported };
    const workspace = { ...emptyWorkspace(), capabilities: [capability] };
    assert.deepEqual(WorkspaceSchema.parse(workspace), workspace);
    assert.equal(CapabilitySchema.parse(capability).generateAudioSupported, generateAudioSupported);
    assert.equal(CapabilitySchema.parse(capability).availability, 'unknown');
  }
});

test('absent, explicit false and empty aspect metadata remain distinct without defaults', () => {
  const parsed = CapabilitySchema.parse(legacy);
  assert.deepEqual(parsed, legacy);
  assert.equal(Object.hasOwn(parsed, 'aspectRatios'), false);
  assert.equal(Object.hasOwn(parsed, 'generateAudioSupported'), false);
  for (const fields of [{ aspectRatios: [] }, { generateAudioSupported: false }, { aspectRatios: [], generateAudioSupported: true }]) {
    const capability = { ...legacy, ...fields };
    assert.deepEqual(CapabilitySchema.parse(capability), capability);
  }
});

test('new metadata is validated, not coerced, and does not open the strict capability envelope', () => {
  for (const fields of [
    { aspectRatios: null }, { aspectRatios: '16:9' }, { aspectRatios: [''] }, { aspectRatios: [16 / 9] },
    { generateAudioSupported: null }, { generateAudioSupported: 'false' }, { generateAudioSupported: 0 },
    { futureCapabilityField: true }, { providerEnvelope: { body: 'private-fixture-envelope' } },
  ]) {
    assert.equal(CapabilitySchema.safeParse({ ...legacy, ...fields }).success, false, JSON.stringify(fields));
  }
});
