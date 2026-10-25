/**
 * Image-authoring provider contracts: compile exactly one reference-conditioned request,
 * validate output bytes, and describe availability only from injected capability facts.
 * Never reads environment, URLs, files or media storage.
 */
import { createHash } from 'node:crypto';

export const IMAGE_MIME_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp'] as const);
export type ImageMime = typeof IMAGE_MIME_TYPES[number];
export const MAX_IMAGE_PROMPT_CHARS = 8000;
export const MAX_IMAGE_REFERENCE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_RESULT_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_RESULT_PIXELS = 40_000_000;

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ASPECT = /^\d{1,2}:\d{1,2}$/;
const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

export class ImageValidationError extends Error {
  readonly code: string;
  constructor(code: string, message = 'The image request is not valid and was not compiled.') {
    super(message);
    this.name = 'ImageValidationError';
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: object, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export interface ImageReference {
  /** Project-owned asset identity; never a URL. */
  assetId: string;
  sha256: string;
  mimeType: ImageMime;
  bytes: Uint8Array;
}
export interface ImageIntent {
  prompt: string;
  modelId: string;
  aspectRatio: string;
  reference: ImageReference | null;
}
export interface CompiledImageRequest {
  provider: 'openrouter';
  modelId: string;
  body: Readonly<{
    model: string;
    messages: readonly [Readonly<{
      role: 'user';
      content: readonly ({ readonly type: 'text'; readonly text: string }
        | { readonly type: 'image_url'; readonly image_url: Readonly<{ url: string }> })[];
    }>];
    modalities: readonly ['image', 'text'];
    image_config: Readonly<{ aspect_ratio: string }>;
  }>;
  bodyJson: string;
  bodySha256: string;
}
export interface ImageCapability {
  modelId: string;
  name?: string;
  aspectRatios?: readonly string[];
  /** Explicit availability as configured by the server; never inferred from catalog presence. */
  availability: 'available' | 'blocked' | 'unknown';
  blocker: string | null;
}
export interface ImageProviderProblem {
  code: string;
  message: string;
  retryable: boolean;
  httpStatus: number | null;
  providerCode: string | null;
  nextAction: 'edit_request' | 'configure_provider' | 'hold' | 'check_status';
}
export interface InspectedImage {
  mimeType: ImageMime;
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
}
export interface AcceptedImage extends InspectedImage {
  bytes: Uint8Array;
}
export interface ImageReceipt {
  provider: 'openrouter';
  providerModelId: string;
  /** Provider response/generation id when the response carried one; never invented. */
  providerReceiptId: string | null;
  bodySha256: string;
  costUsd: string | null;
}
export type ImageSubmitResult =
  | { status: 'accepted'; receipt: ImageReceipt; image: AcceptedImage }
  | { status: 'blocked' | 'failed' | 'acceptance_unknown'; error: ImageProviderProblem };
export interface PreparedImageRequest {
  envelope: { provider: 'openrouter'; modelId: string; body: string; bodySha256: string } | null;
  requestHash: string;
  estimateUsd: string | null;
  blockers: { code: string; message: string }[];
}
export interface ImageProviderPort {
  capabilities(): Promise<ImageCapability[]>;
  /** Compile only: no upload, no credential read, no network. */
  prepare(intent: ImageIntent): Promise<PreparedImageRequest>;
  /** Exactly one HTTP request. Never retries, never resends an unknown acceptance. */
  submit(request: { provider: 'openrouter'; modelId: string; body: string; bodySha256: string }, call?: { signal?: AbortSignal }): Promise<ImageSubmitResult>;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateReference(reference: ImageReference) {
  if (!isRecord(reference) || !exactKeys(reference, ['assetId', 'sha256', 'mimeType', 'bytes'])) throw new ImageValidationError('invalid_reference', 'A reference must be an owned asset identity with verified bytes, not a URL.');
  if (typeof reference.assetId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(reference.assetId)) throw new ImageValidationError('invalid_reference');
  if (typeof reference.sha256 !== 'string' || !SHA256.test(reference.sha256)) throw new ImageValidationError('invalid_reference_hash');
  if (!IMAGE_MIME_TYPES.includes(reference.mimeType)) throw new ImageValidationError('unsupported_reference_mime');
  if (!(reference.bytes instanceof Uint8Array) || reference.bytes.byteLength === 0) throw new ImageValidationError('missing_reference_bytes');
  if (reference.bytes.byteLength > MAX_IMAGE_REFERENCE_BYTES) throw new ImageValidationError('reference_too_large');
  if (sha256Bytes(reference.bytes) !== reference.sha256) throw new ImageValidationError('reference_integrity_mismatch');
  const inspected = inspectImageBytes(reference.bytes, reference.mimeType);
  if (inspected.mimeType !== reference.mimeType) throw new ImageValidationError('unsupported_reference_mime');
}

export function validateImageIntent(intent: ImageIntent): ImageValidationError[] {
  const issues: ImageValidationError[] = [];
  if (!isRecord(intent) || !exactKeys(intent, ['prompt', 'modelId', 'aspectRatio', 'reference'])) return [new ImageValidationError('invalid_intent')];
  if (typeof intent.prompt !== 'string' || intent.prompt.length === 0 || intent.prompt.length > MAX_IMAGE_PROMPT_CHARS || intent.prompt.trim().length === 0) issues.push(new ImageValidationError('invalid_prompt'));
  if (typeof intent.modelId !== 'string' || !MODEL_ID.test(intent.modelId)) issues.push(new ImageValidationError('invalid_model_id'));
  if (typeof intent.aspectRatio !== 'string' || !ASPECT.test(intent.aspectRatio)) issues.push(new ImageValidationError('invalid_aspect_ratio'));
  if (intent.reference !== null) {
    try { validateReference(intent.reference); }
    catch (error) { if (error instanceof ImageValidationError) issues.push(error); else throw error; }
  }
  return issues;
}

export function compileImageRequest(intent: ImageIntent): CompiledImageRequest {
  const issues = validateImageIntent(intent);
  if (issues.length > 0) throw issues[0]!;
  const reference = intent.reference;
  const content: ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] = [{ type: 'text', text: intent.prompt }];
  if (reference) {
    const url = `data:${reference.mimeType};base64,${Buffer.from(reference.bytes).toString('base64')}`;
    content.push({ type: 'image_url', image_url: Object.freeze({ url }) });
  }
  const body = Object.freeze({
    model: intent.modelId,
    messages: Object.freeze([Object.freeze({ role: 'user' as const, content: Object.freeze(content.map(part => Object.freeze(part))) })]) as CompiledImageRequest['body']['messages'],
    modalities: Object.freeze(['image', 'text']) as unknown as readonly ['image', 'text'],
    image_config: Object.freeze({ aspect_ratio: intent.aspectRatio }),
  });
  const bodyJson = JSON.stringify(body);
  return Object.freeze({ provider: 'openrouter' as const, modelId: intent.modelId, body, bodyJson, bodySha256: sha256Bytes(Buffer.from(bodyJson, 'utf8')) });
}

/** Structural identity + integrity check for a persisted envelope. Never repairs bytes or hashes. */
export function isCompiledImageRequest(value: unknown): value is CompiledImageRequest {
  if (!isRecord(value) || value.provider !== 'openrouter' || typeof value.modelId !== 'string' || !MODEL_ID.test(value.modelId)) return false;
  if (typeof value.body !== 'string' || typeof value.bodySha256 !== 'string' || !SHA256.test(value.bodySha256)) return false;
  return sha256Bytes(Buffer.from(value.body, 'utf8')) === value.bodySha256;
}

/** Bounded, magic-byte-driven inspection. File identity and decoded identity are both checked. */
export function inspectImageBytes(bytes: Uint8Array, expectedMime?: ImageMime): InspectedImage {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new ImageValidationError('invalid_image_bytes');
  if (bytes.byteLength > MAX_IMAGE_RESULT_BYTES) throw new ImageValidationError('image_too_large');
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let mimeType: ImageMime;
  let width: number;
  let height: number;
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') {
    if (buffer.toString('ascii', 12, 16) !== 'IHDR') throw new ImageValidationError('invalid_image_bytes');
    mimeType = 'image/png';
    width = buffer.readUInt32BE(16);
    height = buffer.readUInt32BE(20);
  } else if (buffer.length >= 12 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    mimeType = 'image/jpeg';
    let found: { width: number; height: number } | null = null;
    for (let offset = 2; offset + 9 < buffer.length && offset < 1024 * 1024; offset++) {
      if (buffer[offset] !== 0xff) continue;
      const marker = buffer[offset + 1]!;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        found = { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        break;
      }
    }
    if (!found) throw new ImageValidationError('invalid_image_bytes');
    ({ width, height } = found);
  } else if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    mimeType = 'image/webp';
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      width = 1 + buffer.readUIntLE(24, 3);
      height = 1 + buffer.readUIntLE(27, 3);
    } else if (chunk === 'VP8 ') {
      if (buffer.length < 30) throw new ImageValidationError('invalid_image_bytes');
      width = buffer.readUInt16LE(26) & 0x3fff;
      height = buffer.readUInt16LE(28) & 0x3fff;
    } else if (chunk === 'VP8L') {
      if (buffer.length < 25 || buffer[20] !== 0x2f) throw new ImageValidationError('invalid_image_bytes');
      const bits = buffer.readUInt32LE(21);
      width = 1 + (bits & 0x3fff);
      height = 1 + ((bits >>> 14) & 0x3fff);
    } else throw new ImageValidationError('invalid_image_bytes');
  } else throw new ImageValidationError('unsupported_image_format');
  if (expectedMime !== undefined && mimeType !== expectedMime) throw new ImageValidationError('image_mime_mismatch');
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > MAX_IMAGE_RESULT_PIXELS) {
    throw new ImageValidationError('invalid_image_dimensions');
  }
  return Object.freeze({ mimeType, width, height, byteSize: bytes.byteLength, sha256: sha256Bytes(bytes) });
}

