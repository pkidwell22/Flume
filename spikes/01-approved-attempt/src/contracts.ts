import { createHash } from 'node:crypto';
import { z } from 'zod';

const uuid = z.uuid();
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const frame = z.strictObject({ assetRevisionId: uuid, sha256: fingerprint });
export const requestSchema = z.strictObject({
  version: z.literal(1),
  projectId: uuid,
  shotId: uuid,
  draftRevision: z.number().int().positive(),
  route: z.literal('fixture/video-v1'),
  accountId: uuid,
  spec: z.strictObject({ prompt: z.string().min(1), seed: z.number().int().nonnegative(), audio: z.boolean(),
    firstFrame: frame, lastFrame: frame }),
  envelope: z.strictObject({ version: z.literal(1), adapterVersion: z.literal('fixture-1'), body: z.string().min(1) }),
});
export const commandSchema = z.strictObject({
  commandId: uuid, reviewId: uuid, grantId: uuid, requestFingerprint: fingerprint,
});
export const contextSchema = z.strictObject({ projectId: uuid, actorId: uuid });
export type FrozenRequest = z.infer<typeof requestSchema>;
export type Command = z.infer<typeof commandSchema>;
export type Context = z.infer<typeof contextSchema>;
export type Receipt = { attemptId: string; jobId: string };

// JSON-only fixtures; object key order is immaterial, string bytes/array order are not.
export function hash(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (item !== null && typeof item === 'object') return `{${Object.entries(item)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(',')}}`;
    return JSON.stringify(item);
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}
