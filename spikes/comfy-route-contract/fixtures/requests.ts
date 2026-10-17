// h3-fixtures/v1: authored requests, not provider observations or real media.
export const textBody = {
  content: [{ type: 'text', text: 'A red paper boat on a white tabletop.' }],
  duration: 4,
  resolution: '768P',
  ratio: '16:9',
};
export const first = { type: 'image_url', role: 'first_frame', image_url: { url: 'https://example.invalid/first.png' } };
export const last = { type: 'image_url', role: 'last_frame', image_url: { url: 'https://example.invalid/last.png' } };
export const reference = { type: 'image_url', role: 'reference_image', image_url: { url: 'https://example.invalid/reference.png' } };

export type RequestCase = {
  id: string;
  body: unknown;
  structural: boolean;
  semantic: 'pass' | 'blocked' | 'not-evaluated';
  codes: string[];
};

export const cases: RequestCase[] = [
  ...[{ model: null }, { model: 'MiniMax-H3' }, { callback_url: 'https://example.invalid/callback' }, { generate_audio: false }, { temperature: 0 }].map((extra, index) => ({ id: `reserved-or-unknown-field-${index}`, body: { ...textBody, ...extra }, structural: true, semantic: 'blocked' as const, codes: ['FIELD_NOT_IN_LANE'] })),
  { id: 'unknown-content-field', body: { ...textBody, content: [{ ...textBody.content[0], camera: 'dolly' }] }, structural: true, semantic: 'blocked', codes: ['FIELD_NOT_IN_LANE'] },
  { id: 'unknown-source-field', body: { ...textBody, content: [...textBody.content, { ...first, image_url: { ...first.image_url, crop: true } }] }, structural: true, semantic: 'blocked', codes: ['FIELD_NOT_IN_LANE'] },
  { id: 'mixed-item-type', body: { ...textBody, content: [{ ...textBody.content[0], image_url: first.image_url, role: 'first_frame' }] }, structural: true, semantic: 'blocked', codes: ['FIELD_NOT_IN_LANE'] },
  { id: 'false-and-zero', body: { ...textBody, seed: 0, aigc_watermark: false }, structural: true, semantic: 'pass', codes: [] },
  { id: 'watermark-true', body: { ...textBody, aigc_watermark: true }, structural: true, semantic: 'pass', codes: [] },
  { id: 'watermark-null', body: { ...textBody, aigc_watermark: null }, structural: false, semantic: 'not-evaluated', codes: [] },
  ...[3, 16, 4.5, '5', null].map(duration => ({ id: `duration-reject-${String(duration)}`, body: { ...textBody, duration }, structural: false, semantic: 'not-evaluated' as const, codes: [] })),
  ...Array.from({ length: 12 }, (_, index) => index + 4).map(duration => ({ id: `duration-accept-${duration}`, body: { ...textBody, duration }, structural: true, semantic: 'pass' as const, codes: [] })),
  ...['768P', '768p', '2K', '2k'].map(resolution => ({ id: `resolution-accept-${resolution}`, body: { ...textBody, resolution }, structural: true, semantic: 'pass' as const, codes: [] })),
  ...['1080P', '768p ', '2k ', null].map(resolution => ({ id: `resolution-reject-${String(resolution)}`, body: { ...textBody, resolution }, structural: false, semantic: 'not-evaluated' as const, codes: [] })),
  ...['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].map(ratio => ({ id: `ratio-accept-${ratio}`, body: { ...textBody, ratio }, structural: true, semantic: 'pass' as const, codes: [] })),
  { id: 'ratio-text-unset', body: { content: textBody.content, duration: 5, resolution: '768P' }, structural: true, semantic: 'blocked', codes: ['TEXT_RATIO_REQUIRED'] },
  { id: 'ratio-text-adaptive', body: { ...textBody, ratio: 'adaptive' }, structural: true, semantic: 'blocked', codes: ['TEXT_RATIO_REQUIRED'] },
  { id: 'ratio-unknown', body: { ...textBody, ratio: '5:4' }, structural: true, semantic: 'blocked', codes: ['RATIO_OPTION'] },
  { id: 'ratio-null', body: { ...textBody, ratio: null }, structural: false, semantic: 'not-evaluated', codes: [] },
  { id: 'ratio-frame-unset', body: { content: [...textBody.content, first], duration: 5, resolution: '768P' }, structural: true, semantic: 'pass', codes: [] },
  { id: 'ratio-frame-adaptive', body: { ...textBody, content: [...textBody.content, last], ratio: 'adaptive' }, structural: true, semantic: 'pass', codes: [] },
  { id: 'ratio-reference-unset-unknown', body: { content: [...textBody.content, reference], duration: 5, resolution: '768P' }, structural: true, semantic: 'blocked', codes: ['REFERENCE_RATIO_UNKNOWN'] },
  { id: 'ratio-reference-adaptive-unknown', body: { ...textBody, content: [...textBody.content, reference], ratio: 'adaptive' }, structural: true, semantic: 'blocked', codes: ['REFERENCE_RATIO_UNKNOWN'] },
  ...[-1, 0, 4294967295].map(seed => ({ id: `seed-accept-${seed}`, body: { ...textBody, seed }, structural: true, semantic: 'pass' as const, codes: [] })),
  ...[-2, 4294967296].map(seed => ({ id: `seed-reject-${seed}`, body: { ...textBody, seed }, structural: true, semantic: 'blocked' as const, codes: ['SEED_RANGE'] })),
  { id: 'seed-fraction', body: { ...textBody, seed: 0.5 }, structural: false, semantic: 'not-evaluated', codes: [] },
  { id: 'seed-null', body: { ...textBody, seed: null }, structural: false, semantic: 'not-evaluated', codes: [] },
  { id: 'first-only', body: { ...textBody, content: [...textBody.content, first] }, structural: true, semantic: 'pass', codes: [] },
  { id: 'last-only', body: { ...textBody, content: [...textBody.content, last] }, structural: true, semantic: 'pass', codes: [] },
  { id: 'paired-frames', body: { ...textBody, content: [...textBody.content, first, last] }, structural: true, semantic: 'pass', codes: [] },
  { id: 'reference-only', body: { ...textBody, content: [...textBody.content, reference] }, structural: true, semantic: 'pass', codes: [] },
  { id: 'first-plus-reference', body: { ...textBody, content: [...textBody.content, first, reference] }, structural: true, semantic: 'blocked', codes: ['FRAME_REFERENCE_CONFLICT'] },
  { id: 'last-plus-reference', body: { ...textBody, content: [...textBody.content, last, reference] }, structural: true, semantic: 'blocked', codes: ['FRAME_REFERENCE_CONFLICT'] },
  { id: 'pair-plus-reference', body: { ...textBody, content: [...textBody.content, first, last, reference] }, structural: true, semantic: 'blocked', codes: ['FRAME_REFERENCE_CONFLICT'] },
  { id: 'duplicate-first', body: { ...textBody, content: [...textBody.content, first, first] }, structural: true, semantic: 'blocked', codes: ['DUPLICATE_FRAME_ROLE'] },
  { id: 'duplicate-last', body: { ...textBody, content: [...textBody.content, last, last] }, structural: true, semantic: 'blocked', codes: ['DUPLICATE_FRAME_ROLE'] },
  { id: 'multiple-reference-limit-unknown', body: { ...textBody, content: [...textBody.content, reference, reference] }, structural: true, semantic: 'blocked', codes: ['REFERENCE_LIMIT_UNKNOWN'] },
  { id: 'source-video-not-H3', body: { ...textBody, content: [...textBody.content, { type: 'video_url', role: 'base_video', video_url: { url: 'https://example.invalid/source.mp4' } }] }, structural: true, semantic: 'blocked', codes: ['MODEL_MODALITY'] },
  { id: 'reference-audio-not-H3', body: { ...textBody, content: [...textBody.content, { type: 'audio_url', role: 'reference_audio', audio_url: { url: 'https://example.invalid/source.wav' } }] }, structural: true, semantic: 'blocked', codes: ['MODEL_MODALITY'] },
  { id: 'unknown-modality', body: { ...textBody, content: [...textBody.content, { type: 'depth_map' }] }, structural: true, semantic: 'blocked', codes: ['UNKNOWN_MODALITY'] },
  { id: 'unknown-role', body: { ...textBody, content: [...textBody.content, { ...first, role: 'character' }] }, structural: true, semantic: 'blocked', codes: ['UNKNOWN_ROLE'] },
  { id: 'role-typo-not-normalized', body: { ...textBody, content: [...textBody.content, { ...first, role: 'First_Frame' }] }, structural: true, semantic: 'blocked', codes: ['UNKNOWN_ROLE'] },
  { id: 'sibling-role-not-remapped', body: { ...textBody, content: [...textBody.content, { ...first, role: 'base_video' }] }, structural: true, semantic: 'blocked', codes: ['UNKNOWN_ROLE'] },
  { id: 'missing-role', body: { ...textBody, content: [...textBody.content, { type: 'image_url', image_url: first.image_url }] }, structural: true, semantic: 'blocked', codes: ['UNKNOWN_ROLE'] },
  { id: 'missing-image-url', body: { ...textBody, content: [...textBody.content, { type: 'image_url', role: 'first_frame' }] }, structural: true, semantic: 'blocked', codes: ['IMAGE_SOURCE_EMPTY'] },
  { id: 'blank-image-url', body: { ...textBody, content: [...textBody.content, { ...first, image_url: { url: ' ' } }] }, structural: true, semantic: 'blocked', codes: ['IMAGE_SOURCE_EMPTY'] },
  { id: 'text-valid', body: textBody, structural: true, semantic: 'pass', codes: [] },
  { id: 'prompt-missing', body: { ...textBody, content: [] }, structural: true, semantic: 'blocked', codes: ['TEXT_COUNT'] },
  { id: 'prompt-empty', body: { ...textBody, content: [{ type: 'text', text: '' }] }, structural: true, semantic: 'blocked', codes: ['TEXT_EMPTY'] },
  { id: 'prompt-whitespace', body: { ...textBody, content: [{ type: 'text', text: '  \n\t' }] }, structural: true, semantic: 'blocked', codes: ['TEXT_EMPTY'] },
  { id: 'prompt-text-absent', body: { ...textBody, content: [{ type: 'text' }] }, structural: true, semantic: 'blocked', codes: ['TEXT_EMPTY'] },
  { id: 'prompt-duplicate', body: { ...textBody, content: [...textBody.content, ...textBody.content] }, structural: true, semantic: 'blocked', codes: ['TEXT_COUNT'] },
];
