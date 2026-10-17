import { Ajv } from 'ajv';
import { h3Document as document } from './sources.ts';
const input = document.paths['/v2/models/minimax/minimax-h3'].post.requestBody.content['application/json'].schema;
// OpenAPI 3.0 nullable is supported by Ajv. int64 is an annotation here;
// the documented seed bounds are tested separately in the semantic layer.
const ajv = new Ajv({ strict: false, allErrors: true, formats: { int64: true } });
const validate = ajv.compile({ ...input, components: document.components });

export type SemanticIssue = {
  code: string;
  basis: 'documented-prose' | 'local-policy' | 'unknown-capability';
};

type StructuralBody = {
  content: Record<string, unknown>[];
  duration: number;
  resolution: string;
  ratio?: string;
  seed?: number;
  [key: string]: unknown;
};

export function inspectRequest(body: unknown) {
  const valid = validate(body);
  const errors = (validate.errors ?? []).map(error => `${error.instancePath}: ${error.message}`);
  const issues: SemanticIssue[] = [];
  let documentedEffective: { ratio: string | undefined; resolution: string } | undefined;
  if (valid) {
    const request = body as StructuralBody;
    const outsideLane = Object.keys(request).some(key => !['content', 'duration', 'resolution', 'ratio', 'seed', 'aigc_watermark'].includes(key))
      || request.content.some(item => {
        if (item.type === 'text') return Object.keys(item).some(key => !['type', 'text'].includes(key));
        if (item.type !== 'image_url') return false; // Report modality separately.
        return Object.keys(item).some(key => !['type', 'role', 'image_url'].includes(key))
          || Object.keys((item.image_url ?? {}) as object).some(key => key !== 'url');
      });
    if (outsideLane) issues.push({ code: 'FIELD_NOT_IN_LANE', basis: 'local-policy' });
    const texts = request.content.filter(item => item.type === 'text');
    if (texts.length !== 1) issues.push({ code: 'TEXT_COUNT', basis: 'documented-prose' });
    if (texts.some(item => typeof item.text !== 'string' || item.text.trim() === '')) {
      issues.push({ code: 'TEXT_EMPTY', basis: 'local-policy' });
    }
    for (const item of request.content) {
      if (item.type === 'text') continue;
      if (item.type !== 'image_url') {
        issues.push({
          code: ['video_url', 'audio_url'].includes(String(item.type)) ? 'MODEL_MODALITY' : 'UNKNOWN_MODALITY',
          basis: ['video_url', 'audio_url'].includes(String(item.type)) ? 'documented-prose' : 'unknown-capability',
        });
        continue;
      }
      if (!['first_frame', 'last_frame', 'reference_image'].includes(String(item.role))) {
        issues.push({ code: 'UNKNOWN_ROLE', basis: 'unknown-capability' });
      }
      const source = item.image_url as { url?: string } | undefined;
      if (!source?.url?.trim()) issues.push({ code: 'IMAGE_SOURCE_EMPTY', basis: 'local-policy' });
    }
    const countRole = (role: string) => request.content.filter(item => item.type === 'image_url' && item.role === role).length;
    const firstCount = countRole('first_frame');
    const lastCount = countRole('last_frame');
    const referenceCount = countRole('reference_image');
    if ((firstCount || lastCount) && referenceCount) {
      issues.push({ code: 'FRAME_REFERENCE_CONFLICT', basis: 'documented-prose' });
    }
    if (firstCount > 1 || lastCount > 1) issues.push({ code: 'DUPLICATE_FRAME_ROLE', basis: 'local-policy' });
    // The public schema provides no maxItems or per-role count limit.
    // This experiment does not extrapolate a provider limit from one reference.
    if (referenceCount > 1) issues.push({ code: 'REFERENCE_LIMIT_UNKNOWN', basis: 'unknown-capability' });
    const hasFrames = firstCount > 0 || lastCount > 0;
    if (request.ratio !== undefined && !['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].includes(request.ratio)) {
      issues.push({ code: 'RATIO_OPTION', basis: 'documented-prose' });
    }
    if (!hasFrames && (request.ratio === undefined || request.ratio === 'adaptive')) {
      issues.push(referenceCount
        ? { code: 'REFERENCE_RATIO_UNKNOWN', basis: 'unknown-capability' }
        : { code: 'TEXT_RATIO_REQUIRED', basis: 'documented-prose' });
    }
    if (request.seed !== undefined && (request.seed < -1 || request.seed > 2 ** 32 - 1)) {
      issues.push({ code: 'SEED_RANGE', basis: 'documented-prose' });
    }
    documentedEffective = { ratio: hasFrames ? 'frame-determined' : request.ratio, resolution: request.resolution.toUpperCase() };
  }
  return {
    runtime: { status: 'not-run', accountEntitlement: 'unknown', estimate: 'unknown', mediaReadiness: 'unverified' } as const,
    documentedEffective,
    structural: { valid, errors },
    semantic: { status: !valid ? 'not-evaluated' : issues.length ? 'blocked' : 'pass', issues },
  };
}
