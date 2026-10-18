import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { ProjectRail, type ProjectRailProps } from '../src/ProjectRail.tsx';
import type { Project, Shot } from '../src/types.ts';

// Explicit test fixtures, never production defaults or a live workspace.
const projects: Project[] = [
  { id: 'project:α', name: 'Dawn study', brief: '', revision: 1 },
  { id: 'project/β', name: 'Night study', brief: '', revision: 2 },
];
function shot(id: string, title: string, projectId = projects[0].id): Shot {
  return { id, projectId, title, prompt: '', revision: 1, controls: { modelId: 'test-only', durationSeconds: 5, resolution: '720p', aspectRatio: '16:9', generateAudio: false }, bindings: { firstFrameAssetId: null, lastFrameAssetId: null }, selectedTakeId: null, selectionRevision: 0 };
}
const shots = [shot('shot:α', 'Open window'), shot('shot/β', 'Crossing')];

async function mount(overrides: Partial<ProjectRailProps> = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://rail.test' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const calls: unknown[][] = [];
  const props: ProjectRailProps = {
    projects, shots, activeProjectId: projects[0].id, activeShotId: shots[0].id, collapsed: false,
    onProjectActivate: id => { calls.push(['project', id]); },
    onShotActivate: id => { calls.push(['shot', id]); },
    onCreateProject: () => { calls.push(['create-project']); },
    onCreateShot: () => { calls.push(['create-shot']); },
    onCollapsedChange: value => { calls.push(['collapsed', value]); },
    ...overrides,
  };
  const root = createRoot(dom.window.document.getElementById('root')!);
  const render = async (next: Partial<ProjectRailProps> = {}) => { Object.assign(props, next); await act(async () => { root.render(<ProjectRail {...props} />); }); };
  const button = (label: string) => {
    const found = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>('button')).find(item => item.getAttribute('aria-label') === label || item.textContent === label);
    assert.ok(found, `Missing button: ${label}`);
    return found;
  };
  const click = async (label: string) => { await act(async () => { button(label).click(); }); };
  try { await render(); } catch (error) { await act(async () => { root.unmount(); }); dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } throw error; }
  return { dom, props, calls, render, button, click, async close() {
    await act(async () => { root.unmount(); }); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  } };
}

test('full long names, supplied order and take-selection facts survive compact rendering', async () => {
  const longName = 'A project <not markup> & ' + 'long'.repeat(80);
  const longTitle = 'A shot <script> & ' + 'wide'.repeat(90);
  const selected = { ...shots[1], title: longTitle, selectedTakeId: 'take:saved' };
  const ui = await mount({ projects: [{ ...projects[0], name: longName }], shots: [selected, shots[0]], activeShotId: selected.id, collapsed: true });
  try {
    const projectButton = ui.button(`Open project: ${longName}`);
    const shotButton = ui.button(`Open shot: ${longTitle}`);
    assert.ok(projectButton.textContent?.includes(longName));
    assert.ok(shotButton.textContent?.includes(longTitle));
    assert.equal(projectButton.title, longName);
    assert.equal(shotButton.title, longTitle);
    const descriptionId = shotButton.getAttribute('aria-describedby');
    assert.ok(descriptionId, 'take-selection fact must be described even with the full-name aria-label');
    assert.equal(ui.dom.window.document.getElementById(descriptionId)?.textContent, 'Take selected');
    assert.match(shotButton.textContent!, /Take selected/);
    assert.match(shotButton.textContent!, /Current shot/);
    assert.match(ui.button('Open shot: Open window').textContent!, /No take selected/);
    assert.equal(ui.dom.window.document.querySelectorAll('script').length, 0);
    const rendered = Array.from(ui.dom.window.document.querySelectorAll('nav[aria-label="Shots"] li button'));
    assert.deepEqual(rendered.map(item => item.getAttribute('aria-label')), [`Open shot: ${longTitle}`, 'Open shot: Open window']);
    assert.ok(rendered.every(item => item.getAttribute('type') === 'button'));
    await ui.click(`Open shot: ${longTitle}`);
    assert.deepEqual(ui.calls, [['shot', selected.id]]);
  } finally { await ui.close(); }
});

