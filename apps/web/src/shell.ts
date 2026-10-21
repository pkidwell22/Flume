import type { Asset } from './types.ts';

export function ownedMediaUrl(asset: Asset, origin = typeof window === 'undefined' ? 'http://flume.local' : window.location.origin): string | undefined {
  // Media comes from the owned API, never directly from a provider or arbitrary URL.
  try { const url = new URL(asset.mediaUrl, origin); return url.origin === origin && !url.username && !url.password && url.pathname.startsWith('/api/media/') ? `${url.pathname}${url.search}` : undefined; }
  catch { return undefined; }
}
export function originLabel(asset: Asset) { return asset.origin === 'sample' ? 'Sample media' : asset.origin === 'imported' ? 'Imported media' : 'Generated media'; }

/** Return focus only to a still-eligible opener, and never over a newer destination. */
export function restoreOpener(opener: Element | null, surface: HTMLElement) {
  const active = document.activeElement;
  if (opener instanceof HTMLElement && opener.isConnected && !opener.matches(':disabled, [aria-disabled="true"]') && !opener.closest('[inert], [hidden]') && opener.getClientRects().length && getComputedStyle(opener).visibility === 'visible' && !document.querySelector('dialog[open]') && (active === document.body || surface.contains(active))) opener.focus();
}
