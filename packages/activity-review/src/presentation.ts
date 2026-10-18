import type { ReviewBlocker } from './types.ts';

export const PRIVACY_BLOCK = 'Your account requires providers not to retain your data (the zero-data-retention privacy setting). This model has no compatible route available. Your privacy setting has not been changed.';
export function blockerText(blocker: ReviewBlocker): string {
  const code = typeof blocker === 'string' ? blocker : blocker.code;
  return /zdr[-_]violation[-_]by[-_]account|zero.data.retention/i.test(code)
    ? PRIVACY_BLOCK
    : typeof blocker === 'string' ? blocker : blocker.message;
}
