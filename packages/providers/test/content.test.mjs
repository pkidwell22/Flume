import assert from 'node:assert/strict';
import test from 'node:test';
import {createOpenRouterVideoProvider} from '../src/index.ts';
import {FAKE_KEY, fixture, jsonResponse, options} from './helpers.mjs';

const receipt = () => ({provider: 'openrouter', modelId: 'fixture/model', jobId: 'Fixture-Job-1', bodySha256: 'a'.repeat(64)});
const output = (index = 0) => ({kind: 'openrouter_content', jobId: receipt().jobId, index});
async function collect({body}) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

for (const mode of ['skip', 'break', 'swallow-overflow', 'empty']) {
  test(`content cannot report success when consumer/body is ${mode}`, async t => {
    const f = await fixture(t, (_req, res) => {
      res.writeHead(200, {'content-type': 'video/mp4', 'transfer-encoding': 'chunked'});
      res.end(mode === 'empty' ? undefined : '123456789');
    });
    const result = await createOpenRouterVideoProvider(options(f, {maxContentBytes: mode === 'swallow-overflow' ? 4 : 20})).readContent(receipt(), output(), async ({body}) => {
      if (mode === 'skip') return;
      try {for await (const chunk of body) {if (mode === 'break') break;}}
      catch {if (mode !== 'swallow-overflow') throw new Error('consumer also rejects');}
    });
    assert.equal(result.status, 'content_unavailable');
    assert.equal(result.error.code, mode === 'empty' ? 'provider_content_empty' : mode === 'swallow-overflow' ? 'provider_content_too_large' : 'provider_content_incomplete');
  });
}

test('a fetch that resolves after timeout has its late response cancelled', {timeout: 3000}, async t => {
  let closed;
  const connectionClosed = new Promise(resolve => {closed = resolve;});
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, {'content-type': 'video/mp4'}); res.write('partial');
    res.once('close', closed);
  });
  let release;
  const hold = new Promise(resolve => {release = resolve;});
  const client = createOpenRouterVideoProvider(options(f, {contentTimeoutMs: 40, fetch: async (url, init) => {
    const response = await fetch(url, {...init, signal: undefined});
    await hold;
    return response;
  }}));
  const result = await client.readContent(receipt(), output(), collect);
  assert.equal(result.error.code, 'provider_timeout');
  release();
  let timer;
  try {
    const cancelled = await Promise.race([connectionClosed.then(() => true), new Promise(resolve => {timer = setTimeout(() => resolve(false), 200);})]);
    assert.equal(cancelled, true, 'late headers must not strand an unread response');
  } finally {clearTimeout(timer);}
});

for (const phase of ['headers', 'body']) {
  test(`content deadline covers ${phase}, aborts the read and awaits media cleanup`, {timeout: 3000}, async t => {
    let closed;
    const connectionClosed = new Promise(resolve => {closed = resolve;});
    const f = await fixture(t, (_req, res) => {
      if (phase === 'body') {res.writeHead(200, {'content-type': 'video/mp4'}); res.write('first');}
      const timer = setTimeout(() => {if (phase === 'headers') res.writeHead(200, {'content-type': 'video/mp4'}); res.end('last');}, 200);
      res.once('close', () => {clearTimeout(timer); closed();});
    });
    let cleaned = false;
    let consumerCalled = false;
    const result = await createOpenRouterVideoProvider(options(f, {contentTimeoutMs: 40})).readContent(receipt(), output(), async content => {
      consumerCalled = true;
      try {return await collect(content);}
      finally {await new Promise(resolve => setTimeout(resolve, 15)); cleaned = true;}
    });
    assert.equal(result.status, 'content_unavailable');
    assert.equal(result.error.code, 'provider_timeout');
    assert.equal(consumerCalled, phase === 'body');
    assert.equal(cleaned, phase === 'body', 'must not detach an importer still cleaning up');
    await connectionClosed;
    assert.equal(f.requests.length, 1);
  });
}

test('caller abort interrupts streamed content and is redacted after awaited consumer cleanup', {timeout: 3000}, async t => {
  const controller = new AbortController();
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, {'content-type': 'video/mp4'}); res.write('first');
    const timer = setTimeout(() => res.end('last'), 200);
    res.once('close', () => clearTimeout(timer));
  });
  let cleaned = false;
  const result = await createOpenRouterVideoProvider(options(f)).readContent(receipt(), output(), async ({body, signal}) => {
    try {
      for await (const _chunk of body) controller.abort(new Error(FAKE_KEY));
    } finally {await new Promise(resolve => setTimeout(resolve, 15)); cleaned = true;}
  }, {signal: controller.signal});
  assert.equal(result.status, 'content_unavailable');
  assert.equal(result.error.code, 'provider_aborted');
  assert.equal(cleaned, true);
  assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
});

