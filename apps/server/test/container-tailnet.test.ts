import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readContainerConfiguration } from '../src/container-configuration.ts';

async function fixture(run: (base: Record<string,string>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'flume-tailnet-test-'));
  try {
    const secret = join(root, 'fixture-secret');
    await writeFile(secret, 'synthetic-test-value', {mode:0o600});
    await run({POSTGRES_HOST:'db',POSTGRES_DB:'flume',POSTGRES_USER:'flume',POSTGRES_PASSWORD_FILE:secret,FLUME_STORAGE_ROOT:'/data/media',FLUME_PUBLIC_ORIGIN:'http://127.0.0.1:4410'});
  } finally { await rm(root, {recursive:true,force:true}); }
}

test('explicit exact tailnet HTTPS origin adds only its host and origin without changing loopback or workers', async () => fixture(async base => {
  const origin = 'https://macbook-air-3.example-tailnet.ts.net';
  const config = await readContainerConfiguration({...base,FLUME_TAILNET_ORIGIN:origin});
  assert.deepEqual(config.allowedHosts, ['127.0.0.1:4410','macbook-air-3.example-tailnet.ts.net']);
  assert.deepEqual(config.allowedOrigins, ['http://127.0.0.1:4410',origin]);
  assert.equal(config.publicOrigin, base.FLUME_PUBLIC_ORIGIN);
  assert.equal(config.autoStartWorkers, false);
}));

test('tailnet opt-in rejects non-exact, non-HTTPS, credentialed, wildcard and non-tailnet origins', async () => fixture(async base => {
  for (const origin of [
    'http://macbook-air-3.example-tailnet.ts.net', 'https://example.com',
    'https://macbook-air-3.example-tailnet.ts.net.evil.test', 'https://*.example-tailnet.ts.net',
    'https://user:pass@macbook-air-3.example-tailnet.ts.net',
    'https://macbook-air-3.example-tailnet.ts.net/', 'https://macbook-air-3.example-tailnet.ts.net/path',
    'https://macbook-air-3.example-tailnet.ts.net?x=1', 'https://macbook-air-3.example-tailnet.ts.net#x',
    'https://macbook-air-3.example-tailnet.ts.net:8443', 'https://ts.net', '',
    ' https://macbook-air-3.example-tailnet.ts.net',
  ]) await assert.rejects(() => readContainerConfiguration({...base,FLUME_TAILNET_ORIGIN:origin}), Error, origin);
}));

test('no opt-in retains original loopback-only allowlists and cannot bypass public-origin or worker policy', async () => fixture(async base => {
  const config=await readContainerConfiguration(base);
  assert.deepEqual(config.allowedHosts,['127.0.0.1:4410']);
  assert.deepEqual(config.allowedOrigins,['http://127.0.0.1:4410']);
  const extra={FLUME_TAILNET_ORIGIN:'https://macbook-air-3.example-tailnet.ts.net'};
  await assert.rejects(() => readContainerConfiguration({...base,...extra,FLUME_PUBLIC_ORIGIN:'https://example.com'}), /loopback/);
  await assert.rejects(() => readContainerConfiguration({...base,...extra,FLUME_WORKERS_ENABLED:'1'}), /queue audit/);
}));
