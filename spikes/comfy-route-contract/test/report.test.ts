import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { cases } from '../fixtures/requests.ts';

it('runs the offline CLI, counts every named case, and never implies live success', () => {
  const report = JSON.parse(execFileSync(process.execPath, ['src/report.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000,
  }));
  expect(report.runtime).toEqual({ status: 'not-run', accountEntitlement: 'unknown', estimate: 'unknown', mediaReadiness: 'unverified' });
  expect(report.fixtureCount).toBe(cases.length);
  expect(report.results.map((row: { id: string }) => row.id)).toEqual(cases.map(row => row.id));
  expect(report.expectationsMet).toBe(true);
  expect(report.fixturePreview.executable).toBe(false);
  expect(report.fixturePreview.request.body.seed).toBe(0);
  expect(report.fixturePreview.request.body.aigc_watermark).toBe(false);
  expect(report.fixturePreview.validation.documentedEffective.ratio).toBe('frame-determined');
});
