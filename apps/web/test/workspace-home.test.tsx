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

function workspace(project = projects[0]!, withShot = false) {
  return {
    project,
    shots: withShot ? [{ id: `shot-${project.id}`, projectId: project.id, title: 'Opening', prompt: '', revision: 1, selectionRevision: 0, controls: { modelId: 'model', durationSeconds: 5, aspectRatio: '16:9', resolution: '720p' }, bindings: {} }] : [],
    assets: [], takes: [], attempts: [], reviews: [], exports: [], capabilities: [],
  } as any;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function settle() { await React.act(async () => {}); }
async function travelHistory(delta: number) {
  const popped = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`history.go(${delta}) did not pop`)), 100);
    window.addEventListener('popstate', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  await React.act(async () => { window.history.go(delta); await popped; });
  await settle();
}
function modelOwnedHistory(t: { after(callback: () => void): void }) {
  const session = window.history.state.flume.session;
  const entries = [
    { url: '/', state: { flume: { session, index: 0 } } },
    { url: '/?projectId=p1', state: { flume: { session, index: 1 } } },
    { url: '/?projectId=p2', state: { flume: { session, index: 2 } } },
  ];
  let index = 2;
  const original = window.history.go.bind(window.history);
  Object.defineProperty(window.history, 'go', { configurable: true, value: (delta = 0) => {
    const next = index + delta;
    if (next < 0 || next >= entries.length) return;
    index = next;
    const entry = entries[index]!;
    window.history.replaceState(entry.state, '', entry.url);
    window.dispatchEvent(new window.PopStateEvent('popstate', { state: entry.state }));
  } });
  t.after(() => Object.defineProperty(window.history, 'go', { configurable: true, value: original }));
}

function pendingWorkspace(project = projects[0]!, includeReview = true) {
  const value = workspace(project, true);
  const shot = value.shots[0];
  value.reviews = includeReview ? [{ id: `review-${project.id}`, projectId: project.id, shotId: shot.id, shotRevision: shot.revision, requestHash: 'request-hash', prompt: shot.prompt, controls: shot.controls, bindings: shot.bindings, estimatedCostUsd: null, blockers: [], approved: false }] : [];
  return value;
}

test.afterEach(() => { cleanup(); window.localStorage.clear(); window.history.replaceState({}, '', '/'); });

test('Home hides a pending review and reopening the same project preserves its authoritative review', async () => {
  window.history.replaceState({}, '', '/?projectId=p1');
  const controller = new WorkspaceController({ listProjects: async () => projects, getWorkspace: async id => pendingWorkspace(projects.find(project => project.id === id) ?? projects[0]!), command: async () => ({ commandId: 'unused', projectId: 'p1' }), uploadAsset: async () => { throw new Error('unused'); } });
  await controller.start('p1');
  (controller as any).update({ reviewId: 'review-p1' });
  const view = render(<FlumeApp controller={controller} components={parts} autoStart={false} initialProjectId="p1" initialView="workspace" />);
  await settle();
  assert.ok(view.getByText('Pending review review-p1'));

  fireEvent.click(view.getByRole('button', { name: 'Home' }));
  assert.ok(view.queryByText('Pending review review-p1') === null);
  fireEvent.click(view.getByRole('button', { name: 'Workspace' }));
  await settle();

  assert.ok(view.getByText('Pending review review-p1'));
  assert.equal(controller.getSnapshot().reviewId, 'review-p1');
});

test('switching projects clears an unrelated pending review', async () => {
  const controller = new WorkspaceController({ listProjects: async () => projects, getWorkspace: async id => pendingWorkspace(projects.find(project => project.id === id) ?? projects[0]!), command: async () => ({ commandId: 'unused', projectId: 'p1' }), uploadAsset: async () => { throw new Error('unused'); } });
  await controller.start('p1');
  (controller as any).update({ reviewId: 'review-p1' });
  const view = render(<FlumeApp controller={controller} components={parts} autoStart={false} initialView="workspace" />);
  fireEvent.click(view.getByRole('button', { name: /Alpine Study/ }));
  fireEvent.click(view.getByRole('button', { name: 'Open project: City Film' }));
  await settle();
  assert.equal(controller.getSnapshot().workspace?.project?.id, 'p2');
  assert.equal(controller.getSnapshot().reviewId, null);
  assert.ok(view.queryByText('Pending review review-p1') === null);
});

