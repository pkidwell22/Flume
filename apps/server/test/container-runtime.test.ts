import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as api from '../src/index.ts';

test('container configuration reads the database password from a secret file and keeps workers disabled by default', async () => {
  assert.equal(typeof (api as any).readContainerConfiguration, 'function');
  const root = await mkdtemp(join(tmpdir(), 'flume-container-config-'));
  const passwordFile = join(root, 'postgres-password');
  await writeFile(passwordFile, 'p@ss word\n', { mode: 0o600 });
  const config = await (api as any).readContainerConfiguration({
    POSTGRES_HOST: 'db', POSTGRES_DB: 'flume', POSTGRES_USER: 'flume', POSTGRES_PASSWORD_FILE: passwordFile,
    FLUME_STORAGE_ROOT: '/data/media', FLUME_PUBLIC_ORIGIN: 'http://127.0.0.1:4410',
  });
  assert.deepEqual({ host: config.database.host, port: config.database.port, database: config.database.database, user: config.database.user },
    { host: 'db', port: 5432, database: 'flume', user: 'flume' });
  assert.equal(config.database.password, 'p@ss word');
  assert.equal(config.apiPort, 4311);
  assert.equal(config.gatewayPort, 8080);
  assert.equal(config.autoStartWorkers, false);
  assert.deepEqual(config.allowedHosts, ['127.0.0.1:4410']);
  assert.deepEqual(config.allowedOrigins, ['http://127.0.0.1:4410']);
  assert.equal(JSON.stringify(config).includes('p@ss word'), false, 'configuration serialization must not expose the password');
});

test('container configuration accepts an explicit loopback Vite origin but rejects unsafe public origins and worker activation', async () => {
  assert.equal(typeof (api as any).readContainerConfiguration, 'function');
  const root = await mkdtemp(join(tmpdir(), 'flume-container-config-'));
  const passwordFile = join(root, 'password'); await writeFile(passwordFile, 'secret\n');
  const base = { POSTGRES_HOST: 'db', POSTGRES_DB: 'flume', POSTGRES_USER: 'flume', POSTGRES_PASSWORD_FILE: passwordFile,
    FLUME_STORAGE_ROOT: '/data/media', FLUME_PUBLIC_ORIGIN: 'http://127.0.0.1:4410' };
  const config = await (api as any).readContainerConfiguration({ ...base, FLUME_DEV_ORIGIN: 'http://127.0.0.1:4510' });
  assert.deepEqual(config.allowedOrigins, ['http://127.0.0.1:4410', 'http://127.0.0.1:4510']);
  await assert.rejects(() => (api as any).readContainerConfiguration({ ...base, FLUME_PUBLIC_ORIGIN: 'http://0.0.0.0:4410' }), /loopback/);
  await assert.rejects(() => (api as any).readContainerConfiguration({ ...base, FLUME_WORKERS_ENABLED: '1' }), /queue audit/);
});

test('gateway routing rejects traversal and strips forwarding identity while preserving Origin and agent intent', () => {
  assert.equal(typeof (api as any).resolveGatewayRequest, 'function');
  for (const path of ['/../secret', '/%2e%2e/secret', '/assets/%2Fetc', '/assets/%5cetc', '/assets/..%2fsecret']) {
    assert.throws(() => (api as any).resolveGatewayRequest(path, '/srv/web'), /INVALID_GATEWAY_PATH/);
  }
  assert.deepEqual((api as any).resolveGatewayRequest('/assets/app.js?x=1', '/srv/web'), { kind: 'static', path: '/srv/web/assets/app.js' });
  assert.deepEqual((api as any).resolveGatewayRequest('/api/workspace?projectId=x', '/srv/web'), { kind: 'api', path: '/api/workspace?projectId=x' });

  assert.equal(typeof (api as any).gatewayProxyHeaders, 'function');
  const headers = (api as any).gatewayProxyHeaders({
    host: '127.0.0.1:4410', origin: 'http://127.0.0.1:4510', 'x-flume-client': 'agent',
    'x-forwarded-for': '203.0.113.10', forwarded: 'for=203.0.113.10', connection: 'keep-alive', authorization: 'Bearer opaque',
  }, '127.0.0.1:4410');
  assert.equal(headers.host, '127.0.0.1:4410');
  assert.equal(headers.origin, 'http://127.0.0.1:4510');
  assert.equal(headers['x-flume-client'], 'agent');
  assert.equal(headers.authorization, 'Bearer opaque');
  assert.equal(headers['x-forwarded-for'], undefined);
  assert.equal(headers.forwarded, undefined);
  assert.equal(headers.connection, undefined);
});
