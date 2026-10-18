import type { Draft } from './editor-state.ts';
import type { AssetView, CapabilityView } from './types.ts';

export function modelIssues(
  draft: Draft,
  capabilities: readonly CapabilityView[],
  images: readonly AssetView[],
): string[] {
  const model = capabilities.find((item) => item.modelId === draft.controls.modelId);
  const issues: string[] = [];
  if (!model)
    issues.push('This model is not in the current catalog. Choose a known model before reviewing.');
  else {
    if (model.availability !== 'available')
      issues.push(
        model.blocker ||
          (model.availability === 'blocked'
            ? 'This model is blocked for this account.'
            : 'Model availability is not confirmed.'),
      );
    if (!model.durations.includes(Number(draft.controls.durationSeconds)))
      issues.push(
        `${draft.controls.durationSeconds || 'This duration'} seconds is not supported. Supported durations: ${model.durations.join(', ') || 'not reported'}.`,
      );
    if (!model.resolutions.includes(draft.controls.resolution))
      issues.push(
        `${draft.controls.resolution || 'This resolution'} is not supported. Supported resolutions: ${model.resolutions.join(', ') || 'not reported'}.`,
      );
    if (draft.controls.seed !== '' && !model.seedSupported)
      issues.push('This model does not support a seed. Your seed is kept until you clear it.');
    if (draft.bindings.firstFrameAssetId !== null && !model.frameRoles.includes('first_frame'))
      issues.push('This model does not support a start frame. Your start frame is kept.');
    if (draft.bindings.lastFrameAssetId !== null && !model.frameRoles.includes('last_frame'))
      issues.push(
        'This model does not support an end frame. Your end frame is kept; it will not become a soft reference.',
      );
  }
  for (const [key, label] of [
    ['firstFrameAssetId', 'Start frame'],
    ['lastFrameAssetId', 'End frame'],
  ] as const) {
    const assetId = draft.bindings[key];
    if (assetId !== null && !images.some((image) => image.id === assetId))
      issues.push(
        `${label} is not an available image in this project. Choose a replacement or clear it.`,
      );
  }
  return issues;
}