test('returned unselected takes retain the review cue without inventing selection', async () => {
  const take = { id: 'returned', projectId: projects[0].id, shotId: shots[0].id, attemptId: 'attempt', assetId: 'media', createdAt: '2026-01-01T00:00:00Z' };
  const ui = await mount({ takes: [take, { ...take, id: 'foreign', projectId: projects[1].id, shotId: shots[1].id }] });
  try {
    assert.match(ui.button('Open shot: Open window').textContent!, /Takes to review/);
    assert.match(ui.button('Open shot: Crossing').textContent!, /No take selected/);
    const id = ui.button('Open shot: Open window').getAttribute('aria-describedby')!;
    assert.equal(ui.dom.window.document.getElementById(id)?.textContent, 'Takes to review');
    assert.equal(ui.props.shots[0].selectedTakeId, null);
    assert.deepEqual(ui.calls, []);
    await ui.render({ shots: [{ ...shots[0], selectedTakeId: 'chosen' }, shots[1]] });
    assert.equal(ui.dom.window.document.getElementById(id)?.textContent, 'Take selected');
    await ui.render({ shots, takes: [] });
    assert.equal(ui.dom.window.document.getElementById(id)?.textContent, 'No take selected');
  } finally { await ui.close(); }
});

test('loading and failed data are not presented as verified zero counts', async () => {
  const ui = await mount({ projects: [], shots: [], activeProjectId: null, activeShotId: null, dataState: 'loading' });
  try {
    const counts = () => Array.from(ui.dom.window.document.querySelectorAll('.fl-project-rail__count')).map(el => el.textContent);
    assert.deepEqual(counts(), ['—', '—']);
    assert.match(ui.dom.window.document.body.textContent!, /Loading projects/);
    assert.match(ui.dom.window.document.body.textContent!, /Loading shots/);
    assert.doesNotMatch(ui.dom.window.document.body.textContent!, /No projects yet|No shots yet|Choose a project/);
    await ui.render({ dataState: 'error' });
    assert.deepEqual(counts(), ['—', '—']);
    assert.match(ui.dom.window.document.body.textContent!, /Projects unavailable/);
    assert.match(ui.dom.window.document.body.textContent!, /Shots unavailable/);
    assert.doesNotMatch(ui.dom.window.document.body.textContent!, /No projects yet|No shots yet|Choose a project/);
    await ui.render({ dataState: 'ready' });
    assert.deepEqual(counts(), ['0', '0']);
    assert.match(ui.dom.window.document.body.textContent!, /No projects yet/);
    await ui.render({ projects, shots, activeProjectId: projects[0].id, activeShotId: shots[0].id });
    const row = ui.button('Open shot: Open window');
    await ui.render({ dataState: 'loading', disabled: true });
    assert.ok(ui.button('Open shot: Open window') === row, 'cached rows retain identity during a load');
    assert.deepEqual(counts(), ['—', '—']);
    await ui.render({ dataState: 'ready', disabled: false });
    assert.deepEqual(counts(), ['2', '2']);
  } finally { await ui.close(); }
});

test('duplicate names have ordinal accessible context while callbacks retain literal IDs', async () => {
  const name = '<same project> & α';
  const title = '<same shot> & β';
  const ui = await mount({ projects: projects.map(project => ({ ...project, name })), shots: shots.map(shot => ({ ...shot, title })) });
  try {
    const projectLabels = [`Open project: ${name} (project 1 of 2)`, `Open project: ${name} (project 2 of 2)`];
    const shotLabels = [`Open shot: ${title} (shot 1 of 2 in ${name})`, `Open shot: ${title} (shot 2 of 2 in ${name})`];
    const labels = () => Array.from(ui.dom.window.document.querySelectorAll('.fl-project-rail__item')).map(el => el.getAttribute('aria-label'));
    assert.deepEqual(labels(), [...projectLabels, ...shotLabels]);
    assert.equal(ui.button(projectLabels[1]).title, name);
    assert.equal(ui.button(shotLabels[1]).title, title);
    await ui.click(projectLabels[1]); await ui.click(shotLabels[1]);
    assert.deepEqual(ui.calls, [['project', projects[1].id], ['shot', shots[1].id]]);
    assert.equal(ui.button(shotLabels[0]).getAttribute('aria-current'), 'page');
    await ui.render({ collapsed: true, disabled: true });
    assert.deepEqual(labels(), [...projectLabels, ...shotLabels]);
    await ui.click(shotLabels[1]);
    assert.equal(ui.calls.length, 2);
    assert.equal(ui.dom.window.document.querySelectorAll('.fl-project-rail script').length, 0);
  } finally { await ui.close(); }
});

