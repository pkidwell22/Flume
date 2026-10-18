import './setup.tsx';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { GenerationReview } from '../src/GenerationReview.tsx';

const review = {
  id: 'focus-review', projectId: 'focus-project', shotId: 'focus-shot', shotRevision: 3,
  requestHash: 'focus-request', prompt: 'Literal prompt',
  controls: { modelId: 'fixture', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false, seed: 0 },
  bindings: { firstFrameAssetId: null, lastFrameAssetId: null }, estimatedCostUsd: null, blockers: [], approved: false,
};
const callbacks = { onApprove: () => {}, onSubmit: () => {}, onDismiss: () => {} };
afterEach(() => { cleanup(); document.querySelectorAll('[data-focus-fixture]').forEach(node => node.remove()); });
function button() {
  const node = document.createElement('button'); node.dataset.focusFixture = '';
  document.body.append(node); return node;
}

test('review cleanup does not steal an intentionally newer focus destination', () => {
  const opener = button(); const newer = button(); opener.focus();
  const view = render(<GenerationReview review={review} assets={[]} {...callbacks} />);
  // jsdom has no top layer; native closed-dialog behavior is covered separately.
  view.container.querySelector('dialog')!.close(); newer.focus();
  view.unmount();
  assert.ok(document.activeElement === newer, 'newer focus must survive old drawer cleanup');
});

for (const kind of ['detached', 'disabled', 'aria-disabled', 'inert', 'hidden'] as const) {
  test(`review cleanup skips a ${kind} opener`, () => {
    const opener = button(); opener.focus();
    const view = render(<GenerationReview review={review} assets={[]} {...callbacks} />);
    let attempts = 0; opener.focus = () => { attempts++; };
    if (kind === 'detached') opener.remove();
    else if (kind === 'disabled') opener.disabled = true;
    else opener.setAttribute(kind, kind === 'aria-disabled' ? 'true' : '');
    view.unmount();
    assert.equal(attempts, 0, 'ineligible or detached opener must not receive focus');
  });
}
