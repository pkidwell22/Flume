import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as domain from '../src/index.js';

test('shot.update keeps literal draft intent, explicit zero/false and first/end clearing separate', () => {
  assert.ok('CommandSchema' in domain, 'canonical command schema must be exported');
  const schema = (domain as any).CommandSchema;
  const input = {
    type: 'shot.update', commandId: '42B3DC54-6022-473E-94F2-2417A5AE42E4',
    projectId: '00000001-0000-4000-8000-000000000001', shotId: '00000002-0000-4000-8000-000000000002', expectedRevision: 0,
    patch: { prompt: '  literal prompt\n', controls: { durationSeconds: 0, generateAudio: false, seed: 0, modelId: 'unsupported/draft' }, bindings: { lastFrameAssetId: null } },
  };
  assert.deepEqual(schema.parse(input), input);
  assert.equal('firstFrameAssetId' in schema.parse(input).patch.bindings, false);
});

const base = { commandId: '42B3DC54-6022-473E-94F2-2417A5AE42E4', projectId: '00000001-0000-4000-8000-000000000001' };
const shot = { ...base, shotId: '00000002-0000-4000-8000-000000000002', expectedRevision: 0 };
const commands = [
  { type: 'project.create', commandId: base.commandId, name: 'Film', brief: '' },
  { type: 'shot.create', ...base, title: 'Opening', prompt: '' },
  { type: 'shot.update', ...shot, patch: {} },
  { type: 'generation.prepare', ...shot },
  { type: 'generation.approve', ...base, reviewId: '00000003-0000-4000-8000-000000000003', maxAttempts: 1, maxCostUsd: '0.00' },
  { type: 'generation.submit', ...base, reviewId: '00000003-0000-4000-8000-000000000003' },
  { type: 'attempt.resume', ...base, attemptId: '00000004-0000-4000-8000-000000000004' },
  { type: 'take.inspect', ...base, takeId: '00000005-0000-4000-8000-000000000005' },
  { type: 'take.select', ...shot, expectedSelectionRevision: 0, takeId: '00000005-0000-4000-8000-000000000005', inspectionId: '00000006-0000-4000-8000-000000000006' },
  { type: 'export.create', ...shot, expectedSelectionRevision: 0 },
];

test('all ten canonical commands validate literally and reject caller authority claims', () => {
  for (const command of commands) {
    assert.deepEqual(domain.CommandSchema.parse(command), command);
    for (const field of ['actor', 'approved', 'role', 'providerBody', 'leaseVersion']) {
      assert.equal(domain.CommandSchema.safeParse({ ...command, [field]: true }).success, false, `${command.type}: ${field}`);
    }
  }
  assert.equal(domain.CommandSchema.safeParse({ ...commands[0], type: 'project.remove' }).success, false);
  assert.equal(domain.CommandSchema.safeParse({ ...commands[0], commandId: ` ${base.commandId}` }).success, false);
  assert.equal(domain.CommandSchema.safeParse({ ...commands[4], maxCostUsd: 0 }).success, false);
  assert.equal(domain.CommandSchema.safeParse({ ...commands[4], maxCostUsd: '-1' }).success, false);
  assert.equal(domain.CommandSchema.safeParse({ ...commands[4], maxAttempts: 0 }).success, false);
  assert.equal(domain.CommandSchema.safeParse({ ...commands[8], expectedSelectionRevision: undefined }).success, false);
});

test('agent schema excludes approval and nested authority or accidental frame-role aliases', () => {
  assert.ok('AgentCommandSchema' in domain, 'separate agent command schema must be exported');
  const agentSchema = (domain as any).AgentCommandSchema;
  assert.equal(agentSchema.safeParse(commands[4]).success, false);
  assert.deepEqual(agentSchema.parse(commands[5]), commands[5]);
  for (const patch of [{ selectedTakeId: '00000005-0000-4000-8000-000000000005' }, { controls: { approved: true } }, { bindings: { endFrameAssetId: '00000004-0000-4000-8000-000000000004' } }]) {
    assert.equal(domain.CommandSchema.safeParse({ ...commands[2], patch }).success, false);
  }
});

test('catalog estimates name exactly H3 or Wan 2.7, never an arbitrary or canonical suffix', () => {
  assert.ok('CatalogEstimateSchema' in domain, 'the shared catalog estimate schema must remain exported');
  const schema = (domain as any).CatalogEstimateSchema;
  const estimate = {
    status: 'estimated', provider: 'openrouter', modelId: 'alibaba/wan-2.7', currency: 'USD',
    bodySha256: 'a'.repeat(64), estimatedCostUsd: '0.5', basis: 'catalog_pricing_skus',
    label: 'Catalog-based estimate; not a quote or provider-enforced spend cap.',
    providerEnforcedSpendCap: false,
    lineItems: [{ sku: 'duration_seconds', quantity: 5, unitPriceUsd: '0.1', estimatedCostUsd: '0.5' }],
  };
  assert.equal(schema.safeParse(estimate).success, true);
  assert.equal(schema.safeParse({ ...estimate, modelId: 'minimax/hailuo-3' }).success, true);
  for (const modelId of ['alibaba/wan-2.7-20260414', 'alibaba/wan-2.6', 'another/model', '']) {
    assert.equal(schema.safeParse({ ...estimate, modelId }).success, false, modelId);
  }
  assert.equal(schema.safeParse({ ...estimate, lineItems: [{ ...estimate.lineItems[0], sku: 'audio' }] }).success, false);
  assert.equal(schema.safeParse({ ...estimate, approved: true }).success, false);
});