test('reopening the same project does not resurrect a review removed by authoritative readback', async () => {
  let reads = 0;
  const controller = new WorkspaceController({ listProjects: async () => projects, getWorkspace: async () => pendingWorkspace(projects[0]!, ++reads === 1), command: async () => ({ commandId: 'unused', projectId: 'p1' }), uploadAsset: async () => { throw new Error('unused'); } });
  await controller.start('p1');
  (controller as any).update({ reviewId: 'review-p1' });
  const view = render(<FlumeApp controller={controller} components={parts} autoStart={false} initialView="workspace" />);
  fireEvent.click(view.getByRole('button', { name: 'Home' }));
  fireEvent.click(view.getByRole('button', { name: 'Workspace' }));
  await settle();
  assert.equal(controller.getSnapshot().reviewId, null);
  assert.ok(view.queryByText('Pending review review-p1') === null);
});

test('home searches project names and briefs without inventing recency', async () => {
  const controller = new WorkspaceController({
    listProjects: async () => projects,
    getWorkspace: async () => { throw new Error('Home must not hydrate a project automatically'); },
    command: async () => { throw new Error('unused'); }, uploadAsset: async () => { throw new Error('unused'); },
  });
  await controller.start();
  const view = render(<FlumeApp controller={controller} components={parts} autoStart={false} initialView="home" />);

  assert.ok(view.getByRole('heading', { name: 'Make room for the next scene.' }));
  assert.ok(view.getByRole('heading', { name: 'Your projects' }));
  assert.ok(view.queryByText(/recent/i) === null);
  fireEvent.change(view.getByRole('searchbox', { name: 'Search your projects' }), { target: { value: 'SNOW' } });
  assert.ok(view.getByText('Alpine Study'));
  assert.ok(view.queryByText('City Film') === null);
  fireEvent.change(view.getByRole('searchbox', { name: 'Search your projects' }), { target: { value: 'missing' } });
  assert.ok(view.getByText('No projects match “missing”.'));
});

test('Home focus and Refresh update only the visible project list', async () => {
  let listed = [projects[0]!]; let workspaceReads = 0;
  let listReads = 0;
  const controller = new WorkspaceController({
    listProjects: async () => { listReads++; return listed; },
    getWorkspace: async () => { workspaceReads++; return pendingWorkspace(projects[0]!); },
    command: async () => { throw new Error('unused'); }, uploadAsset: async () => { throw new Error('unused'); },
  });
  await controller.start('p1');
  (controller as any).update({ reviewId: 'review-p1' });
  controller.markDirty('shot-p1');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const view = render(<FlumeApp controller={controller} components={parts} autoStart={false} initialView="home" />);
  const originalRefreshProjects = controller.refreshProjects.bind(controller);
  let focusRefreshes = 0;
  controller.refreshProjects = () => { focusRefreshes++; return Promise.resolve(); };
  fireEvent.focus(window);
  assert.equal(focusRefreshes, 1);
  assert.equal(workspaceReads, 1);
  assert.equal(controller.getSnapshot().reviewId, 'review-p1');
  assert.equal(controller.getSnapshot().dirtyShotIds.has('shot-p1'), true);

  controller.refreshProjects = originalRefreshProjects;
  view.unmount();
  listed = projects;
  await controller.refreshProjects();
  let refreshedView = render(<FlumeApp controller={controller} components={parts} autoStart={false} initialView="home" />);
  assert.ok(refreshedView.getByText('City Film'));
  refreshedView.unmount();
  listed = [projects[1]!];
  await controller.refreshProjects();
  refreshedView = render(<FlumeApp controller={controller} components={parts} autoStart={false} initialView="home" />);
  assert.equal(listReads, 3);
  assert.ok(refreshedView.getByRole('region', { name: 'Your projects' }).querySelector('[aria-label="Open Alpine Study"]') === null);
  assert.ok(refreshedView.getByText('City Film'));
  let buttonRefreshes = 0;
  controller.refreshProjects = () => { buttonRefreshes++; return Promise.resolve(); };
  fireEvent.click(refreshedView.getByRole('button', { name: 'Refresh' }));
  assert.equal(buttonRefreshes, 1);
  assert.equal(workspaceReads, 1);
  assert.equal(controller.getSnapshot().reviewId, 'review-p1');
  assert.equal(controller.getSnapshot().dirtyShotIds.has('shot-p1'), true);
});

