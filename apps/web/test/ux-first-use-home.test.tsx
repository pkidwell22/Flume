import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import type { WorkspaceComponents } from '../src/ports.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });
Object.assign(globalThis, { HTMLDialogElement: dom.window.HTMLDialogElement });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
const React = await import('react');
const { cleanup, fireEvent, render } = await import('@testing-library/react');
const { FlumeApp } = await import('../src/App.tsx');
const { WorkspaceController } = await import('../src/controller.ts');

const parts: WorkspaceComponents = {
  Brand: () => <span>Flume</span>, ShotEditor: () => null, TakeReview: () => null,
  ActivityPanel: () => null, GenerationReview: ({ review }) => <div>Pending review {review.id}</div>,
};
const projects = [
  { id: 'p1', name: 'Alpine Study', brief: 'Snow and morning light', revision: 1 },
  { id: 'p2', name: 'City Film', brief: 'Night streets', revision: 1 },
];
const shot = { id: 'shot-p1', projectId: 'p1', title: 'Opening', prompt: '', revision: 1, selectionRevision: 0, controls: { modelId: 'model', durationSeconds: 5, aspectRatio: '16:9', resolution: '720p', generateAudio: false }, bindings: { firstFrameAssetId: null, lastFrameAssetId: null } };

function workspace(project = projects[0]!, withShot = false) {
  return {
    project,
    shots: withShot ? [shot] : [],
    assets: [], takes: [], attempts: [], reviews: [], exports: [], capabilities: [],
  } as any;
}
async function settle() { await React.act(async () => {}); }

function controller(withShot = true) {
  return new WorkspaceController({
    listProjects: async () => projects,
    getWorkspace: async id => workspace(projects.find(project => project.id === id) ?? projects[0]!, withShot),
    command: async () => ({ commandId: 'unused', projectId: 'p1' }),
    uploadAsset: async () => { throw new Error('unused'); },
  });
}

test.afterEach(() => { cleanup(); window.localStorage.clear(); window.history.replaceState({}, '', '/'); });

test('a project can be chosen from Home with the header selector in one interaction', async () => {
  const state = controller();
  await state.start();
  const view = render(<FlumeApp controller={state} components={parts} autoStart={false} initialView="home" />);
  const selector = view.getByRole('button', { name: /Choose a project/ }) as HTMLButtonElement;
  assert.equal(selector.disabled, false, 'Home must not present an inert project selector');
  assert.equal(selector.getAttribute('aria-expanded'), 'false');

  fireEvent.click(selector);
  assert.equal(selector.getAttribute('aria-expanded'), 'true');
  const drawer = view.getByRole('dialog', { name: 'Projects' });
  assert.ok(drawer);
  assert.ok(view.getByRole('button', { name: 'Open project: Alpine Study' }));

  fireEvent.click(view.getByRole('button', { name: 'Open project: City Film' }));
  await settle();
  assert.equal(state.getSnapshot().workspace?.project?.id, 'p2');
  assert.equal(document.querySelector('.fl-home'), null, 'opening a project leaves Home');
});

test('contextually disabled Home controls expose a discoverable reason', async () => {
  const state = controller();
  await state.start();
  const view = render(<FlumeApp controller={state} components={parts} autoStart={false} initialView="home" />);
  for (const name of ['Workspace', 'Library', 'Activity', 'Export', 'Storyboard']) {
    const control = view.getByRole('button', { name: new RegExp(`^${name}`) }) as HTMLButtonElement;
    assert.equal(control.disabled, true, `${name} needs an open project`);
    const describedBy = control.getAttribute('aria-describedby');
    assert.ok(describedBy, `${name} must point at a described reason`);
    const reason = document.getElementById(describedBy!);
    assert.ok(reason, `${name} reason element is missing`);
    assert.match(reason!.textContent!, /once a project is open/i, `${name} reason must be readable`);
    assert.match(control.getAttribute('title') ?? '', /once a project is open/i, `${name} must also show a tooltip reason`);
  }
});

test('project cards label their primary entry and keep quick actions secondary', async () => {
  const state = controller();
  await state.start();
  const view = render(<FlumeApp controller={state} components={parts} autoStart={false} initialView="home" />);
  const open = view.getByRole('button', { name: 'Open Alpine Study' });
  assert.match(open.textContent!.trim(), /Open/, 'the primary entry target names its action');
  const quick = view.getByRole('button', { name: 'Build a shot in Alpine Study' });
  assert.ok(quick.className.includes('fl-home-card__subaction'), 'quick actions are marked secondary');
  for (const name of ['Analyze references in Alpine Study', 'Review takes in Alpine Study', 'Browse assets in Alpine Study']) {
    assert.ok(view.getByRole('button', { name }).className.includes('fl-home-card__subaction'));
  }
});

test('both creation entry points on Home use the same wording', async () => {
  const state = controller();
  await state.start();
  const view = render(<FlumeApp controller={state} components={parts} autoStart={false} initialView="home" />);
  const creates = view.getAllByRole('button', { name: 'Create project' });
  assert.equal(creates.length, 2, 'hero and section header keep their entry points but agree on wording');
});

test("a project view's heading is the project name and the app attribution is labelled", async () => {
  const state = controller(false);
  await state.start('p1');
  const view = render(<FlumeApp controller={state} components={parts} autoStart={false} initialView="workspace" />);
  await settle();
  assert.ok(view.getByRole('heading', { level: 1, name: 'Alpine Study' }), 'the H1 confirms the name the user supplied');
  assert.equal(view.queryByRole('heading', { name: 'A new film' }), null);
  assert.ok(view.getByText('App by Mountain Meadow Systems'), 'branding is identified as app branding');
});

test('empty frame guidance points at a visibly labelled surface and never at an unlabelled slate', async () => {
  const state = controller();
  await state.start('p1');
  const view = render(<FlumeApp controller={state} components={parts} autoStart={false} initialView="workspace" />);
  await settle();
  assert.ok(view.getByText('Shot editor'), 'the editing surface carries a visible name');
  assert.ok(view.getByText('Choose a start frame in the shot editor.'));
  assert.ok(view.getByText('Choose an end frame in the shot editor.'));
  assert.equal(/in the slate/i.test(document.body.textContent ?? ''), false, 'no instruction names an unlabelled place');
  assert.ok(view.getByRole('region', { name: 'Shot composer' }), 'the labelled editing surface is the copy’s referent');
});
