/**
 * OpenRouter image-generation adapter. Server-injected fetch + credential provider only.
 * One request per submit, no retries/polling/redirects/logging; response bytes are bounded and
 * every returned image is inspected (magic, mime, dimensions, sha256) before acceptance.
 */
import {
  IMAGE_MIME_TYPES, MAX_IMAGE_RESULT_BYTES, compileImageRequest, compileNativeImageRequest, decodeBase64Image, decodeInlineImage,
  inspectImageBytes, isCompiledImageRequest, isImageAuthoringTransport, normalizeImageProviderError, problem,
  readFrozenImageBody, sha256Bytes,
  type AcceptedImage, type ImageAuthoringTransport, type ImageCapability, type ImageIntent, type ImageMime,
  type ImageProviderProblem, type ImageProviderPort,
} from './image-generation.ts';

const OFFICIAL_BASE = 'https://openrouter.ai/api/v1';
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/;
const MONEY = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/;
const RECEIPT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const isRecord = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);

export interface OpenRouterImageOptions {
  /** Supplied only by server configuration. Never read from environment here. */
  getApiKey: () => string | undefined;
  fetch: typeof globalThis.fetch;
  baseUrl?: string;
  allowLoopbackHttpForTests?: boolean;
  /** Explicit availability facts; absent entries mean unknown, never available. */
  models?: readonly ImageCapability[];
  /** Optional server-supplied estimate in USD. Absence means unknown (null), never zero. */
  estimateUsd?: (intent: ImageIntent) => string | null;
  /**
   * Compile-time wire route. Defaults to the historical chat-completions body. `images` selects the
   * native OpenRouter Image API. This only decides how new requests are compiled; submitted
   * envelopes are routed by their own frozen body.
   */
  transport?: ImageAuthoringTransport;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const ENDPOINTS = Object.freeze({ 'chat-completions': '/chat/completions', images: '/images' } as const);
const NATIVE_ITEM_KEYS = ['b64_json', 'media_type'] as const;
const itemKeysAreNative = (value: object) =>
  Object.keys(value).every(key => (NATIVE_ITEM_KEYS as readonly string[]).includes(key)) && Object.hasOwn(value, 'b64_json');

function limit(value: number | undefined, fallback: number, max: number, name: string): number {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < 1 || chosen > max) throw new RangeError(`${name} must be a positive integer within the adapter hard limit.`);
  return chosen;
}

function normalizeMoney(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value >= 1e9) return null;
    const text = String(value);
    return MONEY.test(text) ? text : null;
  }
  if (typeof value === 'string' && MONEY.test(value)) return value;
  return null;
}

function capabilityBlockers(intent: ImageIntent, models: readonly ImageCapability[]): ImageProviderProblem[] {
  const capability = models.find(model => model.modelId === intent.modelId);
  if (!capability) return [problem('model_unavailable', 'This image model is not configured as available on this server. No capability was inferred.', 'configure_provider')];
  if (capability.availability === 'blocked') return [problem('provider_blocked', 'The configured image route is blocked for this account. Editing remains available.', 'configure_provider')];
  if (capability.availability !== 'available') return [problem('model_availability_unknown', 'Image model availability is not confirmed. Nothing was submitted.', 'check_status')];
  if (capability.aspectRatios && !capability.aspectRatios.includes(intent.aspectRatio)) {
    return [problem('unsupported_aspect_ratio', 'The selected image model does not declare this aspect ratio. Choose a supported ratio and review again.', 'edit_request')];
  }
  return [];
}

