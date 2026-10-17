// Post-run dependency regression checks. Never invokes inference or rewrites evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url));
const json = name => JSON.parse(read(name));
const require = createRequire(import.meta.url);

test('active manifest, lock and installed Ajv use the compatible security update', () => {
  assert.deepEqual(json('package.json').dependencies, {ajv: '8.20.0'});
  const lock = json('package-lock.json');
  assert.deepEqual(lock.packages[''].dependencies, {ajv: '8.20.0'});
  assert.equal(lock.packages['node_modules/ajv'].version, '8.20.0');
  assert.equal(require('ajv/package.json').version, '8.20.0');
});

test('original Ajv manifests are inert snapshots; no unrelated dependencies changed', () => {
  const dir = 'evidence/pre-inference-environment/';
  assert.deepEqual(readdirSync(new URL(`../${dir}`, import.meta.url)).sort(), [
    'package-lock.json.txt', 'package.json.txt',
  ]);
  const historicalManifest = json(`${dir}package.json.txt`);
  const historicalLock = json(`${dir}package-lock.json.txt`);
  assert.deepEqual(historicalManifest.dependencies, {ajv: '8.17.1'});
  assert.deepEqual(historicalLock.packages[''].dependencies, {ajv: '8.17.1'});
  assert.equal(historicalLock.packages['node_modules/ajv'].version, '8.17.1');
  const currentManifest = json('package.json');
  assert.deepEqual(currentManifest, {...historicalManifest, dependencies: {ajv: '8.20.0'}});
  const currentLock = json('package-lock.json');
  // Allow only the direct pin and Ajv's version/tarball/integrity to differ.
  const expected = structuredClone(historicalLock);
  expected.packages[''].dependencies.ajv = '8.20.0';
  for (const key of ['version', 'resolved', 'integrity']) {
    expected.packages['node_modules/ajv'][key] = currentLock.packages['node_modules/ajv'][key];
  }
  assert.deepEqual(currentLock, expected);
});

test('published evidence preserves frozen bytes except the declared run-path redactions', () => {
  // Original Git blobs: 01befa22169ee179f5160fe52a75665e87b4924e.
  // Only the two .run.json hashes below reflect the documented cwd/query-file
  // prefix redaction to <spike>; their other bytes and capture failures are retained.
  // pre-run-lock.json still matches 1945a40f44172a49a8ea51a0e56bd056fb3b0f17.
  const published = {
    'evidence/catalog.json': 'deb755fe1e2495cda673e251dad313ed4ef5680741844a29c9cfaa5c6a1e85a0',
    'evidence/diagnostics.json': '4af4e41c3f3da64e9e4e19ddbf58a89671d95b1655023d4b7f74bdeca21adc7d',
    'evidence/final-verification.json': 'b687ad70026e2b152ec15660ee0356aff6c408b7ce2fb3d29029d274eeef41f7',
    'evidence/glm-5.3-flash.response.txt': '60f55be008b08861f30bafe39ca4636c899231a2e139ceded85bad0924d0f206',
    'evidence/glm-5.3-flash.run.json': 'dca3c87109e8dafddecb9371285100a8c3f51cf5856aed08dec94af7ad350290',
    'evidence/glm-5.3-flash.score.json': '72ea254c32ab0955ac10b43f328f4a02932a2b5bad713cfce33cd24c0d697bbb',
    'evidence/glm-5.3-flash.session.json': 'd4b11fcfc83deba4437640255659c2876bce9c737f92b3d95e873a9fb8668ff1',
    'evidence/kimi-k3.response.txt': '2bf04530057b3035521853816b6b611de5c68d702d7ae734ce7a9d92bf898a8f',
    'evidence/kimi-k3.run.json': '8a315a92f4941d59350fd21dc3321dbe769a89899a2e2e34c0a66dda377af47e',
    'evidence/kimi-k3.score.json': 'd4ec4bd7e80db9d9935edc50a705068d466627fc45cb28411da8010de40130e7',
    'evidence/kimi-k3.session.json': '79aa72b49275e69979ee0886ed14242b8aa6923fcadca329a78500ea3480edd6',
    'evidence/pre-run-lock.json': '3e0f7e0f3832312ff3cbd01ece4879414932e933697d2a3cbd65091c80e5289e',
    'evidence/test-summary.json': 'a233039d61a038c1b862c857ac1ea973dcc7bbe2e95f3e63e0607bdf3e4e518d',
  };
  for (const [path, sha256] of Object.entries(published)) {
    assert.equal(createHash('sha256').update(read(path)).digest('hex'), sha256, path);
  }
});

test('public run metadata uses explicit path placeholders instead of private home paths', () => {
  for (const model of ['kimi-k3', 'glm-5.3-flash']) {
    const record = json(`evidence/${model}.run.json`);
    assert.equal(record.cwd, '<spike>');
    assert.equal(record.command[record.command.indexOf('--query-file') + 1], '<spike>/prompt.txt');
  }
});

for (const model of ['kimi-k3', 'glm-5.3-flash']) {
  test(`${model}: updated Ajv reproduces the entire historical CLI score byte-for-byte`, () => {
    const result = spawnSync(process.execPath, ['score.mjs', `evidence/${model}.response.txt`], {
      cwd: new URL('..', import.meta.url), timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 2, 'Preserve the historical nonpassing score, not a new pass');
    assert.equal(result.stderr.toString(), '');
    assert.deepEqual(result.stdout, read(`evidence/${model}.score.json`));
  });
}
