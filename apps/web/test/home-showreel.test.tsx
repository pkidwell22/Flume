import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import type { WorkspaceComponents } from '../src/ports.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLDialogElement: dom.window.HTMLDialogElement, HTMLMediaElement: dom.window.HTMLMediaElement });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
const React = await import('react');
const { cleanup, fireEvent, render } = await import('@testing-library/react');
const { FlumeApp } = await import('../src/App.tsx');
const { WorkspaceController } = await import('../src/controller.ts');

const parts: WorkspaceComponents = {
  Brand: () => <span>Flume</span>, ShotEditor: () => null, TakeReview: () => null,
  ActivityPanel: () => null, GenerationReview: () => null,
};
const project = { id: 'p1', name: 'City Film', brief: 'Night streets', revision: 1 };
function controller() {
  return new WorkspaceController({
    listProjects: async () => [project], getWorkspace: async () => { throw new Error('unused'); },
    command: async () => { throw new Error('unused'); }, uploadAsset: async () => { throw new Error('unused'); },
  });
}
function setMotion(reduced: boolean) {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }) });
}

test.afterEach(() => cleanup());

test('Home showreel navigates with labelled controls and clip-specific posters', async () => {
  setMotion(false);
  Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'play', { configurable: true, value: () => Promise.resolve() });
  Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'pause', { configurable: true, value() {} });
  const view = render(<FlumeApp controller={controller()} components={parts} autoStart={false} initialView="home" />);

  assert.ok(view.getByRole('region', { name: 'Featured films' }));
  assert.ok(view.getByText('Afternoon, unhurried'));
  assert.ok(view.queryByRole('button', {name: 'Show After the rain'}) === null);
  assert.ok(view.queryByRole('button', {name: 'Show Electric tide'}) === null);
  assert.match((view.getByLabelText('Afternoon, unhurried') as HTMLVideoElement).poster, /afternoon-room\.webp$/);
  fireEvent.click(view.getByRole('button', { name: 'Next film' }));
  assert.ok(view.getByText('Light and form'));
  assert.match((view.getByLabelText('Light and form') as HTMLVideoElement).poster, /desert-light\.webp$/);
  fireEvent.click(view.getByRole('button', { name: 'Show Before the last bus' }));
  assert.ok(view.getByText('Before the last bus'));
  fireEvent.click(view.getByRole('button', { name: 'Previous film' }));
  assert.ok(view.getByText('Light and form'));
});

test('Home showreel preserves pause across slides and reduced motion starts paused', async () => {
  let plays = 0;
  Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'play', { configurable: true, value: () => { plays++; return Promise.resolve(); } });
  Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'pause', { configurable: true, value() {} });
  setMotion(false);
  const view = render(<FlumeApp controller={controller()} components={parts} autoStart={false} initialView="home" />);
  await React.act(async () => {});
  assert.ok(plays > 0);
  fireEvent.click(view.getByRole('button', { name: 'Pause showreel' }));
  const pausedAt = plays;
  fireEvent.click(view.getByRole('button', { name: 'Next film' }));
  await React.act(async () => {});
  assert.equal(plays, pausedAt);
  cleanup();

  plays = 0;
  setMotion(true);
  const reduced = render(<FlumeApp controller={controller()} components={parts} autoStart={false} initialView="home" />);
  await React.act(async () => {});
  assert.equal(plays, 0);
  assert.ok(reduced.getByRole('button', { name: 'Resume showreel' }));
  fireEvent.click(reduced.getByRole('button', { name: 'Resume showreel' }));
  await React.act(async () => {});
  assert.equal(plays, 1);
});

test('Home showreel advances on ended only while playing and reports media failures', async () => {
  setMotion(false);
  Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'play', { configurable: true, value: () => Promise.resolve() });
  Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'pause', { configurable: true, value() {} });
  const view = render(<FlumeApp controller={controller()} components={parts} autoStart={false} initialView="home" />);
  const first = view.getByLabelText('Afternoon, unhurried');
  fireEvent.ended(first);
  assert.ok(view.getByText('Light and form'));
  fireEvent.click(view.getByRole('button', { name: 'Pause showreel' }));
  fireEvent.ended(view.getByLabelText('Light and form'));
  assert.ok(view.getByText('Light and form'));
  fireEvent.error(view.getByLabelText('Light and form'));
  assert.ok(view.getByRole('status', { name: 'Light and form unavailable' }));
  assert.ok(view.getByText('This film could not be played.'));
  assert.ok(view.queryByText(/alpine/i) === null);
});

test('a rejected play from a replaced clip cannot pause the current clip', async () => {
  setMotion(false);
  let rejectFirst!: (error: Error) => void;
  let calls = 0;
  Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'play', { configurable: true, value: () => ++calls === 1 ? new Promise<void>((_, reject) => { rejectFirst = reject; }) : Promise.resolve() });
  Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'pause', { configurable: true, value() {} });
  const view = render(<FlumeApp controller={controller()} components={parts} autoStart={false} initialView="home" />);
  fireEvent.click(view.getByRole('button', { name: 'Next film' }));
  await React.act(async () => rejectFirst(new Error('Old media was detached')));
  assert.ok(view.getByRole('button', { name: 'Pause showreel' }));
  assert.ok(view.getByText('Light and form'));
});
