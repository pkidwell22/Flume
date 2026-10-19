import type {
  PriorJobVerification, PriorJobVerificationFailureReason, PriorJobVerificationReference,
  ProviderCallOptions, ProviderProblem, VideoPrivacyPolicy,
} from './types.ts';
import type {Transport} from './transport.ts';
import {normalizeOpenRouterError, problem} from './errors.ts';
import {isJobId, isModelId, isRecord} from './validation.ts';

/** Catalog identity observed in the same public catalog read that produced capabilities. */
export interface CatalogCanonicalIdentity {
  readonly modelId: string;
  readonly canonicalSlug: unknown;
}

/**
 * Accept only the literal two-field server-injected reference. Values are never trimmed,
 * case-folded or suffix-stripped: a job id or model id must be exactly what was observed.
 */
export function isPriorJobVerificationReference(value: unknown): value is PriorJobVerificationReference {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && keys.every(key => key === 'modelId' || key === 'jobId') &&
    isModelId(value.modelId) && isJobId(value.jobId);
}

function failure(reason: PriorJobVerificationFailureReason, error: ProviderProblem | null = null): PriorJobVerification {
  return {status: 'unverified', reason, error};
}

/**
 * Read-only evidence resolution for exactly one previously completed job.
 *
 * No submission, retry, polling loop, redirect, alternate model, alias repair or catalog
 * entitlement inference occurs here. A failure of any read or identity check yields
 * `unverified`, never a weaker "probably accepted" route. Signed URLs in the job payload
 * are ignored so they cannot be retained or logged.
 */
export async function verifyPriorJob(
  transport: Transport,
  reference: unknown,
  catalog: readonly CatalogCanonicalIdentity[],
  policy: VideoPrivacyPolicy,
  call: ProviderCallOptions = {},
): Promise<PriorJobVerification> {
  if (!isPriorJobVerificationReference(reference)) return failure('invalid_reference');
  const modelId = reference.modelId;
  const jobId = reference.jobId;
  if (policy.zdrRequired === true || policy.privacyBlockedModelIds?.includes(modelId) === true) {
    return failure('privacy_blocked');
  }
  const matches = catalog.filter(entry => entry.modelId === modelId);
  if (matches.length !== 1) return failure('model_not_catalogued');
  const canonicalModelId = matches[0]!.canonicalSlug;
  if (!isModelId(canonicalModelId)) return failure('canonical_identity_missing');
  // A canonical slug shared by more than one catalog alias cannot prove which requested
  // route produced the job. Refuse the ambiguity instead of choosing an alias.
  if (catalog.filter(entry => entry.canonicalSlug === canonicalModelId).length !== 1) {
    return failure('canonical_identity_ambiguous');
  }

  const jobResponse = await transport.request(`/videos/${encodeURIComponent(jobId)}`, 'GET', undefined, true, call);
  if (!jobResponse.ok) {
    return failure(jobResponse.error.code === 'provider_authentication_required' ? 'credentials_missing' : 'job_unavailable', jobResponse.error);
  }
  if (jobResponse.status < 200 || jobResponse.status >= 300) {
    return failure('job_unavailable', normalizeOpenRouterError(jobResponse.status, jobResponse.data, 'read').error);
  }
  const job = jobResponse.data;
  if (!isRecord(job) || job.id !== jobId) {
    return failure('job_identity_mismatch', problem('provider_job_identity_mismatch',
      'The prior job response did not identify the exact configured job. No route was verified.', 'hold', jobResponse.status));
  }
  if (job.status !== 'completed') {
    return failure('job_not_completed', problem('provider_job_not_completed',
      'The prior job is not completed under its exact identity. No route was verified.', 'hold', jobResponse.status));
  }
  const generationId = job.generation_id;
  if (!isJobId(generationId)) {
    return failure('generation_identity_mismatch', problem('provider_generation_identity_mismatch',
      'The prior job did not expose an exact generation identifier. No route was verified.', 'hold', jobResponse.status));
  }

  const generationResponse = await transport.request(`/generation?id=${encodeURIComponent(generationId)}`, 'GET', undefined, true, call);
  if (!generationResponse.ok) {
    return failure(generationResponse.error.code === 'provider_authentication_required' ? 'credentials_missing' : 'generation_unavailable', generationResponse.error);
  }
  if (generationResponse.status < 200 || generationResponse.status >= 300) {
    return failure('generation_unavailable', normalizeOpenRouterError(generationResponse.status, generationResponse.data, 'read').error);
  }
  // The generation-details endpoint wraps its record in {data: ...}; unlike
  // /videos/{id}, its top-level JSON object is not itself the identity record.
  const envelope = generationResponse.data;
  const generation = isRecord(envelope) ? envelope.data : undefined;
  if (!isRecord(generation) || generation.id !== generationId) {
    return failure('generation_identity_mismatch', problem('provider_generation_identity_mismatch',
      'The generation response did not identify the exact generation from the prior job. No route was verified.', 'hold', generationResponse.status));
  }
  if (generation.cancelled !== undefined && generation.cancelled !== false) {
    return failure('generation_not_successful', problem('provider_generation_not_successful',
      'The prior generation is not a successful completed generation. No route was verified.', 'hold', generationResponse.status));
  }
  if (generation.model !== canonicalModelId) {
    return failure('canonical_model_mismatch', problem('provider_canonical_model_mismatch',
      'The prior generation model does not exactly match the catalog canonical identity. No alias or suffix repair was attempted.', 'hold', generationResponse.status));
  }
  return {status: 'verified', modelId, jobId, generationId, canonicalModelId};
}
