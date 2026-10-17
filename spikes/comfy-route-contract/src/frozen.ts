import { z } from 'zod';
import manifest from '../sources/manifest.json' with { type: 'json' };
import { inspectRequest } from './contract.ts';

const nonempty = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const intentSchema = z.strictObject({
  version: z.literal('h3-intent/v1'),
  model: z.literal('minimax/minimax-h3'),
  schemaVersion: z.literal(manifest.h3.version),
  schemaSha256: z.literal(manifest.h3.sha256),
  semanticsVersion: z.literal(manifest.semanticsVersion),
  prompt: z.strictObject({ user: z.string(), composed: nonempty, compositionVersion: nonempty }),
  controls: z.strictObject({
    duration: z.number(), resolution: z.string(), ratio: z.string().optional(),
    seed: z.number().optional(), aigc_watermark: z.boolean().optional(),
  }),
  bindings: z.array(z.strictObject({
    modality: z.literal('image'),
    role: z.enum(['first_frame', 'last_frame', 'reference_image']),
    assetId: nonempty, revision: nonempty, sha256: digest, uri: nonempty,
    continuity: z.strictObject({
      sourceTakeId: nonempty, sourceAssetId: nonempty, sourceRevision: nonempty,
      sourceSha256: digest, streamIndex: z.number().int().nonnegative(),
      framePts: z.string().regex(/^-?\d+$/), timebase: z.string().regex(/^[1-9]\d*\/[1-9]\d*$/),
    }).optional(),
  })),
});

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export function compileFrozen(input: unknown) {
  // Zod makes a detached copy. Prompt and media order are already reviewed;
  // this function composes neither and never resolves a current asset revision.
  const frozenIntent = intentSchema.parse(input);
  const body = {
    content: [
      { type: 'text', text: frozenIntent.prompt.composed },
      ...frozenIntent.bindings.map(binding => ({ type: 'image_url', role: binding.role, image_url: { url: binding.uri } })),
    ],
    ...frozenIntent.controls,
  };
  const validation = inspectRequest(body);
  if (!validation.structural.valid || validation.semantic.status !== 'pass') {
    throw new Error(`Blocked contract: ${JSON.stringify({ structural: validation.structural, semantic: validation.semantic })}`);
  }
  return freezeDeep({
    executable: false as const,
    bodyJson: JSON.stringify(body),
    frozenIntent,
    request: {
      method: 'POST' as const,
      url: 'https://api.comfy.org/v2/models/minimax/minimax-h3/requests?reject_unknown_fields=true',
      body,
    },
    validation,
  });
}
