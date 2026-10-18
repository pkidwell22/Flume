import type { ReviewAsset, ReviewShot, ReviewTake } from './types';
export function ownedMediaUrl(asset: ReviewAsset): string | null {
  // Asset presence is the server's ownership assertion; never fall back to provider URLs.
  if (!asset.id || asset.id === '.' || asset.id === '..') return null;
  try {
    const expected = `/api/media/${encodeURIComponent(asset.id)}`;
    return asset.mediaUrl === expected ? expected : null;
  } catch {
    return null; // Invalid Unicode must not crash a workspace render.
  }
}

export type TakeMedia = { status: 'ready'; asset: ReviewAsset; url: string } | { status: 'unavailable'; reason: string };
export function getTakeMedia(shot: ReviewShot, take: ReviewTake, assets: readonly ReviewAsset[]): TakeMedia {
  if (take.projectId !== shot.projectId || take.shotId !== shot.id) {
    return {status:'unavailable', reason:'This take does not belong to this shot.'};
  }
  const asset = assets.find(item => item.id === take.assetId && item.projectId === shot.projectId);
  if (!asset) return {status:'unavailable', reason:'The video is not in this workspace yet. Wait for retrieval to finish, then refresh.'};
  if (asset.kind !== 'video') return {status:'unavailable', reason:'This take has no video. Inspect its source details.'};
  const url = ownedMediaUrl(asset);
  if (!url) return {status:'unavailable', reason:'An owned video is not available. A provider link is not a saved take.'};
  return {status:'ready', asset, url};
}
