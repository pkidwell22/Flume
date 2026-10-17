import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { ContinuityDraft } from './continuity.ts';
import { extract, inspect } from './media.ts';
import type { Selection } from './media.ts';
import { FIXTURE_IDS, OUTPUT, pixels, sha256 } from './fixtures.ts';
import type { FixtureId } from './fixtures.ts';

function fixture(text: string): FixtureId {
  if (!FIXTURE_IDS.includes(text as FixtureId)) throw new Error('OWNED_FIXTURE_ONLY: use a generated fixture ID, never a file/URL');
  return text as FixtureId;
}

async function demo() {
  const whole = { start: '5', end: '5.52' };
  const trimmed = { start: '5.04', end: '5.4' };
  // Literal timing/ordinal expectations are authored independently of the selector.
  const cases: { label: string; fixture: FixtureId; request: Selection; index: number; pts: string }[] = [
    { label: 'cfr-first', fixture: 'cfr', request: { mode: 'first', range: { start: '0', end: '0.24' } }, index: 0, pts: '0' },
    { label: 'cfr-last', fixture: 'cfr', request: { mode: 'last', range: { start: '0', end: '0.24' } }, index: 5, pts: '200' },
    { label: 'vfr-first', fixture: 'vfr', request: { mode: 'first', range: whole }, index: 0, pts: '5000' },
    { label: 'vfr-last', fixture: 'vfr', request: { mode: 'last', range: whole }, index: 5, pts: '5480' },
    { label: 'range-start', fixture: 'vfr', request: { mode: 'first', range: trimmed }, index: 1, pts: '5040' },
    { label: 'range-last', fixture: 'vfr', request: { mode: 'last', range: trimmed }, index: 3, pts: '5200' },
    { label: 'excluded-end', fixture: 'vfr', request: { mode: 'custom', range: whole, requested: '5.4' }, index: 4, pts: '5400' },
    { label: 'custom-gap', fixture: 'vfr', request: { mode: 'custom', range: whole, requested: '5.1' }, index: 2, pts: '5160' },
    { label: 'trim-speed', fixture: 'vfr', request: { mode: 'custom', range: trimmed, mapping: { timelineTime: '0.05', sourceStart: '5.04', rate: '2' } }, index: 2, pts: '5160' },
  ];
  const selections = [];
  for (const entry of cases) {
    const actual = await extract(entry.fixture, entry.request);
    assert.equal(actual.decoded.index, entry.index);
    assert.equal(actual.decoded.pts, entry.pts);
    assert.equal(actual.decoded.rgbSha256, sha256(pixels(entry.index)));
    selections.push({ label: entry.label, expected: { index: entry.index, pts: entry.pts }, actual });
  }
  const draft = new ContinuityDraft('demo-shot-B');
  draft.chooseFirst(selections[1].actual); // Historical cyan from a different source revision.
  const historical = draft.freeze();
  const historicalBefore = JSON.stringify(historical);
  const ticket = draft.beginFirst(await inspect('vfr'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lateDecode = extract('vfr', { mode: 'first', range: whole });
  const lateDelivery = lateDecode.then(async frame => { await gate; return draft.completeFirst(ticket, frame); });
  const newer = await extract('vfr', { mode: 'custom', range: whole, requested: '5.1' });
  draft.chooseFirst(newer);
  release();
  const result = await lateDelivery;
  const late = await lateDecode;
  const current = draft.snapshot();
  assert.equal(result, 'stale');
  assert.equal(current.first!.provenance.decoded.pts, '5160');
  assert.equal(JSON.stringify(historical), historicalBefore);
  assert.equal(new Set([historical.first!.image.sha256, late.image.sha256, newer.image.sha256]).size, 3);
  assert.equal(sha256(await readFile(historical.first!.provenance.source.snapshotPath)), historical.first!.provenance.source.sourceSha256);
  const negatives = [];
  const negativeCases: { fixture: FixtureId; request: Selection; error: string }[] = [
    ...(['equal-pts', 'unknown-pts', 'truncated', 'audio-only', 'multi-video'] as const).map((id, i) => ({
      fixture: id, request: { mode: 'last' as const, range: { start: '0', end: '10' } },
      error: ['AMBIGUOUS_PTS', 'UNKNOWN_TIMESTAMP', 'MEDIA_PROCESS_FAILED', 'UNSUPPORTED_VIDEO_STREAMS', 'UNSUPPORTED_VIDEO_STREAMS'][i],
    })),
    { fixture: 'vfr', request: { mode: 'custom', range: trimmed, requested: '5.4' }, error: 'REQUEST_OUTSIDE_RANGE' },
    { fixture: 'vfr', request: { mode: 'first', range: { start: '5.05', end: '5.16' } }, error: 'NO_FRAME_IN_RANGE' },
  ];
  for (const entry of negativeCases) {
    let message: string | null = null;
    try { await extract(entry.fixture, entry.request); } catch (error) { message = (error as Error).message; }
    assert.ok(message?.includes(entry.error), `expected hold ${entry.error}, got ${message ?? 'success'}`);
    negatives.push({ ...entry, outcome: 'held', observed: message });
  }
  const dir = resolve(OUTPUT, 'demo');
  await mkdir(dir, { recursive: true });
  const report = resolve(dir, 'report.json'); const gallery = resolve(dir, 'index.html');
  const evidence = {
    scope: 'Owned synthetic fixtures, actual FFmpeg decoding; not live provider outputs. In-memory controlled delivery race, not database concurrency.',
    selectionRule: 'frame PTS in [start,end); first=min, last=max; custom=first PTS >= requested, no backward fallback',
    environment: { node: process.version, tools: JSON.parse(await readFile(resolve(OUTPUT, 'fixtures/manifest.json'), 'utf8')).tools },
    selections, negatives, race: { schedule: 'historical frozen -> begin old red -> choose newer blue -> release old delivery', result, historical, current, late },
  };
  await writeFile(report, JSON.stringify(evidence, null, 2));
  const cards = selections.map(s => `<figure><h2>${s.label}</h2><img src="${relative(dir, s.actual.image.path)}" width="384" height="216" alt="Actual decoded ${s.label}"><figcaption>frame ${s.actual.decoded.index}; PTS ${s.actual.decoded.pts} × ${s.actual.decoded.timeBase}; source ${s.actual.decoded.sourceTime}s<br>RGB SHA256 ${s.actual.decoded.rgbSha256}</figcaption></figure>`).join('\n');
  await writeFile(gallery, `<!doctype html><meta charset="utf-8"><title>Frame provenance evidence</title><style>body{font:16px system-ui;margin:2rem}figure{display:inline-block;margin:1rem;vertical-align:top}figcaption{max-width:384px;overflow-wrap:anywhere}img{image-rendering:pixelated}h2{font-size:18px}</style><h1>Actual owned-media extraction evidence</h1><p>Not provider fidelity evidence. <a href="report.json">Full measured JSON</a>. Binary boxes and white-bar length identify each ordinal.</p><p>For [5.04,5.4), green range-start is included; magenta excluded-end is shown separately, never selected as range-last (yellow). Race: historical cyan CFR-last; late red VFR-first rejected; newer blue custom-gap survives.</p>${cards}`);
  return { report, gallery, selections: selections.length, held: negatives.length, lateDelivery: result };
}

async function main(args: string[]) {
  const [command, id, mode, start, end, requested] = args;
  if (command === 'demo' && args.length === 1) return demo();
  if (command === 'inspect' && args.length === 2) return inspect(fixture(id));
  if (command === 'select' && (mode === 'first' || mode === 'last') && args.length === 5) return extract(fixture(id), { mode, range: { start, end } });
  if (command === 'select' && mode === 'custom' && args.length === 6) return extract(fixture(id), { mode, range: { start, end }, requested });
  if (command === 'map' && args.length === 7) return extract(fixture(id), { mode: 'custom', range: { start: args[2], end: args[3] }, mapping: { timelineTime: args[4], sourceStart: args[5], rate: args[6] } });
  throw new Error('USAGE: demo | inspect FIXTURE | select FIXTURE first|last START END | select FIXTURE custom START END REQUESTED | map FIXTURE START END TIMELINE SOURCE_START RATE');
}

try { console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2)); }
catch (error) { console.error(JSON.stringify({ error: (error as Error).message })); process.exitCode = 2; }
