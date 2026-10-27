/**
 * The one renderable-media rule for this package: same origin, no embedded
 * credentials and an /api/media/ path. Anything else is not owned project media
 * and must never reach an <img src>.
 *
 * It deliberately mirrors the approved web policy (`ownedMediaUrl` in
 * apps/web/src/shell.ts and `safeFrameMediaUrl` in
 * apps/web/src/frame-authoring-types.ts) because @flume/shot-editor cannot depend
 * on the web app. apps/web/test/owned-media-parity.test.tsx pins all three to the
 * same URL matrix so the copies cannot drift apart.
 */
export function ownedThumbnailUrl(
  mediaUrl: string | null | undefined,
  origin = typeof window === 'undefined' ? 'http://flume.local' : window.location.origin,
): string | undefined {
  if (typeof mediaUrl !== 'string' || mediaUrl === '') return undefined;
  try {
    const url = new URL(mediaUrl, origin);
    return url.origin === origin && !url.username && !url.password && url.pathname.startsWith('/api/media/')
      ? `${url.pathname}${url.search}`
      : undefined;
  } catch {
    return undefined;
  }
}
