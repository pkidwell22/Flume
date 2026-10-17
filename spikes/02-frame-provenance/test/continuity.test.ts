import { expect, test } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ContinuityDraft } from '../continuity.ts';
import { extract, inspect } from '../media.ts';
import { OUTPUT, fixturePath, sha256, pixels } from '../fixtures.ts';

const fullVfr = { start: '5', end: '5.52' };

test('late red extraction cannot overwrite newer blue input; historical cyan retains original CFR source', async () => {
  const historical = await extract('cfr', { mode: 'last', range: { start: '0', end: '0.24' } });
  const draft = new ContinuityDraft('shot-B');
  draft.chooseFirst(historical);
  const frozen = draft.freeze();
  const before = JSON.stringify(frozen);
  const ticket = draft.beginFirst(await inspect('vfr'));
  let release!: () => void;
  const deliveryGate = new Promise<void>(resolve => { release = resolve; });
  const lateDecode = extract('vfr', { mode: 'first', range: fullVfr });
  const lateDelivery = lateDecode.then(async frame => { await deliveryGate; return draft.completeFirst(ticket, frame); });
  const newer = await extract('vfr', { mode: 'custom', range: fullVfr, requested: '5.1' });
  draft.chooseFirst(newer);
  release();
  expect(await lateDelivery).toBe('stale');
  const late = await lateDecode;
  expect(new Set([historical.image.sha256, late.image.sha256, newer.image.sha256]).size).toBe(3);
  expect(draft.snapshot().first!.provenance.decoded).toMatchObject({ index: 2, pts: '5160', rgbSha256: sha256(pixels(2)) });
  expect(JSON.stringify(frozen)).toBe(before);
  expect(frozen.first!.kind).toBe('conditioning-image');
  expect(frozen.first!.role).toBe('first-frame');
  expect(frozen.first!.provenance.kind).toBe('actual-output-frame');
  expect(frozen.first!.provenance.decoded).toMatchObject({ index: 5, pts: '200', rgbSha256: sha256(pixels(5)) });
  expect(frozen.first!.provenance.source.fixture).toBe('cfr');
  expect(frozen.first!.provenance.source.sourceSha256).toBe(sha256(await readFile(fixturePath('cfr'))));
  expect(frozen.first!.provenance.source.sourceSha256).not.toBe(newer.source.sourceSha256);
  await writeFile(resolve(OUTPUT, 'historical-spec.json'), before);
  const restored = JSON.parse(await readFile(resolve(OUTPUT, 'historical-spec.json'), 'utf8'));
  expect(sha256(await readFile(restored.first.image.path))).toBe(restored.first.image.sha256);
  const resolvedAgain = await extract(restored.first.provenance.source.fixture, restored.first.provenance.request);
  expect(resolvedAgain.decoded.pts).toBe('200');
  expect(resolvedAgain.image.sha256).toBe(restored.first.image.sha256);
});

test('current completion binds first without swapping last and deep frozen provenance rejects mutation', async () => {
  const source = await inspect('vfr');
  const first = await extract('vfr', { mode: 'first', range: fullVfr });
  const last = await extract('vfr', { mode: 'last', range: fullVfr });
  const draft = new ContinuityDraft('shot-C');
  draft.chooseLast(last);
  const ticket = draft.beginFirst(source);
  expect(draft.completeFirst(ticket, first)).toBe('applied');
  expect(draft.completeFirst(ticket, first)).toBe('stale');
  const frozen = draft.freeze();
  expect(frozen.first!.provenance.decoded.pts).toBe('5000');
  expect(frozen.last!.role).toBe('last-frame');
  expect(frozen.last!.provenance.decoded.pts).toBe('5480');
  expect(() => { frozen.first!.provenance.decoded.pts = '999'; }).toThrow();
  first.decoded.pts = '999'; // caller cannot mutate the copied binding or frozen history
  expect(draft.snapshot().first!.provenance.decoded.pts).toBe('5000');
  draft.chooseFirst(null);
  expect(draft.snapshot().first).toBeNull();
  expect(frozen.first!.provenance.decoded.pts).toBe('5000');
});

test('clearing or requesting a newer source invalidates pending work', async () => {
  const oldSource = await inspect('cfr');
  const newSource = await inspect('vfr');
  const oldFrame = await extract('cfr', { mode: 'first', range: { start: '0', end: '0.24' } });
  const draft = new ContinuityDraft('shot-D');
  const a = draft.beginFirst(oldSource);
  draft.chooseFirst(null);
  expect(draft.completeFirst(a, oldFrame)).toBe('stale');
  const b = draft.beginFirst(oldSource);
  const c = draft.beginFirst(newSource);
  expect(draft.completeFirst(b, oldFrame)).toBe('stale');
  expect(draft.completeFirst(c, oldFrame)).toBe('source-mismatch');
  expect(draft.snapshot().first).toBeNull();
});
