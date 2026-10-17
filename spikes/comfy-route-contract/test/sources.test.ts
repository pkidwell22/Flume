import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import manifest from '../sources/manifest.json' with { type: 'json' };
import { assertDigest } from '../src/sources.ts';
import authored from '../sources/authored-manifest.json' with { type: 'json' };
import semantics from '../sources/semantic-rules.json' with { type: 'json' };
import { cases } from '../fixtures/requests.ts';
import { inspectRequest } from '../src/contract.ts';

const h3Bytes = readFileSync(new URL('../sources/minimax-h3.json', import.meta.url));
const routerBytes = readFileSync(new URL('../sources/router-openapi.yaml', import.meta.url));
const h3 = JSON.parse(h3Bytes.toString());
const router = parse(routerBytes.toString());

describe('pinned public source identity', () => {
  it('pins authored rule/fixture bytes and their explicit versions', () => {
    expect(authored.semanticsVersion).toBe(manifest.semanticsVersion);
    expect(authored.fixtureVersion).toBe(manifest.fixtureVersion);
    for (const [path, digest] of Object.entries(authored.files)) {
      expect(() => assertDigest(readFileSync(new URL(`../${path}`, import.meta.url)), digest), path).not.toThrow();
    }
  });
  it('checks every rule evidence pointer against original public bytes and classifies every fixture rejection', () => {
    expect(semantics.version).toBe(manifest.semanticsVersion);
    for (const rule of semantics.rules) {
      const value = rule.pointer.slice(1).split('/').reduce((node, part) => node[part.replaceAll('~1', '/').replaceAll('~0', '~')], h3);
      expect(value, rule.pointer).toEqual(rule.evidence);
    }
    const emitted = cases.flatMap(fixture => inspectRequest(fixture.body).semantic.issues);
    for (const issue of emitted) {
      expect(semantics.rules.some(rule => rule.codes.some(code => code === issue.code) && rule.basis === issue.basis), issue.code).toBe(true);
    }
    expect([...new Set(emitted.map(issue => issue.code))].sort()).toEqual(semantics.rules.flatMap(rule => rule.codes).sort());
    expect(new Set(cases.map(fixture => fixture.id)).size).toBe(cases.length);
  });
  it('rejects changed bytes rather than blessing a stale semantic contract', () => {
    expect(() => assertDigest(h3Bytes, manifest.h3.sha256)).not.toThrow();
    expect(() => assertDigest(routerBytes, manifest.router.sha256)).not.toThrow();
    expect(() => assertDigest(Buffer.concat([h3Bytes, Buffer.from(' ')]), manifest.h3.sha256)).toThrow(/digest mismatch/);
  });
  it('identifies model/version, shared modality trap, and absent role maxima without guessing', () => {
    expect(h3.info.version).toBe(manifest.h3.version);
    expect(h3.openapi).toBe(manifest.h3.openapi);
    expect(h3['x-comfy-router-model-id']).toBe(manifest.h3.model);
    expect(h3['x-comfy-router-input-modalities']).toEqual(['text', 'image']);
    expect(h3.components.schemas.MinimaxV2ContentItem.properties.video_url).toBeDefined();
    const content = h3.paths['/v2/models/minimax/minimax-h3'].post.requestBody.content['application/json'].schema.properties.content;
    expect(content).not.toHaveProperty('maxItems');
    expect(h3.components.schemas.MinimaxV2ContentItem.properties.role).not.toHaveProperty('enum');
  });
  it('pins the queued same-body route and only emits declared query options', () => {
    expect(router.info.version).toBe(manifest.router.version);
    expect(router.openapi).toBe(manifest.router.openapi);
    const queued = router.paths['/v2/models/{provider}/{model}/requests'].post;
    expect(queued.description).toContain('one body shape, one per-model schema, two delivery modes');
    const refs = queued.parameters.map((parameter: { $ref: string }) => parameter.$ref);
    expect(refs).toContain('#/components/parameters/RejectUnknownFields');
    expect(refs).not.toContain('#/components/parameters/FallbackProvider');
  });
});
