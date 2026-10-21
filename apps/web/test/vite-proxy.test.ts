import assert from 'node:assert/strict';
import { test } from 'node:test';

test('the loopback-only Vite proxy targets the API Host while preserving browser identity headers', async () => {
  const previous = process.env.FLUME_API_URL;
  process.env.FLUME_API_URL = 'http://127.0.0.1:4410';
  try {
    const config = (await import(`../vite.config.ts?test=${Date.now()}`)).default as any;
    assert.equal(config.server.proxy['/api'].target, 'http://127.0.0.1:4410');
    assert.equal(config.server.proxy['/api'].changeOrigin, true, 'stable gateway must receive its own allowlisted Host');
    assert.equal(config.server.proxy['/api'].headers, undefined, 'Origin and X-Flume-Client must not be synthesized or overwritten');
  } finally {
    if (previous === undefined) delete process.env.FLUME_API_URL; else process.env.FLUME_API_URL = previous;
  }
});
