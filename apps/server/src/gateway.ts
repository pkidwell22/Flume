import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const strippedHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto', 'x-real-ip']);
const mediaTypes: Record<string, string> = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webp': 'image/webp' };

export function gatewayProxyHeaders(input: IncomingHttpHeaders, expectedHost: string): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(input)) if (!strippedHeaders.has(name.toLowerCase()) && value !== undefined) result[name.toLowerCase()] = value;
  result.host = expectedHost;
  return result;
}

export function resolveGatewayRequest(rawUrl: string, staticRoot: string): { kind: 'api'; path: string } | { kind: 'static'; path: string } {
  if (!rawUrl.startsWith('/') || rawUrl.startsWith('//') || /%2f|%5c|%00|%25/i.test(rawUrl)) throw new Error('INVALID_GATEWAY_PATH');
  const query = rawUrl.indexOf('?'); const rawPath = query < 0 ? rawUrl : rawUrl.slice(0, query);
  let decoded: string;
  try { decoded = decodeURIComponent(rawPath); } catch { throw new Error('INVALID_GATEWAY_PATH'); }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').includes('..')) throw new Error('INVALID_GATEWAY_PATH');
  if (decoded === '/api' || decoded.startsWith('/api/')) return { kind: 'api', path: rawUrl };
  const selected = decoded === '/' ? '/index.html' : decoded;
  const path = resolve(staticRoot, `.${selected}`), prefix = resolve(staticRoot) + sep;
  if (!path.startsWith(prefix)) throw new Error('INVALID_GATEWAY_PATH');
  return { kind: 'static', path };
}

export function createGateway(options: { staticRoot: string; apiPort: number; allowedHosts: string[] }): Server {
  const allowed = new Set(options.allowedHosts);
  return createServer(async (incoming, outgoing) => {
    const host = incoming.headers.host;
    if (!host || !allowed.has(host)) { outgoing.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }); return outgoing.end('Host denied.'); }
    let route: ReturnType<typeof resolveGatewayRequest>;
    try { route = resolveGatewayRequest(incoming.url ?? '/', options.staticRoot); }
    catch { outgoing.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }); return outgoing.end('Invalid path.'); }
    if (route.kind === 'api') {
      const upstream = httpRequest({ host: '127.0.0.1', port: options.apiPort, method: incoming.method, path: route.path,
        headers: gatewayProxyHeaders(incoming.headers, host), timeout: 35_000 }, response => {
        const headers = gatewayProxyHeaders(response.headers, host); delete headers.host;
        outgoing.writeHead(response.statusCode ?? 502, headers);
        response.once('error', () => outgoing.destroy());
        response.pipe(outgoing);
      });
      // A completed request body is not a disconnected response stream.
      incoming.once('aborted', () => upstream.destroy());
      outgoing.once('close', () => { if (!outgoing.writableEnded) upstream.destroy(); });
      upstream.on('timeout', () => upstream.destroy(new Error('UPSTREAM_TIMEOUT')));
      upstream.on('error', () => { if (outgoing.destroyed) return; if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); outgoing.end('API unavailable.'); });
      incoming.pipe(upstream); return;
    }
    if (!['GET', 'HEAD'].includes(incoming.method ?? 'GET')) { outgoing.writeHead(405, { allow: 'GET, HEAD' }); return outgoing.end(); }
    let path = route.path;
    try {
      let stat = await lstat(path);
      if (!stat.isFile() && !extname(path)) { path = resolve(options.staticRoot, 'index.html'); stat = await lstat(path); }
      if (!stat.isFile() || stat.isSymbolicLink() || !(await realpath(path)).startsWith(resolve(options.staticRoot) + sep)) throw new Error('NOT_FILE');
      outgoing.writeHead(200, { 'content-type': mediaTypes[extname(path)] ?? 'application/octet-stream', 'content-length': stat.size,
        'cache-control': extname(path) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
      if (incoming.method === 'HEAD') return outgoing.end();
      createReadStream(path).pipe(outgoing);
    } catch { outgoing.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); outgoing.end('Not found.'); }
  });
}
