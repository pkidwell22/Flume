import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import manifest from '../sources/manifest.json' with { type: 'json' };
import { cases } from '../fixtures/requests.ts';
import { inspectRequest } from './contract.ts';
import { compileFrozen } from './frozen.ts';

const fixturePreview = compileFrozen(JSON.parse(readFileSync(new URL('../fixtures/frozen-shot.json', import.meta.url), 'utf8')));
const results = cases.map(fixture => {
  const actual = inspectRequest(fixture.body);
  const matches = actual.structural.valid === fixture.structural
    && actual.semantic.status === fixture.semantic
    && JSON.stringify(actual.semantic.issues.map(issue => issue.code).sort()) === JSON.stringify([...fixture.codes].sort());
  return { id: fixture.id, matches, ...actual };
});
const expectationsMet = results.every(row => row.matches);
console.log(JSON.stringify({
  label: 'Offline authored request fixtures; no media, receipt, output, entitlement or estimate observed',
  sourceIdentity: manifest,
  runtime: fixturePreview.validation.runtime,
  fixtureCount: results.length,
  expectationsMet,
  fixtureBodySha256: createHash('sha256').update(fixturePreview.bodyJson).digest('hex'),
  fixturePreview,
  results,
}, null, 2));
process.exitCode = expectationsMet ? 0 : 1;
