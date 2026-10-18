import { check, uuid } from './types.ts';
import type { RemoteIdentity } from './types.ts';
import { digest } from './storage.ts';

export function remoteIdentityHash(projectId: string, identity: RemoteIdentity): string {
  uuid(projectId);
  check(identity && Object.keys(identity).sort().join(',') === 'jobId,outputId,provider', 'INVALID_REMOTE_IDENTITY');
  check(typeof identity.provider === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(identity.provider), 'INVALID_PROVIDER');
  for (const v of [identity.jobId, identity.outputId]) check(typeof v === 'string' && v.length > 0 && v.length <= 2048 && !/[\x00-\x1f\x7f]/.test(v), 'INVALID_REMOTE_IDENTITY');
  return digest(JSON.stringify([projectId.toLowerCase(), identity.provider, identity.jobId, identity.outputId]));
}
/** UUIDv8 derived from project + provider + job + output, never expiring media URLs. */
export function generatedAssetId(projectId: string, identity: RemoteIdentity) {
  const h = remoteIdentityHash(projectId, identity);
  return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
