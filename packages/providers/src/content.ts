import type {OpenRouterVideoOptions, ProviderCallOptions, RemoteVideoOutput, VideoContent, VideoContentResult, VideoReceipt} from './types.ts';
import {problem} from './errors.ts';
import {isReceipt} from './status.ts';
import {isJobId, isRecord} from './validation.ts';

function isOutput(value: unknown): value is RemoteVideoOutput {
  return isRecord(value) && Object.keys(value).sort().join(',') === 'index,jobId,kind'
    && value.kind === 'openrouter_content' && isJobId(value.jobId)
    && typeof value.index === 'number' && Number.isSafeInteger(value.index) && !Object.is(value.index, -0)
    && value.index >= 0 && value.index <= 7;
}

/** baseUrl comes only from the already-validated JSON transport configuration. */
export function createContentReader(options: OpenRouterVideoOptions, baseUrl: string) {
  const {fetch, getApiKey} = options;
  const maxContentBytes = options.maxContentBytes ?? 512 * 1024 * 1024;
  if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes < 1 || maxContentBytes > 512 * 1024 * 1024) throw new RangeError('maxContentBytes must be a positive integer at most 512 MiB.');
  const timeoutMs = options.contentTimeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new RangeError('contentTimeoutMs must be a positive integer at most 120000.');
  return async function readContent<T>(accepted: VideoReceipt, descriptor: RemoteVideoOutput,
    consume: (content: VideoContent) => Promise<T>, call: ProviderCallOptions = {}): Promise<VideoContentResult<T>> {
    // Capture identities before yielding; the descriptor is not an arbitrary fetch target.
    const receipt: VideoReceipt | null = isReceipt(accepted)
      ? {provider: 'openrouter', modelId: accepted.modelId, jobId: accepted.jobId, bodySha256: accepted.bodySha256} : null;
    const output: RemoteVideoOutput | null = isOutput(descriptor)
      ? {kind: 'openrouter_content', jobId: descriptor.jobId, index: descriptor.index} : null;
    const signal = call.signal;
    let httpStatus: number | null = null;
    const failure = (code: string): VideoContentResult<T> => ({status: 'content_unavailable', receipt, output,
      error: problem(code, 'Video content could not be imported safely. Keep the accepted receipt and output identity; do not submit a replacement generation.', code === 'provider_authentication_required' ? 'configure_provider' : 'hold', httpStatus)});
    if (!receipt) return failure('invalid_provider_receipt');
    if (!output || output.jobId !== receipt.jobId) return failure('invalid_provider_output');
    if (typeof consume !== 'function') return failure('invalid_content_consumer');
    if (signal?.aborted) return failure('provider_aborted');
    let key: unknown;
    try {key = getApiKey();} catch {key = undefined;}
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(key)) return failure('provider_authentication_required');
    const controller = new AbortController();
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let failureCode = 'provider_content_read_error';
    let interrupted = false;
    let active = true;
    let complete = false;
    let rejectStop: (error: Error) => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {rejectStop = reject;});
    void stopped.catch(() => {});
    const stop = (code: string) => {
      if (interrupted) return;
      interrupted = true;
      failureCode = code;
      controller.abort();
      rejectStop(new Error(code));
    };
    const onAbort = () => stop('provider_aborted');
    signal?.addEventListener('abort', onAbort, {once: true});
    const timer = setTimeout(() => stop('provider_timeout'), timeoutMs);
    const race = <V>(work: Promise<V>): Promise<V> => Promise.race([work, stopped]);
    try {
      if (signal?.aborted) {stop('provider_aborted'); return failure(failureCode);}
      response = await race<Response>(fetch(`${baseUrl}/videos/${receipt.jobId}/content?index=${output.index}`, {
        method: 'GET', headers: {authorization: `Bearer ${key}`, accept: 'video/mp4', 'accept-encoding': 'identity'},
        redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal,
      }).then(async received => {
        if (!active) {
          await received.body?.cancel().catch(() => {});
          throw new Error('provider_content_closed');
        }
        return received;
      }));
      httpStatus = response.status;
      if (response.status !== 200) return failure('provider_content_http_error');
      const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (mime !== 'video/mp4') return failure('provider_content_type_invalid');
      const encoding = response.headers.get('content-encoding');
      if (encoding !== null && encoding.toLowerCase() !== 'identity') return failure('provider_content_encoding_invalid');
      const length = response.headers.get('content-length');
      if (length !== null) {
        if (!/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length))) return failure('provider_content_length_invalid');
        if (Number(length) > maxContentBytes) return failure('provider_content_too_large');
        if (Number(length) === 0) return failure('provider_content_empty');
      }
      reader = response.body?.getReader();
      if (!reader) return failure('provider_content_empty');
      const body = (async function* () {
        let size = 0;
        while (true) {
          if (!active) throw new Error('provider_content_closed');
          if (interrupted) throw new Error(failureCode);
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {chunk = await race(reader!.read());}
          catch {stop('provider_content_read_error'); throw new Error(failureCode);}
          const {done, value} = chunk;
          if (done) {
            if (size === 0) {stop('provider_content_empty'); throw new Error(failureCode);}
            if (length !== null && size !== Number(length)) {stop('provider_content_length_invalid'); throw new Error(failureCode);}
            complete = true;
            clearTimeout(timer);
            return;
          }
          size += value.byteLength;
          if (size > maxContentBytes) {
            stop('provider_content_too_large');
            throw new Error(failureCode);
          }
          yield value;
        }
      })();
      const value = await consume({mimeType: 'video/mp4', body, signal: controller.signal});
      if (interrupted) return failure(failureCode);
      if (!complete) return failure('provider_content_incomplete');
      return {status: 'read', receipt, output, value};
    } catch {
      return failure(failureCode);
    } finally {
      active = false;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      controller.abort();
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      } else await response?.body?.cancel().catch(() => {});
    }
  };
}