export function createOpenRouterImageProvider(options: OpenRouterImageOptions): ImageProviderPort {
  const baseUrl = options.baseUrl ?? OFFICIAL_BASE;
  if (baseUrl !== OFFICIAL_BASE) {
    if (!options.allowLoopbackHttpForTests || !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/api\/v1$/.test(baseUrl)) {
      throw new TypeError('baseUrl must be the official OpenRouter API, or an explicitly enabled loopback HTTP fixture.');
    }
    try { new URL(baseUrl); } catch { throw new TypeError('Invalid fixture baseUrl.'); }
  }
  if (typeof options.fetch !== 'function' || typeof options.getApiKey !== 'function') throw new TypeError('Inject server-side fetch and getApiKey functions.');
  const models = [...(options.models ?? [])];
  if (models.length > 500 || !models.every(model => isRecord(model) && typeof model.modelId === 'string' && MODEL_ID.test(model.modelId))) {
    throw new TypeError('models must contain literal image model identifiers.');
  }
  const timeoutMs = limit(options.timeoutMs, 60000, 120000, 'timeoutMs');
  const maxResponseBytes = limit(options.maxResponseBytes, 48 * 1024 * 1024, 64 * 1024 * 1024, 'maxResponseBytes');
  const transport = options.transport === undefined ? 'chat-completions' : options.transport;
  if (!isImageAuthoringTransport(transport)) throw new TypeError('transport must be chat-completions or images.');
  const frozenModels = Object.freeze(models.map(model => Object.freeze({ ...model })));

  async function post(path: (typeof ENDPOINTS)[ImageAuthoringTransport], bodyJson: string, call: { signal?: AbortSignal } = {}): Promise<
    | { ok: true; status: number; data: unknown }
    | { ok: false; dispatched: boolean; error: ImageProviderProblem }
  > {
    if (call.signal?.aborted) return { ok: false, dispatched: false, error: problem('provider_aborted', 'The operation was cancelled before dispatch.') };
    let key: unknown;
    try { key = options.getApiKey(); } catch { key = undefined; }
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(key)) {
      return { ok: false, dispatched: false, error: problem('provider_authentication_required', 'A valid server-side OpenRouter credential is not configured.', 'configure_provider') };
    }
    const controller = new AbortController();
    let dispatched = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: (code: 'provider_timeout' | 'provider_aborted' | 'provider_response_too_large') => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {
      stop = code => { failure = code; controller.abort(); reject(new Error(code)); };
    });
    let failure: string = 'provider_transport_error';
    const onAbort = () => stop('provider_aborted');
    call.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop('provider_timeout'), timeoutMs);
    const race = <T>(work: Promise<T>): Promise<T> => Promise.race([work, stopped]);
    try {
      dispatched = true;
      const response = await race(Promise.resolve(options.fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: bodyJson, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
      })));
      const status = response.status;
      const declared = response.headers?.get?.('content-length');
      if (declared && /^\d+$/.test(declared) && Number(declared) > maxResponseBytes) {
        void response.body?.cancel().catch(() => {});
        stop('provider_response_too_large');
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        while (true) {
          const { done, value } = await race(reader.read());
          if (done) break;
          size += value.byteLength;
          if (size > maxResponseBytes) { void reader.cancel().catch(() => {}); stop('provider_response_too_large'); }
          chunks.push(value);
        }
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
      let data: unknown;
      try { data = JSON.parse(text); } catch { return { ok: true, status, data: undefined }; }
      return { ok: true, status, data };
    } catch {
      const message = failure === 'provider_timeout'
        ? 'OpenRouter did not finish responding before the deadline. Acceptance is unknown; do not automatically resubmit.'
        : failure === 'provider_response_too_large'
          ? 'OpenRouter returned a response exceeding the configured byte limit. Acceptance is unknown; do not automatically resubmit.'
          : failure === 'provider_aborted'
            ? 'The operation was cancelled. If the request had been dispatched, acceptance is unknown.'
            : 'OpenRouter could not be reached reliably. If the request had been dispatched, acceptance is unknown; do not automatically resubmit.';
      return { ok: false, dispatched, error: problem(failure, message, 'hold') };
    } finally {
      clearTimeout(timer);
      call.signal?.removeEventListener('abort', onAbort);
    }
  }

  function receiptOf(data: Record<string, any>, modelId: string, bodySha256: string) {
    const receiptId = typeof data.id === 'string' && RECEIPT.test(data.id) ? data.id : null;
    const cost = isRecord(data.usage) ? normalizeMoney(data.usage.cost) : null;
    return { provider: 'openrouter' as const, providerModelId: modelId, providerReceiptId: receiptId, bodySha256, costUsd: cost };
  }

  function extractImage(data: unknown, modelId: string, bodySha256: string): { status: 'accepted'; receipt: { provider: 'openrouter'; providerModelId: string; providerReceiptId: string | null; bodySha256: string; costUsd: string | null }; image: AcceptedImage } | { status: 'failed'; error: ImageProviderProblem } {
    if (!isRecord(data)) return { status: 'failed', error: problem('provider_invalid_response', 'OpenRouter responded without a readable image result. No image was accepted.', 'hold') };
    if (data.model !== undefined && data.model !== null && data.model !== modelId) {
      return { status: 'failed', error: problem('provider_model_mismatch', 'The provider reported a different model than the reviewed request. No image was accepted; hold for investigation.', 'hold') };
    }
    const choices = data.choices;
    if (!Array.isArray(choices) || choices.length !== 1 || !isRecord(choices[0])) {
      return { status: 'failed', error: problem('provider_invalid_output', 'OpenRouter did not return exactly one image choice. No image was accepted.', 'hold') };
    }
    const images = isRecord(choices[0].message) ? choices[0].message.images : undefined;
    if (!Array.isArray(images) || images.length !== 1) {
      return { status: 'failed', error: problem(images && images.length > 1 ? 'provider_ambiguous_output' : 'provider_invalid_output', 'OpenRouter did not return exactly one inline image. No image was accepted or auto-selected.', 'hold') };
    }
    const part = images[0];
    // The documented ChatAssistantImages item is `{image_url: {url}}` with no `type`. A missing type
    // is accepted; an explicitly different type is not.
    const url = isRecord(part) && (part.type === undefined || part.type === 'image_url') && isRecord(part.image_url) ? part.image_url.url : undefined;
    let decoded: { mimeType: typeof IMAGE_MIME_TYPES[number]; bytes: Uint8Array };
    try { decoded = decodeInlineImage(url); } catch { return { status: 'failed', error: problem('provider_output_invalid', 'OpenRouter returned an image outside the accepted inline PNG/JPEG/WebP bounds. No image was accepted.', 'hold') }; }
    let inspected: AcceptedImage;
    try { inspected = { ...inspectImageBytes(decoded.bytes, decoded.mimeType), bytes: decoded.bytes }; }
    catch { return { status: 'failed', error: problem('provider_output_invalid', 'OpenRouter returned image bytes that failed integrity inspection. No image was accepted.', 'hold') }; }
    return { status: 'accepted', receipt: receiptOf(data, modelId, bodySha256), image: inspected };
  }

  /**
   * Native Image API response: `{created, data: [{b64_json, media_type?}], usage: {cost?}}`.
   * Exactly one PNG is accepted, matching the frozen output_format; multiple outputs are never
   * auto-selected. Magic bytes must identify PNG even when media_type is absent, and a present
   * media_type must also be image/png. A response without id
   * yields a null receipt id rather than an invented one.
   */
  function extractNativeImage(data: unknown, modelId: string, bodySha256: string): { status: 'accepted'; receipt: { provider: 'openrouter'; providerModelId: string; providerReceiptId: string | null; bodySha256: string; costUsd: string | null }; image: AcceptedImage } | { status: 'failed'; error: ImageProviderProblem } {
    if (!isRecord(data)) return { status: 'failed', error: problem('provider_invalid_response', 'OpenRouter responded without a readable image result. No image was accepted.', 'hold') };
    if (data.model !== undefined && data.model !== null && data.model !== modelId) {
      return { status: 'failed', error: problem('provider_model_mismatch', 'The provider reported a different model than the reviewed request. No image was accepted; hold for investigation.', 'hold') };
    }
    const items = data.data;
    if (!Array.isArray(items) || items.length !== 1) {
      return { status: 'failed', error: problem(items && items.length > 1 ? 'provider_ambiguous_output' : 'provider_invalid_output', 'OpenRouter did not return exactly one inline image. No image was accepted or auto-selected.', 'hold') };
    }
    const item = items[0];
    if (!isRecord(item) || !itemKeysAreNative(item)) {
      return { status: 'failed', error: problem('provider_output_invalid', 'OpenRouter returned an image outside the accepted inline PNG/JPEG/WebP bounds. No image was accepted.', 'hold') };
    }
    const mediaType = item.media_type;
    if (mediaType !== undefined && mediaType !== 'image/png') {
      return { status: 'failed', error: problem('provider_output_invalid', 'OpenRouter returned an image outside the accepted inline PNG/JPEG/WebP bounds. No image was accepted.', 'hold') };
    }
    let decoded: { mimeType: ImageMime; bytes: Uint8Array };
    try { decoded = decodeBase64Image(item.b64_json, 'image/png'); }
    catch { return { status: 'failed', error: problem('provider_output_invalid', 'OpenRouter returned an image outside the accepted inline PNG/JPEG/WebP bounds. No image was accepted.', 'hold') }; }
    let inspected: AcceptedImage;
    try { inspected = { ...inspectImageBytes(decoded.bytes, decoded.mimeType), bytes: decoded.bytes }; }
    catch { return { status: 'failed', error: problem('provider_output_invalid', 'OpenRouter returned image bytes that failed integrity inspection. No image was accepted.', 'hold') }; }
    return { status: 'accepted', receipt: receiptOf(data, modelId, bodySha256), image: inspected };
  }

  return {
    async capabilities() { return frozenModels.map(model => ({ ...model })); },
    async prepare(intent: ImageIntent) {
      const compiled = transport === 'images' ? compileNativeImageRequest(intent) : compileImageRequest(intent);
      const blockers = capabilityBlockers(intent, frozenModels);
      let estimateUsd: string | null = null;
      if (blockers.length === 0 && options.estimateUsd) {
        try { estimateUsd = normalizeMoney(options.estimateUsd(intent)); } catch { estimateUsd = null; }
      }
      return {
        envelope: blockers.length === 0 ? { provider: 'openrouter', modelId: compiled.modelId, body: compiled.bodyJson, bodySha256: compiled.bodySha256 } : null,
        requestHash: compiled.bodySha256,
        estimateUsd,
        blockers: blockers.map(({ code, message }) => ({ code, message })),
      };
    },
    async submit(request, call = {}) {
      if (!isCompiledImageRequest(request)) {
        return { status: 'failed', error: problem('request_integrity_mismatch', 'The persisted request no longer matches its reviewed bytes and hash. Prepare and review again.', 'edit_request') };
      }
      // Freeze identity before yielding so a mutable deserialized object cannot change it in flight.
      const modelId = request.modelId;
      const body = request.body;
      const bodySha256 = request.bodySha256;
      // Route by the frozen body, never by the current configuration: a historical envelope keeps
      // its historical endpoint after an operator switches the server to another transport.
      let frozen: ReturnType<typeof readFrozenImageBody>;
      try { frozen = readFrozenImageBody(body); }
      catch { return { status: 'failed', error: problem('request_shape_invalid', 'The persisted request is not a recognized image request. Prepare and review again.', 'edit_request') }; }
      if (frozen.model !== modelId) {
        return { status: 'failed', error: problem('request_model_mismatch', 'The persisted request names a different model than the reviewed request. Prepare and review again.', 'edit_request') };
      }
      const response = await post(ENDPOINTS[frozen.transport], body, call);
      if (!response.ok) {
        return { status: response.dispatched ? 'acceptance_unknown' : 'blocked', error: response.error };
      }
      if (response.status < 200 || response.status >= 300) {
        const normalized = normalizeImageProviderError(response.status);
        return { status: normalized.status, error: normalized.error };
      }
      if (response.data === undefined) {
        return { status: 'acceptance_unknown', error: problem('provider_invalid_response', 'OpenRouter accepted the request but returned unreadable JSON. Hold this review; do not automatically resubmit.', 'hold', response.status) };
      }
      const extracted = frozen.transport === 'images'
        ? extractNativeImage(response.data, modelId, bodySha256)
        : extractImage(response.data, modelId, bodySha256);
      if (extracted.status !== 'accepted') return extracted;
      return { status: 'accepted', receipt: { ...extracted.receipt, bodySha256 }, image: extracted.image };
    },
  };
}