test('collapse only requests a density change and preserves navigation nodes and focus', async () => {
  const ui = await mount();
  try {
    const toggle = ui.button('Collapse project rail');
    toggle.focus();
    const current = ui.button('Open shot: Open window');
    await ui.click('Collapse project rail');
    assert.deepEqual(ui.calls, [['collapsed', true]]);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'parent may decline collapse');
    await ui.render({ collapsed: true });
    assert.ok(ui.button('Expand project rail') === toggle);
    assert.ok(ui.button('Open shot: Open window') === current);
    assert.ok(ui.dom.window.document.activeElement === toggle);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    const controlledId = toggle.getAttribute('aria-controls');
    assert.ok(controlledId && ui.dom.window.document.getElementById(controlledId));
    current.focus();
    await ui.render({ collapsed: false });
    assert.ok(ui.dom.window.document.activeElement === current);
    await ui.render({ collapsed: true, disabled: true });
    await ui.click('Expand project rail');
    assert.deepEqual(ui.calls.at(-1), ['collapsed', false], 'density remains usable during a hold');
  } finally { await ui.close(); }
});

test('empty and stale selections never invent records, auto-select or enable shot creation', async () => {
  const ui = await mount({ projects: [], shots: [], activeProjectId: null, activeShotId: null });
  try {
    assert.match(ui.dom.window.document.body.textContent!, /No projects yet/);
    assert.match(ui.dom.window.document.body.textContent!, /Choose a project to see its shots/);
    assert.equal(ui.dom.window.document.querySelectorAll('li').length, 0);
    assert.equal(ui.button('Add shot').getAttribute('aria-disabled'), 'true');
    await ui.click('Add shot');
    assert.deepEqual(ui.calls, []);
    await ui.click('New project');
    assert.deepEqual(ui.calls, [['create-project']]);
    await ui.render({ projects, activeProjectId: projects[0].id });
    assert.match(ui.dom.window.document.body.textContent!, /No shots yet/);
    assert.equal(ui.button('Add shot').hasAttribute('aria-disabled'), false);
    await ui.render({ shots: [...shots, shot('foreign', 'Other project shot', projects[1].id)], activeShotId: 'foreign' });
    assert.equal(ui.dom.window.document.querySelectorAll('nav[aria-label="Shots"] li').length, 2);
    assert.doesNotMatch(ui.dom.window.document.body.textContent!, /Other project shot/);
    assert.equal(ui.dom.window.document.querySelectorAll('[aria-current="page"]').length, 0);
    await ui.render({ activeProjectId: 'missing-project' });
    assert.equal(ui.dom.window.document.querySelectorAll('nav[aria-label="Shots"] li').length, 0);
    assert.equal(ui.button('Add shot').getAttribute('aria-disabled'), 'true');
    assert.deepEqual(ui.calls, [['create-project']]);
  } finally { await ui.close(); }
});

test('creation is an inert request to the parent, and a hold preserves focus while blocking actions', async () => {
  const ui = await mount();
  try {
    await ui.click('New project');
    await ui.click('Add shot');
    assert.deepEqual(ui.calls, [['create-project'], ['create-shot']]);
    const focused = ui.button('Open shot: Crossing');
    focused.focus();
    await ui.render({ disabled: true });
    assert.ok(ui.dom.window.document.activeElement === focused, 'hold must not blur an initiating control');
    for (const label of ['Open project: Night study', 'Open shot: Crossing', 'New project', 'Add shot']) {
      assert.equal(ui.button(label).getAttribute('aria-disabled'), 'true');
      await ui.click(label);
    }
    assert.deepEqual(ui.calls, [['create-project'], ['create-shot']]);
    await ui.render({ disabled: false });
    assert.ok(ui.dom.window.document.activeElement === focused);
    await ui.click('Open shot: Crossing');
    assert.deepEqual(ui.calls.at(-1), ['shot', 'shot/β']);
    assert.equal(ui.dom.window.document.querySelectorAll('dialog, form, a, input').length, 0);
  } finally { await ui.close(); }
});

test('activation sends exact supplied identities without optimistic selection or command side effects', async () => {
  const ui = await mount();
  try {
    assert.deepEqual(ui.calls, [], 'render is inert');
    await ui.click('Open project: Night study');
    await ui.click('Open shot: Crossing');
    assert.deepEqual(ui.calls, [['project', 'project/β'], ['shot', 'shot/β']]);
    assert.equal(ui.button('Open project: Dawn study').getAttribute('aria-current'), 'true');
    assert.equal(ui.button('Open shot: Open window').getAttribute('aria-current'), 'page');
    assert.equal(ui.button('Open shot: Crossing').hasAttribute('aria-current'), false);
    await ui.render({ activeShotId: shots[1].id });
    assert.equal(ui.button('Open shot: Crossing').getAttribute('aria-current'), 'page');
    assert.equal(ui.button('Open shot: Open window').hasAttribute('aria-current'), false);
    assert.equal(ui.calls.length, 2, 'readback does not dispatch callbacks');
  } finally { await ui.close(); }
});
