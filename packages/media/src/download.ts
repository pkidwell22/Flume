import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { stat } from 'node:fs/promises';
import { writeStream } from './storage.ts';
import { MediaError, check } from './types.ts';
import type { DownloadPolicy, Limits } from './types.ts';

interface Address { address: string; family: number }
interface Response { statusCode: number; headers: IncomingHttpHeaders; body: AsyncIterable<Uint8Array>; close(): void }
/** Internal fixture seam, intentionally not exported by @flume/media. */
export interface DownloadTransport {
  resolve(hostname: string): Promise<Address[]>;
  get(url: URL, pin: Address, headers: Record<string, string>, signal: AbortSignal): Promise<Response>;
}
const systemTransport: DownloadTransport = {
  resolve: hostname => lookup(hostname, { all: true, verbatim: true }),
  get(url, pin, headers, signal) {
    return new Promise((resolve, reject) => {
      const req = get(url, { agent: false, signal, headers, minVersion: 'TLSv1.2', maxHeaderSize: 16_384,
        // DNS is checked once, then pinned at the socket. TLS still verifies the original hostname.
        lookup: (_host, options: any, callback: any) => options.all
          ? callback(null, [{ address: pin.address, family: pin.family }]) : callback(null, pin.address, pin.family),
      }, response => resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: response, close: () => { response.destroy(); req.destroy(); } }));
      req.on('error', () => reject(new MediaError(signal.aborted ? 'DOWNLOAD_TIMEOUT' : 'DOWNLOAD_FAILED')));
    });
  },
};
async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new MediaError('DOWNLOAD_TIMEOUT');
  let abort: () => void = () => {};
  const timeout = new Promise<never>((_, reject) => { abort = () => reject(new MediaError('DOWNLOAD_TIMEOUT')); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([promise, timeout]); } finally { signal.removeEventListener('abort', abort); }
}
export async function downloadToFile(value: string, policy: DownloadPolicy, output: string, limits: Limits, transport = systemTransport): Promise<{ claimedMime?: string }> {
  policy = structuredClone(policy);
  const redirects = policy.maxRedirects ?? 3;
  check(Number.isInteger(redirects) && redirects >= 0 && redirects <= 3 && policy.allowedHosts.length <= 32, 'INVALID_DOWNLOAD_POLICY');
  let url = validateRemoteUrl(value, policy);
  const controller = new AbortController(); const deadline = Date.now() + limits.ingestTimeoutMs;
  const timer = setTimeout(() => controller.abort(), limits.ingestTimeoutMs);
  try {
    for (let hop = 0; ; hop++) {
      const addresses = await bounded(transport.resolve(url.hostname), controller.signal);
      check(addresses.length > 0 && addresses.length <= 64 && addresses.every(a => isPublicAddress(a.address) && isIP(a.address) === a.family), 'PRIVATE_ADDRESS');
      const pin = addresses.find(a => a.family === 4) ?? addresses[0];
      const response = await bounded(transport.get(url, pin, { accept: 'video/*,image/*,application/octet-stream', 'accept-encoding': 'identity', 'user-agent': 'Flume-Owned-Media/1' }, controller.signal), controller.signal);
      try {
        if ([301,302,303,307,308].includes(response.statusCode)) {
          check(hop < redirects, 'REDIRECT_LIMIT');
          check(typeof response.headers.location === 'string', 'INVALID_REDIRECT');
          url = validateRemoteUrl(new URL(response.headers.location, url).href, policy); continue;
        }
        check(response.statusCode === 200, 'DOWNLOAD_HTTP_STATUS');
        check(!response.headers['content-encoding'] || response.headers['content-encoding'] === 'identity', 'CONTENT_ENCODING_REJECTED');
        const length = response.headers['content-length'];
        if (length !== undefined) check(typeof length === 'string' && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) && Number(length) > 0 && Number(length) <= limits.maxBytes, 'BYTE_LIMIT');
        // The writer has its own remaining deadline. Await its close/iterator cleanup; racing it
        // against another rejection lets callers remove staging while a write is still pending.
        await writeStream(response.body, output, { ...limits, ingestTimeoutMs: Math.max(1, deadline-Date.now()) });
        if (length !== undefined) check((await stat(output)).size === Number(length), 'CONTENT_LENGTH_MISMATCH');
        const claimedMime = response.headers['content-type']?.split(';')[0].trim();
        return { ...(claimedMime ? { claimedMime } : {}) };
      } finally { response.close(); }
    }
  } catch (e) { if (e instanceof MediaError) throw e; throw new MediaError('DOWNLOAD_FAILED'); }
  finally { clearTimeout(timer); controller.abort(); }
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    const n = octets.reduce((a, b) => a * 256 + b, 0);
    const denied: [string, number][] = [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4],['168.63.129.16',32]];
    return !denied.some(([base, bits]) => Math.floor(n / 2 ** (32-bits)) === Math.floor(base.split('.').map(Number).reduce((a,b) => a * 256 + b, 0) / 2 ** (32-bits)));
  }
  if (isIP(address) !== 6 || address.includes('.') || address.includes('%')) return false;
  const halves = address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [], right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const parts = halves.length === 2 ? [...left, ...Array(8-left.length-right.length).fill('0'), ...right] : left;
  const n = parts.reduce((a: bigint, b: string) => (a << 16n) | BigInt(`0x${b}`), 0n);
  // Global unicast only; exclude transition/special/documentation ranges. Mapped IPv4 never reaches this branch.
  return n >> 125n === 1n && n >> 112n !== 0x2002n && n >> 105n !== 0x100080n
    && n >> 96n !== 0x20010db8n && n >> 108n !== 0x3fff0n;
}
export function validateRemoteUrl(value: string, policy: DownloadPolicy): URL {
  try {
    check(typeof value === 'string' && value.length <= 8192 && !/[\x00-\x20\x7f]/.test(value), 'REMOTE_URL_REJECTED');
    const u = new URL(value);
    check(u.protocol === 'https:' && !u.username && !u.password && !u.hash && (!u.port || u.port === '443')
      && !isIP(u.hostname.replace(/^\[|\]$/g, '')) && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(u.hostname)
      && policy.allowedHosts.includes(u.hostname), 'REMOTE_URL_REJECTED');
    return u;
  } catch { throw new MediaError('REMOTE_URL_REJECTED'); }
}
