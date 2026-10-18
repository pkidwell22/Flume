import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { Controls } from '@flume/domain';
import type { VideoCapability } from '@flume/providers';

// DOM logic only: no resources/scripts, native dialog, CSS or image decoding.
export const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1/',
});
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Event', 'Node']) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: (dom.window as unknown as Record<string, unknown>)[key],
  });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperties(dom.window.HTMLDialogElement.prototype, {
  showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
  close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
});
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
  configurable: true, value() {},
});
// jsdom hides [popover] but has no top layer. Match the current editor's DOM
// test fixture; this only exposes the mounted chooser, not native popup proof.
Object.defineProperty(dom.window.HTMLElement.prototype, 'showPopover', {
  configurable: true, value(this: HTMLElement) { this.style.display = 'block'; },
});

// Synthetic compiler capability, NOT a claim about Hailuo or account entitlement.
export const capability: VideoCapability = {
  modelId: 'fixture/paired', name: 'Prompt regression fixture (not a live model)',
  durations: [4], resolutions: ['720p'], aspectRatios: ['16:9'],
  frameRoles: ['first_frame', 'last_frame'], seedSupported: true,
  generateAudioSupported: true, availability: 'unknown', blocker: null,
};
export const controls: Controls = {
  modelId: capability.modelId, durationSeconds: 4, resolution: '720p',
  aspectRatio: '16:9', generateAudio: false, seed: 0,
};
// Distinct, owned synthetic 1x1 PNG bytes. The test seeds metadata, not an import/decode.
export const framePng = {
  first: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQVDIGAACuAGcVHqFfAAAAAElFTkSuQmCC',
  last: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4M9MFAAPeAapv0L+5AAAAAElFTkSuQmCC',
};
export const prose = '  Keep café and cafe\u0301 🎥 distinct.\tDo not normalize.\n\n'
  + '<em data-prompt-mark="literal">not HTML</em> &lt;not decoded&gt; &amp;\n'
  + '<script data-prompt-mark="literal">window.promptWasInterpreted=true</script>\n';
export const directions = [
  '1. Dolly in toward the doorway.',
  '2. Pan left, then hold.',
  '3. Rack focus to the distant lamp.',
] as const;
// Camera guidance is an explicit visible textarea edit, never a metadata field.
export const literalPrompt = prose + '\nCamera direction (plain-text guidance):\n'
  + directions.join('\n') + '\n\t  ';
export const reorderedPrompt = literalPrompt.replace(directions.join('\n'), [...directions].reverse().join('\n'));

export function assertLiteral(actual: unknown, boundary: string) {
  assert.equal(actual, literalPrompt, `${boundary}: literal prompt changed`);
  assert.deepEqual(Buffer.from(actual as string, 'utf8'), Buffer.from(literalPrompt, 'utf8'),
    `${boundary}: UTF-8 prompt bytes changed`);
}

/** Coverage-only negative control at the injected provider seam; production is unchanged. */
export function compilationPrompt(prompt: string): string {
  switch (process.env.FLUME_PROMPT_REGRESSION_MUTATION) {
    case undefined: return prompt;
    case 'trim': return prompt.trim();
    case 'reorder': return prompt.replace(directions.join('\n'), [...directions].reverse().join('\n'));
    default: throw new Error('Unknown prompt-regression negative control');
  }
}
