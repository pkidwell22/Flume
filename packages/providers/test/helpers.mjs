import {createServer} from 'node:http';
import {once} from 'node:events';

// All inputs and keys in this file are synthetic; no remote service is contacted.
export const FAKE_KEY = 'fixture-only-not-a-real-key';
export const paired = {
  modelId: 'google/veo-3.1', name: 'Fixture paired model',
  durations: [4, 6, 8], resolutions: ['720p', '1080p'], aspectRatios: ['16:9', '9:16'],
  frameRoles: ['first_frame', 'last_frame'], seedSupported: true, generateAudioSupported: true,
  availability: 'unknown', blocker: null,
};
export const intent = {
  prompt: '  Keep literal café 🟠 motion.\nDo not rewrite.  ',
  controls: {modelId: paired.modelId, durationSeconds: 4, resolution: '720p', aspectRatio: '16:9', generateAudio: false, seed: 0},
  bindings: {firstFrameAssetId: 'first-asset', lastFrameAssetId: 'last-asset'},
};
export const frames = {
  firstFrame: {assetId: 'first-asset', url: 'data:image/png;base64,AQID'},
  lastFrame: {assetId: 'last-asset', url: 'https://example.com/end%20frame.png?version=0'},
};
export function jsonResponse(res, status, data) {
  res.writeHead(status, {'content-type': 'application/json'});
  res.end(JSON.stringify(data));
}
export async function fixture(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const record = {method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8')};
    requests.push(record);
    try {await handler(record, res, req);} catch {res.destroy();}
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  return {baseUrl: `http://127.0.0.1:${server.address().port}/api/v1`, requests};
}
export function options(f, extra = {}) {
  return {getApiKey: () => FAKE_KEY, fetch: globalThis.fetch, baseUrl: f.baseUrl, allowLoopbackHttpForTests: true, ...extra};
}
