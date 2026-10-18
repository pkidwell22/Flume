import {createHash} from 'node:crypto';
import {isImageUrl, isModelId, isRecord, isSha256, MAX_REQUEST_BYTES, ProviderValidationError, validateVideoIntent} from './validation.ts';
import type {CompiledVideoRequest, ResolvedFrames, VideoBody, VideoCapability, VideoIntent} from './types.ts';

export const hashBody = (bodyJson: string): string => createHash('sha256').update(bodyJson, 'utf8').digest('hex');

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Pure compilation: no credential lookup, media upload or provider request. */
export function compileVideoRequest(intent: VideoIntent, capability: VideoCapability, frames: ResolvedFrames): CompiledVideoRequest {
  const issues = validateVideoIntent(intent, capability, frames);
  if (issues.length) throw new ProviderValidationError(issues);
  const c = intent.controls;
  const frameImages: NonNullable<VideoBody['frame_images']>[number][] = [];
  if (frames.firstFrame !== null) frameImages.push({type: 'image_url', image_url: {url: frames.firstFrame.url}, frame_type: 'first_frame'});
  if (frames.lastFrame !== null) frameImages.push({type: 'image_url', image_url: {url: frames.lastFrame.url}, frame_type: 'last_frame'});
  const body: VideoBody = {
    model: c.modelId, prompt: intent.prompt, duration: c.durationSeconds, resolution: c.resolution,
    aspect_ratio: c.aspectRatio, generate_audio: c.generateAudio,
    ...(c.seed !== undefined ? {seed: c.seed} : {}),

    ...(frameImages.length ? {frame_images: frameImages} : {}),
  };
  const bodyJson = JSON.stringify(body);
  if (Buffer.byteLength(bodyJson) > MAX_REQUEST_BYTES) throw new ProviderValidationError([{code: 'request_too_large', field: 'frames', message: 'The serialized video request exceeds 50 MiB.'}]);
  return freeze({provider: 'openrouter', modelId: c.modelId, body, bodyJson, bodySha256: hashBody(bodyJson)});
}

/** Recheck a persisted review envelope; hashing is integrity, not approval authority. */
export function isCompiledRequest(value: unknown): value is CompiledVideoRequest {
  try {
    if (!isRecord(value) || value.provider !== 'openrouter' || !isModelId(value.modelId) || !isSha256(value.bodySha256) || typeof value.bodyJson !== 'string' || Buffer.byteLength(value.bodyJson) > MAX_REQUEST_BYTES || !isRecord(value.body)) return false;
    const b = value.body;
    if (b.model !== value.modelId || typeof b.prompt !== 'string' || !Number.isSafeInteger(b.duration) || (b.duration as number) <= 0 || typeof b.resolution !== 'string' || typeof b.aspect_ratio !== 'string' || typeof b.generate_audio !== 'boolean') return false;
    if (Object.keys(b).some(key => !['model', 'prompt', 'duration', 'resolution', 'aspect_ratio', 'generate_audio', 'seed', 'frame_images'].includes(key))) return false;
    if (b.seed !== undefined && (!Number.isSafeInteger(b.seed) || Object.is(b.seed, -0))) return false;
    if (b.frame_images !== undefined) {
      if (!Array.isArray(b.frame_images) || b.frame_images.length < 1 || b.frame_images.length > 2) return false;
      const roles = new Set<string>();
      for (const f of b.frame_images) {
        if (!isRecord(f) || f.type !== 'image_url' || !isRecord(f.image_url) || !isImageUrl(f.image_url.url) || !['first_frame', 'last_frame'].includes(f.frame_type as string) || Object.keys(f).some(k => !['type', 'image_url', 'frame_type'].includes(k)) || Object.keys(f.image_url).some(k => k !== 'url')) return false;
        if (roles.has(f.frame_type as string)) return false;
        roles.add(f.frame_type as string);
      }
    }
    return JSON.stringify(b) === value.bodyJson && hashBody(value.bodyJson) === value.bodySha256;
  } catch { return false; }
}