test('Home distinguishes loading, load failure, and an authoritative empty project list', async () => {
  const base = { command: async () => { throw new Error('unused'); }, uploadAsset: async () => { throw new Error('unused'); }, getWorkspace: async () => ({ project: null, shots: [], assets: [], takes: [], attempts: [], reviews: [], exports: [], capabilities: [] }) };
  const loading = new WorkspaceController({ ...base, listProjects: async () => [] });
  const loadingView = render(<FlumeApp controller={loading} components={parts} autoStart={false} initialView="home" />);
  assert.ok(loadingView.getByText('Loading your projects…'));
  cleanup();

  const failed = new WorkspaceController({ ...base, listProjects: async () => { throw new Error('offline'); } });
  await failed.start();
  const failedView = render(<FlumeApp controller={failed} components={parts} autoStart={false} initialView="home" />);
  assert.ok(failedView.getByText('Projects could not be loaded. Use Refresh to try again.'));
  cleanup();

  const empty = new WorkspaceController({ ...base, listProjects: async () => [] });
  await empty.start();
  const emptyView = render(<FlumeApp controller={empty} components={parts} autoStart={false} initialView="home" />);
  assert.ok(emptyView.getByRole('heading', { name: 'No projects yet' }));
});

test('Review takes hydrates the chosen project and opens its existing takes view', async () => {
  const controller = new WorkspaceController({
    listProjects: async () => projects,
    getWorkspace: async id => {
      const value = workspace(projects.find(project => project.id === id) ?? projects[0]!, true);
      value.takes = [{ id: 'take-p1', projectId: value.project.id, shotId: value.shots[0].id, attemptId: 'attempt-p1', assetId: 'asset-p1', createdAt: '2026-01-01T00:00:00Z' }];
      return value;
    },
    command: async () => ({ commandId: 'unused', projectId: 'p1' }), uploadAsset: async () => { throw new Error('unused'); },
  });
  await controller.start();
  const reviewParts = { ...parts, TakeReview: ({ takes }: any) => <div>Take review count {takes.length}</div> };
  const view = render(<FlumeApp controller={controller} components={reviewParts} autoStart={false} initialView="home" />);
  fireEvent.click(view.getByRole('button', { name: 'Review takes in Alpine Study' }));
  await settle();
  assert.ok(view.getByRole('button', { name: /Takes 1/ }).getAttribute('aria-pressed') === 'true');
  assert.ok(view.getByText('Take review count 1'));
});

test('a project action hydrates that project before opening its real asset library', async () => {
  const reads: string[] = [];
  const controller = new WorkspaceController({
    listProjects: async () => projects,
    getWorkspace: async id => { reads.push(id ?? ''); return { project: projects[0]!, shots: [], assets: [], takes: [], attempts: [], reviews: [], exports: [], capabilities: [] }; },
    command: async () => { throw new Error('unused'); }, uploadAsset: async () => { throw new Error('unused'); },
  });
  await controller.start();
  const view = render(<FlumeApp controller={controller} components={parts} autoStart={false} initialView="home" />);

  fireEvent.click(view.getByRole('button', { name: 'Browse assets in Alpine Study' }));
  await React.act(async () => {});

  assert.deepEqual(reads, ['p1']);
  assert.ok(view.getByRole('heading', { name: 'Library' }));
  assert.ok(view.getByText('No media yet. Import your first image to begin.'));
});

