import { describe, expect, test } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { fixturePath } from '../fixtures.ts';
import type { Selection } from '../media.ts';
import { inspect, extract } from '../media.ts';
import { pixels, sha256 } from '../fixtures.ts';

describe('actual owned media', () => {
  test('extracts visibly distinct first/last CFR endpoints, not duration times FPS', async () => {
    const first = await extract('cfr', { mode: 'first', range: { start: '0', end: '0.24' } });
    const last = await extract('cfr', { mode: 'last', range: { start: '0', end: '0.24' } });
    expect(first.decoded).toMatchObject({ index: 0, pts: '0', timeBase: '1/1000', rgbSha256: sha256(pixels(0)) });
    expect(last.decoded).toMatchObject({ index: 5, pts: '200', timeBase: '1/1000', rgbSha256: sha256(pixels(5)) });
    expect(first.image.sha256).not.toBe(last.image.sha256);
  });

  test('includes a real frame exactly at start and excludes a real frame exactly at end', async () => {
    // PTS=5040 is green #1; PTS=5400 is magenta #4 and MUST NOT win last.
    const request = { range: { start: '5.04', end: '5.4' } };
    const first = await extract('vfr', { ...request, mode: 'first' });
    const last = await extract('vfr', { ...request, mode: 'last' });
    expect(first.decoded).toMatchObject({ index: 1, pts: '5040', rgbSha256: sha256(pixels(1)) });
    expect(last.decoded).toMatchObject({ index: 3, pts: '5200', rgbSha256: sha256(pixels(3)) });
    expect(last.decoded.rgbSha256).not.toBe(sha256(pixels(4)));
    expect(first.image.sha256).not.toBe(last.image.sha256);
    expect(first.kind).toBe('actual-output-frame');
  });

  test('custom snaps forward across a VFR gap and preserves requested versus decoded time', async () => {
    const frame = await extract('vfr', { mode: 'custom', range: { start: '5', end: '5.52' }, requested: '5.1' });
    expect(frame.request.requested).toBe('5.1');
    expect(frame.requestedSourceTime).toBe('51/10');
    expect(frame.decoded).toMatchObject({ index: 2, pts: '5160', sourceTime: '129/25', relativeTime: '4/25', rgbSha256: sha256(pixels(2)) });
  });

  test('maps trimmed positive-speed timeline time to the original nonzero source clock', async () => {
    // Hand oracle: 5.04 + 0.05 * 2 = 5.14; next real PTS is 5.16, not 5.04.
    const frame = await extract('vfr', { mode: 'custom', range: { start: '5.04', end: '5.4' }, mapping: { timelineTime: '0.05', sourceStart: '5.04', rate: '2' } });
    expect(frame.requestedSourceTime).toBe('257/50');
    expect(frame.decoded).toMatchObject({ index: 2, pts: '5160', sourceTime: '129/25', relativeTime: '4/25' });
  });

  test('custom exact-start wins that frame, while exact-end is out of range', async () => {
    const frame = await extract('vfr', { mode: 'custom', range: { start: '5.04', end: '5.4' }, requested: '5.04' });
    expect(frame.decoded.index).toBe(1);
    await expect(extract('vfr', { mode: 'custom', range: { start: '5.04', end: '5.4' }, requested: '5.4' })).rejects.toThrow('REQUEST_OUTSIDE_RANGE');
  });

  test.each([
    [{ mode: 'first', range: { start: '5.4', end: '5.4' } }, 'INVALID_RANGE'],
    [{ mode: 'last', range: { start: '5.4', end: '5' } }, 'INVALID_RANGE'],
    [{ mode: 'first', range: { start: '5.05', end: '5.16' } }, 'NO_FRAME_IN_RANGE'],
    [{ mode: 'custom', range: { start: '5', end: '5.52' }, requested: '5.5' }, 'NO_FRAME_AT_OR_AFTER_REQUEST'],
    [{ mode: 'custom', range: { start: '5', end: '5.52' }, requested: '4.9' }, 'REQUEST_OUTSIDE_RANGE'],
    [{ mode: 'custom', range: { start: '5', end: '5.52' } }, 'CUSTOM_TIME_REQUIRED'],
    [{ mode: 'first', range: { start: 'NaN', end: '5.52' } }, 'INVALID_TIME'],
    [{ mode: 'first', range: { start: '5', end: 'Infinity' } }, 'INVALID_TIME'],
    [{ mode: 'custom', range: { start: '5', end: '5.52' }, mapping: { timelineTime: '0.05', sourceStart: '5', rate: '0' } }, 'UNSUPPORTED_RATE'],
    [{ mode: 'custom', range: { start: '5', end: '5.52' }, mapping: { timelineTime: '0.05', sourceStart: '5', rate: '-1' } }, 'UNSUPPORTED_RATE'],
  ] as const)('rejects invalid or unresolvable selection %j with %s', async (request, error) => {
    await expect(extract('vfr', request)).rejects.toThrow(error);
  });

  test.each([
    ['equal-pts', 'AMBIGUOUS_PTS'],
    ['unknown-pts', 'UNKNOWN_TIMESTAMP'],
    ['truncated', 'MEDIA_PROCESS_FAILED'],
    ['audio-only', 'UNSUPPORTED_VIDEO_STREAMS'],
    ['multi-video', 'UNSUPPORTED_VIDEO_STREAMS'],
  ] as const)('rejects actual %s media explicitly with %s', async (fixture, error) => {
    await expect(extract(fixture, { mode: 'last', range: { start: '0', end: '10' } })).rejects.toThrow(error);
  });

  test('rejects arbitrary files/URLs instead of interpreting them as fixture paths', async () => {
    await expect(inspect('https://example.invalid/private.mp4' as any)).rejects.toThrow('OWNED_FIXTURE_ONLY');
    await expect(inspect('../../secret' as any)).rejects.toThrow('OWNED_FIXTURE_ONLY');
  });

  test.each([
    [{ mode: 'nearest', range: { start: '5', end: '5.52' } }, 'UNSUPPORTED_MODE'],
    [{ mode: 'custom', range: { start: '5', end: '5.52' }, requested: '5.1', mapping: { timelineTime: '0', sourceStart: '5', rate: '1' } }, 'AMBIGUOUS_REQUEST'],
    [{ mode: 'first', range: { start: '5', end: '5.52' }, requested: '5.1' }, 'UNEXPECTED_REQUESTED_TIME'],
    [{ mode: 'custom', range: { start: '5', end: '5.52' }, mapping: { timelineTime: '-0.1', sourceStart: '5.2', rate: '1' } }, 'NEGATIVE_TIMELINE_TIME'],
  ])('does not guess selection semantics %j', async (request, error) => {
    await expect(extract('vfr', request as any)).rejects.toThrow(error as string);
  });

  test('captures requested semantics before asynchronous decoding, not after caller edits', async () => {
    const request: Selection = { mode: 'custom', range: { start: '5', end: '5.52' }, requested: '5.1' };
    const pending = extract('vfr', request);
    request.requested = '5.4';
    const result = await pending;
    expect(result.request.requested).toBe('5.1');
    expect(result.decoded.index).toBe(2);
  });

  test('retains original source bytes when the working fixture is replaced', async () => {
    const original = await readFile(fixturePath('vfr'));
    const source = await inspect('vfr');
    expect(source.snapshotPath).toBeTypeOf('string');
    try {
      await writeFile(fixturePath('vfr'), await readFile(fixturePath('cfr')));
      expect(sha256(await readFile(fixturePath('vfr')))).not.toBe(source.sourceSha256);
      expect(sha256(await readFile(source.snapshotPath))).toBe(sha256(original));
    } finally { await writeFile(fixturePath('vfr'), original); }
  });

  test('measures the VFR nonzero source clock and every decoded pixel hash', async () => {
    const measured = await inspect('vfr');
    // Literal recipe times, not obtained from selection/mapping code.
    expect(measured.timeBase).toBe('1/1000');
    expect(measured.frames.map((f: any) => f.pts)).toEqual(['5000', '5040', '5160', '5200', '5400', '5480']);
    expect(measured.origin).toBe('5000');
    expect(measured.frames.map((f: any) => f.rgbSha256)).toEqual([0, 1, 2, 3, 4, 5].map(i => sha256(pixels(i))));
    expect(measured.eof).toBe('observed-clean-decode');
  });
});
