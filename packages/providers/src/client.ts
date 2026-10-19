import type {CompiledVideoRequest, DiscoveryResult, OpenRouterVideoOptions, OpenRouterVideoPort, ProviderCallOptions, SubmitResult, VideoReceipt, VideoStatusResult} from './types.ts';
import {normalizeOpenRouterError, problem, videoPrivacyBlocker} from './errors.ts';
import {isCompiledRequest} from './compile.ts';
import {isJobId, isModelId, isRecord} from './validation.ts';
import {createTransport} from './transport.ts';
import {readVideoCatalog} from './catalog.ts';
import {isReceipt, normalizeVideoStatus} from './status.ts';
import {createContentReader} from './content.ts';
import {verifyPriorJob, isPriorJobVerificationReference, type CatalogCanonicalIdentity} from './verification.ts';

export function createOpenRouterVideoProvider(options: OpenRouterVideoOptions): OpenRouterVideoPort {
  const transport = createTransport(options);
  const zdrRequired = options.zdrRequired === true;
  const privacyBlockedModelIds = [...(options.privacyBlockedModelIds ?? [])];
  if (privacyBlockedModelIds.length > 1000 || !privacyBlockedModelIds.every(isModelId)) throw new TypeError('privacyBlockedModelIds must contain literal model identifiers.');
  // Snapshot the optional prior-job pointer so a caller cannot retarget it mid-discovery.
  // Invalid shapes are passed through untouched so verification refuses them; never repaired.
  const configuredReference = options.verificationReference;
  const verificationReference = configuredReference === undefined ? undefined
    : isPriorJobVerificationReference(configuredReference)
      ? {modelId: configuredReference.modelId, jobId: configuredReference.jobId}
      : configuredReference;
  return {
    readContent: createContentReader(options, transport.baseUrl),
    async discoverModels(call: ProviderCallOptions = {}): Promise<DiscoveryResult> {
      const response = await transport.request('/videos/models', 'GET', undefined, false, call);
      if (!response.ok) return {status: 'unavailable', error: response.error};
      if (response.status < 200 || response.status >= 300) return {status: 'unavailable', error: normalizeOpenRouterError(response.status, response.data, 'read').error};
      try {
        const capabilities = readVideoCatalog(response.data, {zdrRequired, privacyBlockedModelIds});
        // The reader has validated the entire JSON catalog, including exact, unique IDs.
        // Preserve every SKU (also malformed/unknown units), never a priced subset.
        const models = (response.data as {data: Record<string, unknown>[]}).data;
        const pricing = models.map(model => ({provider: 'openrouter' as const, modelId: model.id as string,
          currency: 'USD' as const, pricingSkus: model.pricing_skus ?? null}));
        // Resolve optional prior-job evidence from this same catalog observation. Never POST,
        // never retry, and never infer availability for any other model.
        const verification = verificationReference === undefined ? undefined
          : await verifyPriorJob(transport, verificationReference,
            models.map((model): CatalogCanonicalIdentity => ({modelId: model.id as string, canonicalSlug: model.canonical_slug})),
            {zdrRequired, privacyBlockedModelIds}, call);
        return {status: 'ok', capabilities, pricing, ...(verification ? {verification} : {})};
      }
      catch {return {status: 'unavailable', error: problem('provider_invalid_catalog', 'The public video catalog is malformed or incomplete. No model availability was inferred.')};}
    },
    async submit(request: CompiledVideoRequest, call: ProviderCallOptions = {}): Promise<SubmitResult> {
      if (!isCompiledRequest(request)) return {status: 'failed', error: problem('request_integrity_mismatch', 'The persisted provider envelope no longer matches its reviewed bytes and hash. Prepare and review again.', 'edit_request')};
      if (zdrRequired || privacyBlockedModelIds.includes(request.modelId)) return {status: 'blocked', error: videoPrivacyBlocker()};
      // Freeze receipt identity before yielding; a mutable deserialized review cannot change it in flight.
      const {modelId, bodySha256, bodyJson} = request;
      const response = await transport.request('/videos', 'POST', bodyJson, true, call);
      if (!response.ok) return {status: response.dispatched ? 'acceptance_unknown' : response.error.code === 'provider_authentication_required' ? 'blocked' : 'failed', error: response.error};
      if (response.status < 200 || response.status >= 300) return normalizeOpenRouterError(response.status, response.data);
      if (!isRecord(response.data) || !isJobId(response.data.id)) return {status: 'acceptance_unknown', error: problem('provider_invalid_response', 'OpenRouter responded without a usable job receipt. Hold this attempt; do not automatically resubmit.', 'hold', response.status)};
      const receipt: VideoReceipt = {provider: 'openrouter', modelId, jobId: response.data.id, bodySha256};
      if (response.data.model !== undefined && response.data.model !== null && response.data.model !== modelId) return {
        status: 'failed', receipt,
        error: problem('provider_model_mismatch', 'An accepted job reported a different model than the reviewed request. Retain its receipt and hold for investigation; do not submit a replacement automatically.', 'hold', response.status),
      };
      return {status: 'accepted', receipt};
    },
    async status(accepted: VideoReceipt, call: ProviderCallOptions = {}): Promise<VideoStatusResult> {
      if (!isReceipt(accepted)) return {status: 'status_unavailable', receipt: null, error: problem('invalid_provider_receipt', 'A literal persisted OpenRouter job receipt is required. Job IDs cannot be repaired or inferred.')};
      const receipt: VideoReceipt = {provider: 'openrouter', modelId: accepted.modelId, jobId: accepted.jobId, bodySha256: accepted.bodySha256};
      const response = await transport.request(`/videos/${receipt.jobId}`, 'GET', undefined, true, call);
      if (!response.ok) return {status: 'status_unavailable', receipt, error: response.error};
      if (response.status < 200 || response.status >= 300) {
        const error = response.status === 404
          ? problem('provider_job_unavailable', 'OpenRouter could not locate the accepted job. Its receipt is retained; a missing status response is not permission to submit again.', 'hold', 404)
          : normalizeOpenRouterError(response.status, response.data, 'read').error;
        return {status: 'status_unavailable', receipt, error};
      }
      return normalizeVideoStatus(response.data, receipt, transport.baseUrl);
    },
  };
}
