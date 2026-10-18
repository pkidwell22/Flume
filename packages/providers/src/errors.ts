import type {ProviderProblem} from './types.ts';
import {isRecord} from './validation.ts';

export const VIDEO_PRIVACY_MESSAGE = 'OpenRouter video generation is unavailable while Zero Data Retention is required: asynchronous video jobs temporarily retain output. Keep editing; generation needs a separately reviewed privacy-compatible route. Retrying this request or switching OpenRouter video models will not resolve that requirement.';

export function videoPrivacyBlocker(httpStatus: number | null = null, providerCode: string | null = null, excludedEndpointCount?: number): ProviderProblem {
  return {
    code: 'provider_privacy_blocked', message: VIDEO_PRIVACY_MESSAGE, retryable: false,
    httpStatus, providerCode, nextAction: 'resolve_privacy_route',
    ...(excludedEndpointCount !== undefined ? {excludedEndpointCount} : {}),
  };
}

/** Inspect only bounded metadata; never expose raw errors, prompts, URLs or secrets. */
export function detectPrivacyRejection(value: unknown): {code: string; count?: number} | null {
  const queue: {value: unknown; depth: number}[] = [{value, depth: 0}];
  const pattern = /\bzdr-violation-by-(?:account|guardrail|request)\b/;
  for (let i = 0; i < queue.length && i < 4096; i++) {
    const item = queue[i]!;
    if (typeof item.value === 'string') {
      const match = pattern.exec(item.value);
      if (match) return {code: match[0]};
    }
    if (item.depth >= 8 || !item.value || typeof item.value !== 'object') continue;
    if (isRecord(item.value)) {
      for (const [key, child] of Object.entries(item.value)) {
        const match = pattern.exec(key) ?? (typeof child === 'string' ? pattern.exec(child) : null);
        if (match) {
          const count = Number.isSafeInteger(child) && (child as number) >= 0 ? child as number : item.value.count;
          return {code: match[0], ...(typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? {count} : {})};
        }
      }
    }
    for (const child of Object.values(item.value).slice(0, 128)) queue.push({value: child, depth: item.depth + 1});
  }
  return null;
}

export function problem(code: string, message: string, nextAction: ProviderProblem['nextAction'] = 'hold', httpStatus: number | null = null, retryable = false): ProviderProblem {
  return {code, message, retryable, httpStatus, providerCode: null, nextAction};
}

export function normalizeOpenRouterError(httpStatus: number, payload: unknown, operation: 'submit' | 'read' = 'submit'): {status: 'blocked' | 'failed' | 'acceptance_unknown'; error: ProviderProblem} {
  const privacy = detectPrivacyRejection(payload);
  if (privacy) return {status: 'blocked', error: videoPrivacyBlocker(httpStatus, privacy.code, privacy.count)};
  const known: Record<number, [string, string, ProviderProblem['nextAction'], 'blocked' | 'failed']> = {
    400: ['provider_invalid_request', 'OpenRouter rejected the video parameters. Preserve the draft and review its controls.', 'edit_request', 'failed'],
    401: ['provider_authentication_required', 'OpenRouter did not accept the configured server credential. Check server configuration; no request was retried.', 'configure_provider', 'blocked'],
    402: ['provider_payment_required', 'OpenRouter rejected the request because funding is required. No automatic retry was made.', 'configure_provider', 'blocked'],
    403: ['provider_access_denied', 'OpenRouter denied this request. Account access or policy needs review; catalog presence does not prove entitlement.', 'configure_provider', 'blocked'],
    404: ['provider_unavailable', 'OpenRouter could not route or locate this request. Catalog presence does not prove account access. No fallback was attempted.', 'configure_provider', 'blocked'],
    413: ['provider_request_too_large', 'OpenRouter rejected the request size. Prepare smaller frame inputs and review again.', 'edit_request', 'failed'],
    422: ['provider_invalid_request', 'OpenRouter rejected the video parameters. Preserve the draft and review its controls.', 'edit_request', 'failed'],
    429: ['provider_rate_limited', 'OpenRouter rate-limited the request. No automatic retry was made.', 'hold', 'blocked'],
  };
  const entry = known[httpStatus];
  if (entry) return {status: entry[3], error: problem(entry[0], entry[1], entry[2], httpStatus, operation === 'read' && httpStatus === 429)};
  if (operation === 'submit') return {status: 'acceptance_unknown', error: problem('provider_acceptance_unknown', 'OpenRouter did not return a reliable acceptance receipt. The request may have been accepted. Hold this attempt; do not submit it again automatically.', 'hold', httpStatus)};
  return {status: 'failed', error: problem('provider_status_unavailable', 'OpenRouter could not return a reliable read response. Keep the existing receipt and check status later; do not submit a new generation.', 'check_status', httpStatus, httpStatus >= 500 || httpStatus === 408)};
}
