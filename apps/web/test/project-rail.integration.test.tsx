import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { FlumeApp } from '../src/App.tsx';
import { WorkspaceController } from '../src/controller.ts';
import type { WorkspaceComponents } from '../src/ports.ts';
import type { Workspace } from '../src/types.ts';

const parts: WorkspaceComponents = {
  Brand: () => <span>Flume</span>, ShotEditor: () => <div>Editor</div>,
  TakeReview: () => <div>Takes</div>, ActivityPanel: () => <div>Activity</div>, GenerationReview: () => <div>Review</div>,
};
const empty: Workspace = { project: null, shots: [], assets: [], takes: [], attempts: [], reviews: [], exports: [], capabilities: [] };
const project = { id: 'project:α', name: 'Project', brief: '', revision: 1 };
function fixture(workspace: Workspace = empty) {
  const behavior = { failList: false, failWorkspace: false };
  const controller = new WorkspaceController({
    listProjects: async () => { if (behavior.failList) throw new Error('List unavailable'); return workspace.project ? [workspace.project] : []; },
    getWorkspace: async () => { if (behavior.failWorkspace) throw new Error('Workspace unavailable'); return workspace; },
    command: async () => { throw new Error('Rendering must not issue commands'); },
    uploadAsset: async () => { throw new Error('Rendering must not upload'); },
  });
  return { controller, behavior };
}
function inspect(controller: WorkspaceController) {
  const dom = new JSDOM(renderToStaticMarkup(<FlumeApp controller={controller} components={parts} autoStart={false} />));
  try {
    const rail = dom.window.document.querySelector('.fl-project-rail')!;
    const media = dom.window.document.querySelector<HTMLButtonElement>('.fl-workspace__library-button')!;
    return {
      counts: [...rail.querySelectorAll('.fl-project-rail__count')].map(el => el.textContent),
      text: rail.textContent!, media: media.textContent, mediaDisabled: media.disabled,
      alert: dom.window.document.querySelector('[role="alert"]')?.textContent,
      descriptions: [...rail.querySelectorAll('.fl-project-rail__take')].map(el => el.textContent),
      current: rail.querySelector('[aria-current="page"]')?.getAttribute('aria-label'),
      projectCurrent: rail.querySelector('.fl-project-rail__project[aria-current]')?.getAttribute('aria-label'),
    };
  } finally { dom.window.close(); }
}

test('App maps idle/loading and failed project reads to unavailable rail counts, then verified empty to zero', async () => {
  const { controller, behavior } = fixture();
  let view = inspect(controller);
  assert.deepEqual(view.counts, ['—', '—']);
  assert.match(view.text, /Loading shots/);
  assert.equal(view.media, 'Project media—');
  assert.equal(view.mediaDisabled, true);
  behavior.failWorkspace = true;
  const opening = controller.openProject('project:α');
  assert.deepEqual(inspect(controller).counts, ['—', '—']);
  await opening;
  view = inspect(controller);
  assert.deepEqual(view.counts, ['—', '—']);
  assert.match(view.text, /Shots unavailable/);
  assert.doesNotMatch(view.text, /Choose a project|No shots yet/);
  assert.match(view.alert!, /Workspace unavailable/);
  assert.equal(view.media, 'Project media—');
  behavior.failWorkspace = false;
  await controller.openProject();
  assert.deepEqual(inspect(controller).counts, ['0', '0']);
  assert.equal(inspect(controller).media, 'Project media0');
});

test('initial project-list error is not a verified empty list', async () => {
  const { controller, behavior } = fixture();
  behavior.failList = true;
  await controller.start();
  const view = inspect(controller);
  assert.deepEqual(view.counts, ['—', '—']);
  assert.match(view.text, /Projects unavailable/);
  assert.doesNotMatch(view.text, /No projects yet/);
  assert.match(view.alert!, /List unavailable/);
});

test('App preserves authoritative project fallback and all take cues without selecting a returned take', async () => {
  const shot = (id: string, selectedTakeId: string | null = null) => ({ id, projectId: project.id, title: id, prompt: '', revision: 1, selectionRevision: 0, selectedTakeId, controls: { modelId: 'fixture', durationSeconds: 5, resolution: '720p', aspectRatio: '16:9', generateAudio: false }, bindings: { firstFrameAssetId: null, lastFrameAssetId: null } });
  const workspace: Workspace = { ...empty, project, shots: [shot('no-take'), shot('returned'), shot('selected', 'chosen')], takes: [{ id: 'returned-take', projectId: project.id, shotId: 'returned', attemptId: 'attempt', assetId: 'owned', createdAt: '2026-01-01T00:00:00Z' }] };
  const { controller } = fixture(workspace);
  // Direct open leaves project index empty; current authoritative project must survive.
  await controller.openProject(project.id);
  let view = inspect(controller);
  assert.deepEqual(view.counts, ['1', '3']);
  assert.equal(view.projectCurrent, 'Open project: Project');
  assert.deepEqual(view.descriptions, ['No take selected', 'Takes to review', 'Take selected']);
  assert.equal(controller.getSnapshot().workspace?.shots[1].selectedTakeId, null);
  assert.equal(view.current, 'Open shot: no-take');
  assert.equal(view.mediaDisabled, false);
  controller.reportError({ code: 'READBACK_FAILED', message: 'Accepted but readback unavailable' });
  view = inspect(controller);
  assert.deepEqual(view.counts, ['1', '3'], 'loaded snapshot is not erased by a command readback error');
  assert.match(view.alert!, /readback unavailable/);
});
