import type { ReviewBlocker } from './types.ts';

export const PRIVACY_BLOCK = 'Your account requires providers not to retain your data (the zero-data-retention privacy setting). This model has no compatible route available. Your privacy setting has not been changed.';

/**
 * The published setup documentation the coordinator verified (HTTP 200). It is
 * the only external destination this build offers: no settings route is invented
 * and no provider is enabled by following it.
 */
export const PROVIDER_SETUP_DOC = {
  href: 'https://github.com/pkidwell22/Flume/blob/main/docs/DOCKER.md',
  label: 'Read the setup guide for provider access',
} as const;


export function blockerText(blocker: ReviewBlocker): string {
  const code = typeof blocker === 'string' ? blocker : blocker.code;
  return /zdr[-_]violation[-_]by[-_]account|zero.data.retention/i.test(code)
    ? PRIVACY_BLOCK
    : typeof blocker === 'string' ? blocker : blocker.message;
}

export interface BlockerGuidance {
  /** Plain statement of what is unavailable. */
  explanation: string;
  /** One concrete thing the user can do, using only surfaces that exist. */
  nextStep: string;
  /** A real documentation destination for access problems, or null when a link would not help. */
  help: { href: string; label: string } | null;
  /** The exact server code and message, kept verbatim as secondary diagnostics. */
  detail: { code: string | null; message: string };
}

const VERIFY_HINT = 'Choose a model whose route is verified in the shot editor, or ask whoever runs this Flume build to confirm that the provider account can use this model.';

/**
 * Server blockers are accurate but speak in catalog vocabulary. This restates the
 * same fact for a person and names a next step that exists. It never relaxes the
 * block: approval, generation and spending guards are unchanged.
 */
export function blockerGuidance(blocker: ReviewBlocker): BlockerGuidance {
  const code = typeof blocker === 'string' ? blocker : blocker.code;
  const message = typeof blocker === 'string' ? blocker : blocker.message;
  const detail = { code: typeof blocker === 'string' ? null : code, message };
  if (/zdr[-_]violation[-_]by[-_]account|zero.data.retention/i.test(code))
    return {
      explanation: PRIVACY_BLOCK,
      nextStep: 'Ask whoever runs this Flume build to review this model’s retention decision, or choose a model with a compatible route. Nothing was sent.',
      help: null,
      detail,
    };
  if (/entitlement|access[-_ ]denied|provider_access/i.test(`${code} ${message}`))
    return {
      explanation:
        'This build can’t confirm that the provider account is allowed to use this model. The model is listed, but listing it does not prove access. This blocked review does not submit a generation request.',
      nextStep: `${VERIFY_HINT} Editing and saving still work while you decide.`,
      help: PROVIDER_SETUP_DOC,
      detail,
    };
  if (/unavailable|not[-_ ]found|route/i.test(code))
    return {
      explanation: 'This build can’t reach a provider route for this model right now. This blocked review does not submit a generation request.',
      nextStep: `${VERIFY_HINT} Editing and saving still work while you decide.`,
      help: PROVIDER_SETUP_DOC,
      detail,
    };
  return {
    explanation: 'This request can’t be generated as prepared. This blocked review does not submit a generation request.',
    nextStep: 'Change the settings or frames named here in the shot editor, then prepare a new review. Editing and saving still work.',
    help: null,
    detail,
  };
}

/**
 * Readable money for display only. Trims padding zeros without rounding, so a
 * genuinely sub-cent estimate keeps its precision and the exact provider string
 * still governs the request and the spending limit.
 */
export function formatUsd(amount: string): string {
  if (!/^\d+(?:\.\d+)?$/.test(amount)) return amount;
  const [whole, fraction = ''] = amount.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  if (trimmed.length <= 2) return `${whole}.${trimmed.padEnd(2, '0')}`;
  return `${whole}.${trimmed}`;
}
