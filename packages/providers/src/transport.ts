import type {OpenRouterVideoOptions, ProviderCallOptions, ProviderProblem} from './types.ts';
import {problem} from './errors.ts';
import {MAX_REQUEST_BYTES} from './validation.ts';

const OFFICIAL_BASE = 'https://openrouter.ai/api/v1';
export interface HttpResult {ok: true; status: number; data: unknown}
export interface HttpFailure {ok: false; dispatched: boolean; error: ProviderProblem}

function limit(value: number | undefined, fallback: number, max: number, name: string): number {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < 1 || chosen > max) throw new RangeError(`${name} must be a positive integer within the adapter hard limit.`);
  return chosen;
}

export function createTransport(options: OpenRouterVideoOptions) {
  const baseUrl = options.baseUrl ?? OFFICIAL_BASE;
  if (baseUrl !== OFFICIAL_BASE) {
    if (!options.allowLoopbackHttpForTests || !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/api\/v1$/.test(baseUrl)) throw new TypeError('baseUrl must be the official OpenRouter API, or an explicitly enabled loopback HTTP fixture.');
    try { new URL(baseUrl); } catch { throw new TypeError('Invalid fixture baseUrl.'); }
  }
  if (typeof options.fetch !== 'function' || typeof options.getApiKey !== 'function') throw new TypeError('Inject server-side fetch and getApiKey functions.');
  const fetch = options.fetch;
  const getApiKey = options.getApiKey;
  const timeoutMs = limit(options.timeoutMs, 30000, 120000, 'timeoutMs');
  const maxResponseBytes = limit(options.maxResponseBytes, 1024 * 1024, 4 * 1024 * 1024, 'maxResponseBytes');
  const maxRequestBytes = limit(options.maxRequestBytes, MAX_REQUEST_BYTES, MAX_REQUEST_BYTES, 'maxRequestBytes');

  /** Exactly one HTTP call. No retries, polling loop, redirects, cookies, or logging. */
  async function request(path: string, method: 'GET' | 'POST', bodyJson: string | undefined, authenticated: boolean, call: ProviderCallOptions = {}): Promise<HttpResult | HttpFailure> {
    if (call.signal?.aborted) return {ok: false, dispatched: false, error: problem('provider_aborted', 'The operation was cancelled before dispatch.')};
    if (bodyJson !== undefined && Buffer.byteLength(bodyJson) > maxRequestBytes) return {ok: false, dispatched: false, error: problem('request_too_large', 'The reviewed request exceeds the configured byte limit.', 'edit_request')};
    const headers: Record<string, string> = {accept: 'application/json'};
    if (authenticated) {
      let key: unknown;
      try {key = getApiKey();} catch {key = undefined;}
      if (typeof key !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(key)) return {ok: false, dispatched: false, error: problem('provider_authentication_required', 'A valid server-side OpenRouter credential is not configured.', 'configure_provider')};
      headers.authorization = `Bearer ${key}`;
    }
    if (bodyJson !== undefined) headers['content-type'] = 'application/json';
    const controller = new AbortController();
    let failureCode = 'provider_transport_error';
    let dispatched = false;
    let status: number | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: (reason: Error) => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {rejectAbort = reject;});
    const stop = (code: string) => {
      failureCode = code;
      controller.abort();
      rejectAbort(new Error(code));
    };
    const onAbort = () => stop('provider_aborted');
    call.signal?.addEventListener('abort', onAbort, {once: true});
    // Keep the timer alive: even an injected fetch which ignores AbortSignal must settle the caller.
    timer = setTimeout(() => stop('provider_timeout'), timeoutMs);
    const race = <T>(work: Promise<T>): Promise<T> => Promise.race([work, stopped]);
    try {
      if (call.signal?.aborted) {
        failureCode = 'provider_aborted';
        throw new Error(failureCode);
      }
      dispatched = true;
      const response = await race(Promise.resolve(fetch(`${baseUrl}${path}`, {
        method, headers, ...(bodyJson !== undefined ? {body: bodyJson} : {}), redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
      })));
      status = response.status;
      const length = response.headers.get('content-length');
      if (length && /^\d+$/.test(length) && Number(length) > maxResponseBytes) {
        void response.body?.cancel().catch(() => {});
        failureCode = 'provider_response_too_large';
        throw new Error(failureCode);
      }
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        while (true) {
          const {done, value} = await race(reader.read());
          if (done) break;
          size += value.byteLength;
          if (size > maxResponseBytes) {
            failureCode = 'provider_response_too_large';
            throw new Error(failureCode);
          }
          chunks.push(value);
        }
      }
      const text = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, size));
      let data: unknown;
      try {data = JSON.parse(text);} catch {
        failureCode = 'provider_invalid_response';
        throw new Error(failureCode);
      }
      return {ok: true, status, data};
    } catch {
      controller.abort();
      const message = failureCode === 'provider_timeout'
        ? 'OpenRouter did not finish responding before the deadline.'
        : failureCode === 'provider_response_too_large'
          ? 'OpenRouter returned a response exceeding the configured byte limit.'
          : failureCode === 'provider_invalid_response'
            ? 'OpenRouter did not return valid JSON.'
            : failureCode === 'provider_aborted'
              ? 'The operation was cancelled.'
              : 'OpenRouter could not be reached reliably, or the response could not be read safely.';
      return {ok: false, dispatched, error: problem(failureCode, `${message} ${method === 'POST' && dispatched ? 'Acceptance is unknown; hold this attempt and do not automatically resubmit.' : 'Keep any existing job receipt.'}`, method === 'GET' ? 'check_status' : 'hold', status, method === 'GET')};
    } finally {
      clearTimeout(timer);
      call.signal?.removeEventListener('abort', onAbort);
      if (reader) {
        void reader.cancel().catch(() => {});
        try {reader.releaseLock();} catch { /* Pending readers are aborted above. */ }
      }
    }
  }
  return {request, baseUrl};
}
export type Transport = ReturnType<typeof createTransport>;
