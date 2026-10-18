import type {RemoteVideoOutput, VideoReceipt, VideoStatusResult} from './types.ts';
import {detectPrivacyRejection, problem, videoPrivacyBlocker} from './errors.ts';
import {isJobId, isModelId, isRecord, isSha256} from './validation.ts';

export function isReceipt(value: unknown): value is VideoReceipt {
  return isRecord(value) && value.provider === 'openrouter' && isModelId(value.modelId) && isJobId(value.jobId) && isSha256(value.bodySha256);
}

/** Discard URLs from the response in favor of exact validated content identities. */
function outputIdentities(value: unknown, receipt: VideoReceipt, baseUrl: string): RemoteVideoOutput[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return null;
  const outputs: RemoteVideoOutput[] = [];
  const indices = new Set<number>();
  const base = new URL(baseUrl);
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length > 16384 || /[\s\\\u0000-\u001f\u007f]/.test(entry)) return null;
    let url: URL;
    try {url = new URL(entry, base.origin);} catch {return null;}
    const params = [...url.searchParams];
    if (url.origin !== base.origin || url.username || url.password || url.hash || url.pathname !== `${base.pathname}/videos/${receipt.jobId}/content` || params.length > 1) return null;
    if (params.length && (params[0]![0] !== 'index' || !/^(0|[1-9][0-9]*)$/.test(params[0]![1]))) return null;
    const index = Number(url.searchParams.get('index') ?? '0');
    if (!Number.isSafeInteger(index) || index > 7 || indices.has(index)) return null;
    indices.add(index);
    outputs.push({kind: 'openrouter_content', jobId: receipt.jobId, index});
  }
  return outputs;
}

export function normalizeVideoStatus(payload: unknown, receipt: VideoReceipt, baseUrl: string): VideoStatusResult {
  const unavailable = (code: string, message: string): VideoStatusResult => ({status: 'status_unavailable', receipt, error: problem(code, message)});
  if (!isRecord(payload) || payload.id !== receipt.jobId) return unavailable('provider_receipt_mismatch', 'The status response does not match the exact accepted job. Keep the receipt and investigate; do not resubmit.');
  if (payload.model !== undefined && payload.model !== null && payload.model !== receipt.modelId) return unavailable('provider_model_mismatch', 'OpenRouter reported a different model than the reviewed request. Hold the accepted job for investigation; no fallback is allowed.');
  const status = payload.status;
  if (status === 'pending' || status === 'in_progress') return {status: status === 'pending' ? 'queued' : 'running', providerStatus: status, receipt};
  if (status === 'failed' || status === 'cancelled' || status === 'expired') {
    const privacy = detectPrivacyRejection(payload.error);
    return {
      status: privacy ? 'blocked' : 'failed', providerStatus: status, receipt,
      error: privacy ? videoPrivacyBlocker(null, privacy.code, privacy.count) : problem(`provider_job_${status}`, `The accepted OpenRouter video job ${status}. No replacement generation was submitted.`),
    };
  }
  if (status !== 'completed') return unavailable('provider_unknown_status', 'OpenRouter returned an unrecognized job status. Keep the receipt; do not infer completion or submit again.');
  const outputs = outputIdentities(payload.unsigned_urls, receipt, baseUrl);
  if (!outputs) return unavailable('provider_outputs_unavailable', 'The completed job has no safely identified outputs. Keep its receipt; no local take is available yet.');
  const cost = isRecord(payload.usage) ? payload.usage.cost : null;
  const costUsd = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? String(cost) : null;
  // Completion is not ownership. Only the worker/media import may publish a ready take.
  return {status: 'retrieving', providerStatus: 'completed', receipt, outputs, costUsd};
}