test('project drawer navigation synchronizes URL and resume identity after readback', async () => {
  window.history.replaceState({}, '', '/?projectId=p1');
  window.localStorage.clear();
  const controller = new WorkspaceController({
    listProjects: async () => projects,
    getWorkspace: async id => workspace(projects.find(project => project.id === id) ?? projects[0]!),
    command: async () => { throw new Error('unused'); }, uploadAsset: async () => { throw new Error('unused'); },
  });
  await controller.start('p1');
  const view = render(<FlumeApp controller={controller} components={parts} autoStart initialProjectId="p1" initialView="workspace" />);
  await settle();
  fireEvent.click(view.getByRole('button', { name: /Alpine Study/ }));
  fireEvent.click(view.getByRole('button', { name: 'Open project: City Film' }));
  await settle();
  assert.equal(new URLSearchParams(window.location.search).get('projectId'), 'p2');
  assert.equal(window.localStorage.getItem('flume.resumeProjectId'), 'p2');
  assert.equal(controller.getSnapshot().workspace?.project?.id, 'p2');
});

test('canceling a dirty popstate immediately restores the current URL and view', async t => {
  window.history.replaceState({}, '', '/');
  const controller = new WorkspaceController({ listProjects: async () => projects, getWorkspace: async id => workspace(projects.find(project => project.id === id) ?? projects[0]!, true), command: async () => ({ commandId: 'unused', projectId: 'p1' }), uploadAsset: async () => { throw new Error('unused'); } });
  await controller.start();
  const view = render(<FlumeApp controller={controller} components={parts} autoStart initialView="home" />);
  await settle();
  fireEvent.click(view.getByRole('button', { name: 'Open Alpine Study' })); await settle();
  fireEvent.click(view.getByRole('button', { name: /Alpine Study/ }));
  fireEvent.click(view.getByRole('button', { name: 'Open project: City Film' })); await settle();
  modelOwnedHistory(t);
  await React.act(async () => controller.markDirty('shot-p2'));
  await travelHistory(-1);
  assert.equal(new URLSearchParams(window.location.search).get('projectId'), 'p2');
  assert.equal(controller.getSnapshot().workspace?.project?.id, 'p2');
  fireEvent.click(view.getByRole('button', { name: 'Stay here' }));
  await React.act(async () => controller.clearDirty('shot-p2'));
  await travelHistory(-1);
  assert.equal(new URLSearchParams(window.location.search).get('projectId'), 'p1');
  await travelHistory(1);
  assert.equal(new URLSearchParams(window.location.search).get('projectId'), 'p2');
});

test('held and failed history reads preserve Home to P1 to P2 for later Back and Forward', async t => {
  window.history.replaceState({}, '', '/');
  let failP1 = false;
  const controller = new WorkspaceController({
    listProjects: async () => projects,
    getWorkspace: async id => { if (id === 'p1' && failP1) throw new Error('read failed'); return workspace(projects.find(project => project.id === id) ?? projects[0]!, true); },
    command: async () => ({ commandId: 'unused', projectId: 'p1' }), uploadAsset: async () => { throw new Error('unused'); },
  });
  await controller.start();
  const view = render(<FlumeApp controller={controller} components={parts} autoStart initialView="home" />);
  await settle();
  fireEvent.click(view.getByRole('button', { name: 'Open Alpine Study' })); await settle();
  fireEvent.click(view.getByRole('button', { name: /Alpine Study/ }));
  fireEvent.click(view.getByRole('button', { name: 'Open project: City Film' })); await settle();
  modelOwnedHistory(t);

  await React.act(async () => (controller as any).update({ busy: 'checking' }));
  await travelHistory(-1);
  assert.equal(new URLSearchParams(window.location.search).get('projectId'), 'p2');
  await React.act(async () => (controller as any).update({ busy: null }));
  failP1 = true;
  await travelHistory(-1);
  assert.equal(new URLSearchParams(window.location.search).get('projectId'), 'p2');
  failP1 = false;
  await travelHistory(-1);
  assert.equal(new URLSearchParams(window.location.search).get('projectId'), 'p1');
  await travelHistory(-1);
  assert.equal(new URLSearchParams(window.location.search).get('projectId'), null);
  await travelHistory(1);
  assert.equal(new URLSearchParams(window.location.search).get('projectId'), 'p1');
  await travelHistory(1);
  assert.equal(new URLSearchParams(window.location.search).get('projectId'), 'p2');
});

