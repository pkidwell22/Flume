import type {ResolvedFrames, VideoCapability, VideoIntent} from './types.ts';

export interface ValidationIssue {code: string; field: string; message: string}
export class ProviderValidationError extends Error {
  readonly issues: readonly ValidationIssue[];
  constructor(issues: readonly ValidationIssue[]) {
    super('The video request cannot be sent as configured. Review the listed controls or frame bindings.');
    this.name = 'ProviderValidationError';
    this.issues = issues;
  }
}
export const MAX_REQUEST_BYTES = 50 * 1024 * 1024;
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const isModelId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(value);
export const isJobId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
export const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function isImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REQUEST_BYTES) return false;
  if (/^data:image\/(png|jpeg|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return value.indexOf(',') < value.length - 1;
  }
  if (!value.startsWith('https://') || /[\s\\\u0000-\u001f\u007f]/.test(value) || value.length > 16384) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

/** Capability metadata proves syntax only, never account entitlement. Drafts are never mutated. */
export function validateVideoIntent(intent: VideoIntent, capability: VideoCapability, frames: ResolvedFrames): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (field: string, message: string, code = 'unsupported_input') => issues.push({code, field, message});
  if (!isRecord(intent) || !isRecord(intent.controls) || !isRecord(intent.bindings) || !isRecord(frames)) {
    add('intent', 'Prompt, controls, bindings and resolved frame roles are required.', 'invalid_input');
    return issues;
  }
  if (!capability || !isModelId(capability.modelId)) {
    add('capability', 'A valid catalog capability is required.', 'invalid_capability');
    return issues;
  }
  const c = intent.controls;
  if (typeof intent.prompt !== 'string' || intent.prompt.length === 0 || Buffer.byteLength(intent.prompt) > 65536) add('prompt', 'Provide a prompt of at most 65536 UTF-8 bytes.');
  if (!isModelId(c.modelId) || c.modelId !== capability.modelId) add('controls.modelId', 'Use the exact reviewed model identifier and matching capability.');
  for (const key of Object.keys(c)) {
    if (!['modelId', 'durationSeconds', 'resolution', 'aspectRatio', 'generateAudio', 'seed'].includes(key)) add(`controls.${key}`, 'This adapter does not implement that control; it will not silently omit it.');
  }
  if (!Number.isSafeInteger(c.durationSeconds) || c.durationSeconds <= 0 || !capability.durations.includes(c.durationSeconds)) add('controls.durationSeconds', 'Choose a catalog-supported positive duration.');
  if (!capability.resolutions.includes(c.resolution)) add('controls.resolution', 'Use a catalog-supported resolution with exact spelling.');
  if (!capability.aspectRatios.includes(c.aspectRatio)) add('controls.aspectRatio', 'Use a catalog-supported aspect ratio.');
  if (typeof c.generateAudio !== 'boolean' || (c.generateAudio && !capability.generateAudioSupported)) add('controls.generateAudio', 'This audio setting is not supported by the selected model.');
  if (c.seed !== undefined && (!capability.seedSupported || !Number.isSafeInteger(c.seed) || Object.is(c.seed, -0))) add('controls.seed', 'The selected model must support the explicit integer seed.');
  for (const key of Object.keys(intent.bindings)) {
    if (!['firstFrameAssetId', 'lastFrameAssetId'].includes(key)) add(`bindings.${key}`, 'Unknown frame binding.');
  }
  for (const key of Object.keys(frames)) {
    if (!['firstFrame', 'lastFrame'].includes(key)) add(`frames.${key}`, 'Unknown resolved frame role.');
  }
  for (const [binding, frame, role] of [
    ['firstFrameAssetId', 'firstFrame', 'first_frame'],
    ['lastFrameAssetId', 'lastFrame', 'last_frame'],
  ] as const) {
    const id = intent.bindings[binding];
    const input = frames[frame];
    if (id === null && input === null) continue;
    if (typeof id !== 'string' || id.length === 0 || !isRecord(input) || input.assetId !== id) {
      add(`bindings.${binding}`, 'Resolve this exact asset in its declared frame role, or explicitly clear both binding and resolved input.', 'frame_binding_mismatch');
      continue;
    }
    if (!capability.frameRoles.includes(role)) add(`bindings.${binding}`, 'The selected model does not support this frame role.');
    if (!isImageUrl(input.url)) add(`frames.${frame}.url`, 'Use a prepared PNG/JPEG/WebP data URI or literal HTTPS URL without credentials.');
  }
  return issues;
}
