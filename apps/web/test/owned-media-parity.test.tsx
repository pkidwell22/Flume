import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownedMediaUrl } from '../src/shell.ts';
import { safeFrameMediaUrl } from '../src/frame-authoring-types.ts';
import { ownedThumbnailUrl } from '@flume/shot-editor';

// One URL matrix, three predicates. The shot editor cannot import the web app, so its
// thumbnail rule is a mirror of the approved policy; this test is what keeps it honest.
const ORIGIN = 'http://localhost';

const cases: Array<[string, string | undefined]> = [
  // Legitimate owned media keeps its path and query.
  ['/api/media/a', '/api/media/a'],
  ['/api/media/a?rev=2', '/api/media/a?rev=2'],
  ['http://localhost/api/media/a', '/api/media/a'],
  // Everything else is refused.
  ['https://cdn.example.com/api/media/a', undefined],
  ['//cdn.example.com/api/media/a', undefined],
  ['data:image/png;base64,AAAA', undefined],
  ['javascript:alert(1)', undefined],
  ['blob:http://localhost/6f6d', undefined],
  ['http://[::1', undefined],
  ['http://user:pass@localhost/api/media/a', undefined],
  ['/api/media/../secret', undefined],
  ['/api/media/%2e%2e/a', undefined],
  ['/api/commands', undefined],
  ['/art/alpine-forest-wide.webp', undefined],
  ['', undefined],
];

test('the editor thumbnail predicate agrees with the approved web owned-media policy', () => {
  for (const [input, expected] of cases) {
    const shell = ownedMediaUrl({ mediaUrl: input }, ORIGIN);
    const frame = safeFrameMediaUrl(input, ORIGIN);
    const thumbnail = ownedThumbnailUrl(input, ORIGIN);
    assert.equal(shell, expected, `apps/web shell.ts ownedMediaUrl: ${JSON.stringify(input)}`);
    assert.equal(frame, expected, `apps/web frame-authoring-types.ts safeFrameMediaUrl: ${JSON.stringify(input)}`);
    assert.equal(thumbnail, expected, `packages/shot-editor media-url.ts ownedThumbnailUrl: ${JSON.stringify(input)}`);
    assert.deepEqual([shell, frame, thumbnail], [thumbnail, thumbnail, thumbnail], `predicates agree: ${JSON.stringify(input)}`);
  }
});

test('a legacy asset without a recorded mediaUrl is refused by the editor predicate too', () => {
  assert.equal(ownedThumbnailUrl(undefined, ORIGIN), undefined);
  assert.equal(ownedThumbnailUrl(null, ORIGIN), undefined);
  assert.equal(safeFrameMediaUrl(undefined, ORIGIN), undefined);
  assert.equal(ownedMediaUrl({ mediaUrl: undefined as unknown as string }, ORIGIN), undefined);
});