test('a stale popstate readback cannot replace the later confirmed destination', async () => {
  window.history.replaceState({}, '', '/?projectId=p1');
  const slow = deferred<any>();
  const controller = new WorkspaceController({
    listProjects: async () => projects,
    getWorkspace: async id => id === 'p2' ? slow.promise : workspace(projects[0]!),
    command: async () => ({ commandId: 'unused', projectId: 'p1' }), uploadAsset: async () => { throw new Error('unused'); },
  });
  await controller.start('p1');
  render(<FlumeApp controller={controller} components={parts} autoStart initialProjectId="p1" initialView="workspace" />);
  await settle();
  window.history.pushState({}, '', '/?projectId=p2'); fireEvent.popState(window);
  // A valid target may be in the address bar while its loading state is visible.
  assert.equal(new URLSearchParams(window.location.search).get('projectId'), 'p2');
  window.history.pushState({}, '', '/'); fireEvent.popState(window);
  slow.resolve(workspace(projects[1]!)); await settle();
  assert.equal(new URLSearchParams(window.location.search).get('projectId'), null);
  assert.ok(document.querySelector('.fl-home'));
});

test('unknown popstate target reports honestly and restores a safe consistent view', async () => {
  window.history.replaceState({}, '', '/?projectId=p1');
  const controller = new WorkspaceController({ listProjects: async () => projects, getWorkspace: async () => workspace(), command: async () => ({ commandId: 'unused', projectId: 'p1' }), uploadAsset: async () => { throw new Error('unused'); } });
  await controller.start('p1');
  const view = render(<FlumeApp controller={controller} components={parts} autoStart initialProjectId="p1" initialView="workspace" />);
  await settle();
  window.history.pushState({}, '', '/?projectId=missing'); fireEvent.popState(window);
  assert.equal(new URLSearchParams(window.location.search).get('projectId'), 'p1');
  assert.equal(controller.getSnapshot().workspace?.project?.id, 'p1');
  assert.ok(view.getByText('That project is not available.'));
});

test('missing resume identity and storage failures leave the home usable', async () => {
  window.history.replaceState({}, '', '/');
  window.localStorage.setItem('flume.resumeProjectId', 'missing');
  const controller = new WorkspaceController({ listProjects: async () => projects, getWorkspace: async id => workspace(projects.find(project => project.id === id)), command: async () => ({ commandId: 'unused', projectId: 'p1' }), uploadAsset: async () => { throw new Error('unused'); } });
  await controller.start();
  const original = window.localStorage.getItem.bind(window.localStorage);
  Object.defineProperty(window.localStorage, 'getItem', { configurable: true, value: () => { throw new Error('denied'); } });
  const view = render(<FlumeApp controller={controller} components={parts} autoStart={false} initialView="home" />);
  assert.equal(view.queryByRole('button', { name: /Continue editing/ }), null);
  assert.equal(view.getAllByRole('button', { name: 'Create project' }).length, 2);
  Object.defineProperty(window.localStorage, 'getItem', { configurable: true, value: original });
});

test('held navigation is visibly disabled and project actions include project context', async () => {
  const controller = new WorkspaceController({ listProjects: async () => projects, getWorkspace: async () => workspace(), command: async () => ({ commandId: 'unused', projectId: 'p1' }), uploadAsset: async () => { throw new Error('unused'); } });
  await controller.start();
  (controller as any).update({ busy: 'checking' });
  const view = render(<FlumeApp controller={controller} components={parts} autoStart={false} initialView="home" />);
  assert.equal((view.getByRole('button', { name: 'Home' }) as HTMLButtonElement).disabled, true);
  assert.equal((view.getByRole('button', { name: 'Build a shot in Alpine Study' }) as HTMLButtonElement).disabled, true);
  assert.ok(view.getByRole('group', { name: 'Alpine Study actions' }));
});

test('home project intents hydrate then open their existing behaviors', async () => {
  const controller = new WorkspaceController({ listProjects: async () => projects, getWorkspace: async id => workspace(projects.find(project => project.id === id), true), command: async () => ({ commandId: 'unused', projectId: 'p1' }), uploadAsset: async () => { throw new Error('unused'); } });
  await controller.start();
  const view = render(<FlumeApp controller={controller} components={parts} autoStart={false} initialView="home" />);
  fireEvent.click(view.getByRole('button', { name: 'Build a shot in Alpine Study' })); await settle();
  assert.ok(view.getByRole('dialog', { name: 'Create a shot' }));
});
