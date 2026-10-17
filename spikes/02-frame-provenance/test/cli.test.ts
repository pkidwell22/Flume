import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { ROOT, sha256, pixels } from '../fixtures.ts';

const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [resolve(ROOT, 'cli.ts'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }));

test('CLI emits inspectable actual custom selection and existing PNG bytes', () => {
  const result = cli('select', 'vfr', 'custom', '5', '5.52', '5.1');
  expect(result.decoded).toMatchObject({ index: 2, pts: '5160', rgbSha256: sha256(pixels(2)) });
  expect(result.requestedSourceTime).toBe('51/10');
  expect(sha256(readFileSync(result.image.path))).toBe(result.image.sha256);
});

test('CLI returns structured explicit errors for boundaries and arbitrary URLs', () => {
  for (const [args, error] of [
    [['select', 'vfr', 'custom', '5.04', '5.4', '5.4'], 'REQUEST_OUTSIDE_RANGE'],
    [['inspect', 'https://example.invalid/a'], 'OWNED_FIXTURE_ONLY'],
    [['select', 'vfr', 'first', '5', '5.52', 'ignored'], 'USAGE'],
  ] as const) {
    const result = spawnSync(process.execPath, [resolve(ROOT, 'cli.ts'), ...args], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error).toContain(error);
  }
});

test('CLI demo retains real images, negative observations, and distinct late/new/history evidence', () => {
  const result = cli('demo');
  const report = JSON.parse(readFileSync(result.report, 'utf8'));
  expect(report.selections).toHaveLength(9);
  expect(report.negatives).toHaveLength(7);
  for (const item of report.selections) expect(sha256(readFileSync(item.actual.image.path))).toBe(item.actual.image.sha256);
  expect(report.race.result).toBe('stale');
  expect(report.race.current.first.provenance.decoded.pts).toBe('5160');
  expect(report.race.historical.first.provenance.source.fixture).toBe('cfr');
  expect(report.race.historical.first.provenance.decoded.pts).toBe('200');
  expect(report.race.late.decoded.pts).toBe('5000');
  expect(new Set([report.race.current.first.image.sha256, report.race.historical.first.image.sha256, report.race.late.image.sha256]).size).toBe(3);
  expect(readFileSync(result.gallery, 'utf8')).toContain('excluded-end');
  expect(report.negatives.every((n: any) => n.outcome === 'held')).toBe(true);
}, 30_000);
