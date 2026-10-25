import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLMediaElement: dom.window.HTMLMediaElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
const React = await import('react');
const { cleanup, fireEvent, render } = await import('@testing-library/react');
const { HomeShowreel } = await import('../src/HomeShowreel.tsx');

test.afterEach(cleanup);
Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'play', { configurable: true, value: () => Promise.resolve() });
Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'pause', { configurable: true, value() {} });

function setMotion(reduced: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }),
  });
}

/** Reads the ids an element points at, as a screen reader would expose them. */
function describedText(element: HTMLElement) {
  const ids = (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  return ids.map(id => document.getElementById(id)?.textContent ?? '').join(' ');
}

test('a failed film explains why its Resume control is disabled', async () => {
  setMotion(false);
  const view = render(<HomeShowreel />);
  fireEvent.error(view.getByLabelText('Afternoon, unhurried'));
  const control = view.getByRole('button', { name: 'Pause showreel' }) as HTMLButtonElement;
  assert.equal(control.disabled, true, 'failed media keeps the control disabled');
  assert.ok(control.getAttribute('aria-describedby'), 'the disabled control points at an explanation');
  assert.match(describedText(control), /This film could not be played/, 'the existing failure status is wired as the reason');
});

test('reduced motion states that playback is paused for the preference, and the reason survives a failure', async () => {
  setMotion(true);
  const view = render(<HomeShowreel />);
  assert.match(view.getByText(/Reduced motion is on/).textContent ?? '', /starts paused/);
  const control = view.getByRole('button', { name: 'Resume showreel' }) as HTMLButtonElement;
  assert.equal(control.disabled, false, 'reduced motion informs; it never blocks playback on request');

  fireEvent.error(view.getByLabelText('Afternoon, unhurried'));
  const failed = view.getByRole('button', { name: 'Resume showreel' }) as HTMLButtonElement;
  assert.equal(failed.disabled, true);
  const reason = describedText(failed);
  assert.match(reason, /This film could not be played/, 'the media failure is part of the reason');
  assert.match(reason, /Reduced motion is on/, 'the motion preference is part of the reason');
});
