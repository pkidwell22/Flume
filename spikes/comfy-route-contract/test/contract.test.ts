import { describe, expect, it } from 'vitest';
import { inspectRequest } from '../src/contract.ts';

import { cases, first, textBody } from '../fixtures/requests.ts';

describe('authored semantic cases (not runtime)', () => {
  it.each(cases)('$id', ({ body, structural, semantic, codes }) => {
    const result = inspectRequest(body);
    expect(result.structural.valid).toBe(structural);
    expect(result.semantic.status).toBe(semantic);
    expect(result.semantic.issues.map(issue => issue.code).sort()).toEqual([...codes].sort());
  });
});

describe('documented effective controls, not measured outputs', () => {
  it('never promotes documented acceptance to runtime or account proof', () => {
    expect(inspectRequest(textBody).runtime).toEqual({
      status: 'not-run', accountEntitlement: 'unknown', estimate: 'unknown', mediaReadiness: 'unverified',
    });
  });
  it('retains requested ratio while declaring frame-determined geometry', () => {
    const body = { ...textBody, resolution: '768p', content: [...textBody.content, first] };
    const before = structuredClone(body);
    expect(inspectRequest(body).documentedEffective).toEqual({ ratio: 'frame-determined', resolution: '768P' });
    expect(body).toEqual(before);
    expect(inspectRequest(textBody).documentedEffective).toEqual({ ratio: '16:9', resolution: '768P' });
  });
});

describe('pinned public structural schema', () => {
  it('accepts the H3 text request and rejects out-of-range duration', () => {
    expect(inspectRequest(textBody).structural.valid).toBe(true);
    expect(inspectRequest({ ...textBody, duration: 3 }).structural.valid).toBe(false);
  });
});