/** Only inline image data URLs returned by the provider are accepted; remote locations are refused. */
export function decodeInlineImage(value: unknown): { mimeType: ImageMime; bytes: Uint8Array } {
  if (typeof value !== 'string') throw new ImageValidationError('missing_inline_image');
  if (value.length > Math.ceil(MAX_IMAGE_RESULT_BYTES * 4 / 3) + 256) throw new ImageValidationError('image_too_large');
  const match = DATA_URL.exec(value);
  if (!match) throw new ImageValidationError('unsupported_image_location');
  const mimeType = match[1] as ImageMime;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(match[2]!) || match[2]!.length % 4 !== 0) throw new ImageValidationError('invalid_inline_image');
  const bytes = new Uint8Array(Buffer.from(match[2]!, 'base64'));
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_RESULT_BYTES) throw new ImageValidationError('image_too_large');
  return { mimeType, bytes };
}

export function problem(code: string, message: string, nextAction: ImageProviderProblem['nextAction'] = 'hold', httpStatus: number | null = null, retryable = false): ImageProviderProblem {
  return { code, message, retryable, httpStatus, providerCode: null, nextAction };
}

/** Fixed, secret-free operator messages. Raw provider payloads are never surfaced. */
export function normalizeImageProviderError(httpStatus: number, operation: 'submit' | 'read' = 'submit'): { status: 'blocked' | 'failed' | 'acceptance_unknown'; error: ImageProviderProblem } {
  const known: Record<number, [string, string, ImageProviderProblem['nextAction'], 'blocked' | 'failed']> = {
    400: ['provider_invalid_request', 'OpenRouter rejected the image parameters. Preserve the draft and review its controls.', 'edit_request', 'failed'],
    401: ['provider_authentication_required', 'OpenRouter did not accept the configured server credential. Check server configuration; no request was retried.', 'configure_provider', 'blocked'],
    402: ['provider_payment_required', 'OpenRouter rejected the request because funding is required. No automatic retry was made.', 'configure_provider', 'blocked'],
    403: ['provider_access_denied', 'OpenRouter denied this request. Account access or policy needs review; catalog presence does not prove entitlement.', 'configure_provider', 'blocked'],
    404: ['provider_unavailable', 'OpenRouter could not route this image model. Catalog presence does not prove account access. No fallback was attempted.', 'configure_provider', 'blocked'],
    413: ['provider_request_too_large', 'OpenRouter rejected the request size. Prepare a smaller reference and review again.', 'edit_request', 'failed'],
    422: ['provider_invalid_request', 'OpenRouter rejected the image parameters. Preserve the draft and review its controls.', 'edit_request', 'failed'],
    415: ['provider_invalid_request', 'OpenRouter rejected the image parameters. Preserve the draft and review its controls.', 'edit_request', 'failed'],
    429: ['provider_rate_limited', 'OpenRouter rate-limited the request. No automatic retry was made.', 'hold', 'blocked'],
  };
  const entry = known[httpStatus];
  if (entry) return { status: entry[3], error: problem(entry[0], entry[1], entry[2], httpStatus, operation === 'read' && httpStatus === 429) };
  if (operation === 'submit') return { status: 'acceptance_unknown', error: problem('provider_acceptance_unknown', 'OpenRouter did not return a reliable acceptance receipt. The request may have been accepted. Hold this review; do not submit it again automatically.', 'hold', httpStatus) };
  return { status: 'failed', error: problem('provider_status_unavailable', 'OpenRouter could not return a reliable read response. Keep the existing receipt.', 'check_status', httpStatus, httpStatus >= 500) };
}
