import type {FrameRole, VideoCapability, VideoPrivacyPolicy} from './types.ts';
import {VIDEO_PRIVACY_MESSAGE} from './errors.ts';
import {isModelId, isRecord, ProviderValidationError} from './validation.ts';

function invalid(): never {
  throw new ProviderValidationError([{code: 'provider_invalid_catalog', field: 'catalog', message: 'The video catalog is incomplete, malformed or contains duplicate model identifiers.'}]);
}
function list<T>(value: unknown, predicate: (entry: unknown) => entry is T): T[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256 || !value.every(predicate)) return invalid();
  if (new Set(value).size !== value.length) return invalid();
  return [...value];
}
const stringEntry = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;

/** Public metadata establishes controls, not availability for any account. */
export function readVideoCatalog(payload: unknown, policy: VideoPrivacyPolicy = {}): VideoCapability[] {
  if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length > 1000) return invalid();
  const seen = new Set<string>();
  return payload.data.map(model => {
    if (!isRecord(model) || !isModelId(model.id) || !stringEntry(model.name) || seen.has(model.id)) return invalid();
    seen.add(model.id);
    const privacyBlocked = policy.zdrRequired === true || policy.privacyBlockedModelIds?.includes(model.id) === true;
    for (const value of [model.seed, model.generate_audio]) if (value !== undefined && value !== null && typeof value !== 'boolean') return invalid();
    return {
      modelId: model.id,
      name: model.name,
      durations: list(model.supported_durations, (v): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0),
      resolutions: list(model.supported_resolutions, stringEntry),
      aspectRatios: list(model.supported_aspect_ratios, stringEntry),
      frameRoles: list(model.supported_frame_images, (v): v is FrameRole => v === 'first_frame' || v === 'last_frame'),
      seedSupported: model.seed === true,
      generateAudioSupported: model.generate_audio === true,
      availability: privacyBlocked ? 'blocked' : 'unknown',
      blocker: privacyBlocked ? VIDEO_PRIVACY_MESSAGE : null,
    };
  });
}
