import type {CompiledVideoRequest, VideoCapability} from './types.ts';
import {isCompiledRequest} from './compile.ts';
import {isModelId, isRecord} from './validation.ts';

/** Explicitly scoped, plain catalog data, not a provider quote or billing limit.
 * Supply the COMPLETE pricing_skus map as pricingSkus; do not prefilter unknown units.
 */
export interface H3VideoPricingMetadata {
  readonly provider: 'openrouter';
  readonly modelId: string;
  readonly currency: 'USD';
  readonly pricingSkus: Readonly<Record<string, string>>;
}
export interface H3VideoEstimateLineItem {
  readonly sku: 'duration_seconds' | 'reference_images';
  readonly quantity: number;
  readonly unitPriceUsd: string;
  readonly estimatedCostUsd: string;
}
export type H3VideoEstimateUnknownReason =
  | 'invalid_request' | 'invalid_capability' | 'model_mismatch' | 'unsupported_controls'
  | 'invalid_pricing' | 'missing_pricing_sku' | 'unsupported_pricing_units' | 'estimate_out_of_range';
export type H3VideoCostEstimate = {
  readonly status: 'unknown';
  readonly estimatedCostUsd: null;
  readonly reason: H3VideoEstimateUnknownReason;
} | {
  readonly status: 'estimated';
  readonly provider: 'openrouter';
  readonly modelId: 'minimax/hailuo-3';
  readonly currency: 'USD';
  readonly bodySha256: string;
  readonly estimatedCostUsd: string;
  readonly basis: 'catalog_pricing_skus';
  readonly label: 'Catalog-based estimate; not a quote or provider-enforced spend cap.';
  readonly providerEnforcedSpendCap: false;
  readonly lineItems: readonly H3VideoEstimateLineItem[];
};

const H3 = 'minimax/hailuo-3';
const SCALE = 1_000_000n;
const MAX_MICROS = 999_999_999_999_999n;
// The domain/server USD grammar: at most 9 whole and 6 fractional digits.
// Require the whole literal match too: JS `$` alone accepts a trailing newline.
const MONEY_USD = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/;
const isMoney = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 16 && MONEY_USD.exec(value)?.[0] === value;
const unknown = (reason: H3VideoEstimateUnknownReason): H3VideoCostEstimate =>
  ({status: 'unknown', estimatedCostUsd: null, reason});

function dataRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return typeof key === 'string' && descriptor.enumerable && 'value' in descriptor;
  });
}

function list(value: unknown, valid: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.length <= 256 &&
    [...value].every(valid) && new Set(value).size === value.length;
}
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
function isCapability(value: unknown): value is VideoCapability {
  return dataRecord(value) && isModelId(value.modelId) && text(value.name) &&
    Object.keys(value).every(key => ['modelId', 'name', 'durations', 'resolutions', 'aspectRatios',
      'frameRoles', 'seedSupported', 'generateAudioSupported', 'availability', 'blocker'].includes(key)) &&
    list(value.durations, v => typeof v === 'number' && Number.isSafeInteger(v) && v > 0) &&
    list(value.resolutions, text) && list(value.aspectRatios, text) &&
    list(value.frameRoles, v => v === 'first_frame' || v === 'last_frame') &&
    typeof value.seedSupported === 'boolean' && typeof value.generateAudioSupported === 'boolean' &&
    ['available', 'blocked', 'unknown'].includes(value.availability as string) &&
    (value.blocker === null || typeof value.blocker === 'string');
}

function micros(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(6, '0'));
}
function usd(value: bigint): string {
  const fraction = (value % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return `${value / SCALE}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Pure, single-request estimate using explicit USD/unit metadata and exact wire inputs.
 * Rates are never defaulted, rounded, fetched or inferred from a different model.
 * Unknown is deliberately not zero. Even a known estimate grants no approval,
 * account entitlement, retention-policy exception or provider-enforced spend cap.
 */
export function estimateH3VideoCost(request: CompiledVideoRequest, capability: VideoCapability,
  pricing: H3VideoPricingMetadata): H3VideoCostEstimate {
  if (!isCompiledRequest(request) || request.body.prompt.length === 0 ||
    Buffer.byteLength(request.body.prompt) > 65536) return unknown('invalid_request');
  if (!isCapability(capability)) return unknown('invalid_capability');
  if (request.modelId !== H3 || capability.modelId !== H3) return unknown('model_mismatch');
  const body = request.body;
  // This profile understands only H3 2K landscape, 5-15 integer seconds, no audio/seed.
  // Catalog support for other controls does not establish their pricing semantics.
  if (body.duration < 5 || body.duration > 15 || !capability.durations.includes(body.duration) ||
    body.resolution !== '2K' || !capability.resolutions.includes(body.resolution) ||
    body.aspect_ratio !== '16:9' || !capability.aspectRatios.includes(body.aspect_ratio) ||
    body.generate_audio !== false || Object.hasOwn(body, 'seed')) return unknown('unsupported_controls');
  const frameImages = body.frame_images ?? [];
  if (frameImages.some(frame => !capability.frameRoles.includes(frame.frame_type)) ||
    (frameImages.length === 1 && frameImages[0]!.frame_type === 'last_frame')) return unknown('unsupported_controls');
  if (!dataRecord(pricing) || pricing.provider !== 'openrouter' || pricing.currency !== 'USD' ||
    typeof pricing.modelId !== 'string' ||
    Object.keys(pricing).some(key => !['provider', 'modelId', 'currency', 'pricingSkus'].includes(key)) ||
    !dataRecord(pricing.pricingSkus)) return unknown('invalid_pricing');
  if (pricing.modelId !== H3) return unknown('model_mismatch');
  const quantities = [body.duration, frameImages.length];
  const skus = ['duration_seconds', 'reference_images'] as const;
  if (Object.keys(pricing.pricingSkus).some(key => !(skus as readonly string[]).includes(key))) return unknown('unsupported_pricing_units');
  if (skus.some((sku, i) => quantities[i]! > 0 && !Object.hasOwn(pricing.pricingSkus, sku))) return unknown('missing_pricing_sku');
  if (Object.values(pricing.pricingSkus).some(value => !isMoney(value))) return unknown('invalid_pricing');
  let total = 0n;
  const lineItems: H3VideoEstimateLineItem[] = [];
  for (const [index, sku] of skus.entries()) {
    const quantity = quantities[index]!;
    if (quantity === 0) continue;
    const unitPriceUsd = pricing.pricingSkus[sku]!;
    const cost = micros(unitPriceUsd) * BigInt(quantity);
    total += cost;
    lineItems.push({sku, quantity, unitPriceUsd, estimatedCostUsd: usd(cost)});
  }
  if (total > MAX_MICROS) return unknown('estimate_out_of_range');
  return {
    status: 'estimated', provider: 'openrouter', modelId: 'minimax/hailuo-3', currency: 'USD',
    bodySha256: request.bodySha256, estimatedCostUsd: usd(total), basis: 'catalog_pricing_skus',
    label: 'Catalog-based estimate; not a quote or provider-enforced spend cap.',
    providerEnforcedSpendCap: false, lineItems,
  };
}