for (const [label, headers, expected] of [
  ['HTML', {'content-type': 'text/html'}, 'provider_content_type_invalid'],
  ['missing MIME', {}, 'provider_content_type_invalid'],
  ['JSON', {'content-type': 'application/json'}, 'provider_content_type_invalid'],
  ['encoded body', {'content-type': 'video/mp4', 'content-encoding': 'gzip'}, 'provider_content_encoding_invalid'],
  ['oversize declared length', {'content-type': 'video/mp4', 'content-length': '17'}, 'provider_content_too_large'],
  ['empty body', {'content-type': 'video/mp4', 'content-length': '0'}, 'provider_content_empty'],
]) {
  test(`content rejects ${label} before invoking owned-media import`, async t => {
    const f = await fixture(t, (_req, res) => {res.writeHead(200, headers); res.end(headers['content-length'] === '0' ? undefined : 'data');});
    let consumed = false;
    const result = await createOpenRouterVideoProvider(options(f, {maxContentBytes: 16})).readContent(receipt(), output(), async () => {consumed = true;});
    assert.equal(result.status, 'content_unavailable');
    assert.equal(result.error.code, expected);
    assert.equal(consumed, false);
    assert.deepEqual(result.receipt, receipt());
    assert.deepEqual(result.output, output());
  });
}

test('completed descriptors stream exact authenticated content into a credential-free consumer', async t => {
  const bytes = Buffer.from('synthetic transport fixture, not a playable video');
  const f = await fixture(t, (req, res) => {
    if (req.url === `/api/v1/videos/${receipt().jobId}`) {
      jsonResponse(res, 200, {id: receipt().jobId, status: 'completed', unsigned_urls: [`${f.baseUrl}/videos/${receipt().jobId}/content?index=1`]});
    } else {
      res.writeHead(200, {'content-type': 'video/mp4', 'content-length': bytes.length});
      res.end(bytes);
    }
  });
  const client = createOpenRouterVideoProvider(options(f));
  const status = await client.status(receipt());
  assert.equal(status.status, 'retrieving');
  assert.equal(typeof client.readContent, 'function', 'provider needs a bounded, same-job content bridge');
  const result = await client.readContent(status.receipt, status.outputs[0], async content => {
    assert.deepEqual(Object.keys(content).sort(), ['body', 'mimeType', 'signal']);
    assert.equal(content.mimeType, 'video/mp4');
    assert.equal(content.signal.aborted, false);
    return collect(content);
  });
  assert.equal(result.status, 'read');
  assert.deepEqual(result.receipt, receipt());
  assert.deepEqual(result.output, output(1));
  assert.deepEqual(result.value, bytes);
  assert.deepEqual(f.requests.map(r => [r.method, r.url]), [
    ['GET', `/api/v1/videos/${receipt().jobId}`],
    ['GET', `/api/v1/videos/${receipt().jobId}/content?index=1`],
  ]);
  assert.equal(f.requests[1].headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(f.requests[1].headers.cookie, undefined);
});

test('content streaming enforces its own byte budget before handing an excess chunk to media', {timeout: 3000}, async t => {
  let closed;
  const connectionClosed = new Promise(resolve => {closed = resolve;});
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, {'content-type': 'video/mp4'});
    res.write(Buffer.alloc(8, 1));
    const timer = setTimeout(() => res.end(Buffer.alloc(9, 2)), 20);
    res.once('close', () => {clearTimeout(timer); closed();});
  });
  let delivered = 0;
  const result = await createOpenRouterVideoProvider(options(f, {maxContentBytes: 16})).readContent(receipt(), output(), async ({body}) => {
    for await (const chunk of body) { delivered += chunk.length; }
  });
  assert.equal(result.status, 'content_unavailable');
  assert.equal(result.error.code, 'provider_content_too_large');
  assert.equal(delivered, 8);
  assert.deepEqual(result.receipt, receipt());
  assert.deepEqual(result.output, output());
  await connectionClosed;
  assert.equal(f.requests.length, 1);
});
