import '../../../packages/activity-review/test/setup.tsx';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FlumeApp } from '../src/App.tsx';
import { WorkspaceController } from '../src/controller.ts';
import { frameState, reelStatus, shotPhase } from '../src/shot-status.ts';
import type { WorkspaceComponents } from '../src/ports.ts';
import type { Asset, Attempt, Command, Shot, Workspace } from '../src/types.ts';

Object.assign(globalThis, { React });
HTMLElement.prototype.scrollIntoView = () => {};
afterEach(() => cleanup());

const parts: WorkspaceComponents = {
  Brand: () => <span>Flume</span>,
  ShotEditor: ({ shot }) => <div>Editor for {shot.title}</div>,
  TakeReview: ({ takes }) => <div>Take review probe ({takes.length})</div>,
  ActivityPanel: ({ attempts }) => <div>Activity probe ({attempts.map(item => item.id).join(',') || 'none'})</div>,
  GenerationReview: ({ review }) => <div>Review {review.id}</div>,
};
const image = (id: string, filename: string, extra: Partial<Asset> = {}): Asset => ({ id, projectId: 'p', filename, kind: 'image', origin: 'imported', sha256: `sha-${id}`, mediaUrl: `/api/media/${id}`, width: 1280, height: 720, ...extra });
const shot = (id: string, title: string, extra: Partial<Shot> = {}): Shot => ({ id, projectId: 'p', title, prompt: `Direction for ${title}`, revision: 1, selectionRevision: 0, selectedTakeId: null, controls: { modelId: 'start-only', durationSeconds: 5, resolution: '720p', aspectRatio: '16:9', generateAudio: false }, bindings: { firstFrameAssetId: null, lastFrameAssetId: null }, ...extra });
const attempt = (id: string, shotId: string, status: Attempt['status']): Attempt => ({ id, projectId: 'p', shotId, shotRevision: 1, status, providerJobId: null, errorCode: null, message: null });

function base(): Workspace {
  return {
    project: { id: 'p', name: 'Stage Four', brief: 'A short film', revision: 1 },
    shots: [
      shot('s1', 'Into the trees', { bindings: { firstFrameAssetId: 'a1', lastFrameAssetId: 'a2' } }),
      shot('s2', 'Clearing', { controls: { modelId: 'start-only', durationSeconds: 8, resolution: '720p', aspectRatio: '16:9', generateAudio: false }, bindings: { firstFrameAssetId: 'gone', lastFrameAssetId: null } }),
      shot('s3', 'Clearing'),
    ],
    assets: [image('a1', 'wide.png'), image('a2', 'close.png'), image('a3', 'wide.png'), image('remote', 'remote.png', { mediaUrl: 'https://provider.invalid/x.png' })],
    takes: [{ id: 't1', projectId: 'p', shotId: 's1', attemptId: 'x1', assetId: 'v1', createdAt: '2026-01-01T00:00:00Z' }],
    attempts: [attempt('x1', 's1', 'ready'), attempt('x2', 's1', 'running'), attempt('x3', 's2', 'acceptance_unknown')],
    reviews: [], exports: [],
    capabilities: [{ modelId: 'start-only', name: 'Start-only model', durations: [5, 8], resolutions: ['720p'], frameRoles: ['first_frame'], seedSupported: false, availability: 'available', blocker: null }],
  };
}
async function mount(workspace = base()) {
  const commands: Command[] = [];
  const controller = new WorkspaceController({
    listProjects: async () => [workspace.project!], getWorkspace: async () => structuredClone(workspace),
    command: async command => { commands.push(command); throw new Error('Looking must not command'); },
    uploadAsset: async () => { throw new Error('Looking must not upload'); },
  });
  await controller.openProject('p');
  render(<FlumeApp controller={controller} components={parts} autoStart={false} />);
  return { controller, commands };
}

test('frame states come from the saved binding and the model’s reported roles, never assumed', () => {
  const ws = base();
  assert.equal(frameState(ws.shots[0]!, 'firstFrameAssetId', ws).kind, 'supported');
  assert.equal(frameState(ws.shots[0]!, 'lastFrameAssetId', ws).label, 'Kept · not supported');
  assert.equal(frameState(ws.shots[1]!, 'firstFrameAssetId', ws).kind, 'missing');
  assert.equal(frameState(ws.shots[2]!, 'firstFrameAssetId', ws).kind, 'empty');
  assert.equal(frameState({ ...ws.shots[0]!, controls: { ...ws.shots[0]!.controls, modelId: 'not-in-catalog' } }, 'firstFrameAssetId', ws).kind, 'unknown');
  // A video with the bound ID is not an image frame.
  assert.equal(frameState(ws.shots[0]!, 'firstFrameAssetId', { ...ws, assets: [{ ...image('a1', 'wide.mp4'), kind: 'video' }] }).kind, 'missing');
});

test('phase and reel status prefer uncertain and blocking facts over routine ones', () => {
  const ws = base();
  assert.equal(shotPhase(ws.shots[0]!, ws).label, 'Generating');
  assert.equal(shotPhase(ws.shots[0]!, ws, { dirty: true }).label, 'Unsaved edits');
  assert.equal(shotPhase(ws.shots[1]!, ws).label, 'State unknown');
  assert.deepEqual(reelStatus(ws.shots[1]!, ws), { tone: 'warn', text: 'State unknown' });
  assert.deepEqual(reelStatus(ws.shots[1]!, { ...ws, attempts: [] }), { tone: 'err', text: 'Missing frame' });
  const review = { id: 'r', projectId: 'p', shotId: 's3', shotRevision: 1, requestHash: 'h', prompt: '', controls: ws.shots[2]!.controls, bindings: ws.shots[2]!.bindings, estimatedCostUsd: null, blockers: [], approved: true };
  assert.equal(shotPhase(ws.shots[2]!, ws, { review }).label, 'Approved · not sent');
  assert.equal(shotPhase(ws.shots[2]!, ws, { review: { ...review, shotRevision: 0 } }).label, 'Draft', 'a review for another revision is not this shot’s phase');
  assert.equal(shotPhase({ ...ws.shots[2]!, selectedTakeId: 'x' }, ws).label, 'Take selected');
});

test('the stage shows saved frames with honest chips, a literal missing ID and no invented progress', async () => {
  await mount();
  const stage = screen.getByRole('main', { name: 'Stage' });
  const start = within(stage).getByRole('figure', { name: 'Start frame' });
  const end = within(stage).getByRole('figure', { name: 'End frame' });
  assert.match(start.textContent!, /Supported/);
  assert.match(end.textContent!, /Kept · not supported/);
  assert.match(end.textContent!, /review stays blocked/);
  assert.equal((within(start).getByRole('img') as HTMLImageElement).getAttribute('src'), '/api/media/a1');
  assert.match(stage.textContent!, /Saved direction.*Direction for Into the trees/);
  const run = within(stage).getByRole('status');
  assert.match(run.textContent!, /Generating/);
  assert.doesNotMatch(run.textContent!, /%|remaining|ETA/);
  assert.equal(screen.getByRole('complementary', { name: 'Shot slate' }).querySelector('[data-phase]')!.textContent, 'Generating');
  fireEvent.click(screen.getByRole('button', { name: /Open shot: Clearing \(shot 2 of 3/ }));
  const missing = within(screen.getByRole('main', { name: 'Stage' })).getByRole('figure', { name: 'Start frame' });
  assert.match(missing.textContent!, /File not found.*gone/);
  assert.match(screen.getByRole('main', { name: 'Stage' }).textContent!, /Status unknown.*another charge/);
  assert.equal(screen.getByRole('main', { name: 'Stage' }).querySelector('.fl-bar'), null, 'uncertain work shows no progress bar');
});

test('takes are an explicit stage view that resets when another shot opens', async () => {
  const { commands } = await mount();
  assert.equal(screen.queryByText(/Take review probe/), null);
  fireEvent.click(screen.getByRole('button', { name: /^Takes/ }));
  assert.ok(screen.getByText('Take review probe (1)'));
  fireEvent.click(screen.getByRole('button', { name: /Open shot: Clearing \(shot 3 of 3/ }));
  assert.equal(screen.queryByText(/Take review probe/), null);
  assert.equal(screen.getByRole('button', { name: 'Frames' }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(commands, []);
});

test('the reel sizes clips by saved duration, disambiguates titles and holds navigation during uncertain work', async () => {
  const { controller } = await mount();
  const track = document.querySelector<HTMLElement>('.fl-reel__track')!;
  assert.match(track.style.gridTemplateColumns, /5fr.*8fr.*5fr/);
  assert.match(document.querySelector('.fl-reel__bar')!.textContent!, /3 shots · 00:18/);
  const clips = within(screen.getByRole('navigation', { name: 'Shots' })).getAllByRole('button');
  assert.deepEqual(clips.map(item => item.getAttribute('aria-label')), ['Open shot: Into the trees', 'Open shot: Clearing (shot 2 of 3 in Stage Four)', 'Open shot: Clearing (shot 3 of 3 in Stage Four)', 'Add shot']);
  assert.equal(clips[0]!.getAttribute('aria-current'), 'page');
  assert.match(clips[1]!.textContent!, /State unknown/);
  assert.equal(screen.getByRole('button', { name: 'Sound' }).hasAttribute('disabled'), true);
  assert.match(document.body.textContent!, /Sound lanes aren’t available in this build/);
  act(() => controller.reportError({ code: 'X', message: 'held' }));
  // A plain error does not hold navigation; an uncertain command does.
  assert.equal(clips[1]!.getAttribute('aria-disabled'), null);
});

test('FlumeApp refreshes the WorkspaceController after chat apply without clearing edits made in flight', async () => {
  const workspace = base(); let reads = 0, resolveApply!: (value: any) => void;
  const controller = new WorkspaceController({
    listProjects: async () => [workspace.project!], getWorkspace: async () => { reads++; return structuredClone(workspace); },
    command: async () => { throw Error('chat apply uses the server port'); }, uploadAsset: async () => { throw Error('unused'); },
  });
  await controller.openProject('p'); const target = workspace.shots[0]!;
  const proposal = { id: 'proposal', shotId: target.id, instruction: 'Tighten', before: { title: target.title, prompt: target.prompt, revision: target.revision }, after: { title: 'Tighter', prompt: 'A tighter direction' }, rationale: 'Specific', status: 'pending' as const, failure: null, appliedRevision: null };
  const chatPort: any = { models: async () => ['google/gemini-2.5-flash-lite'], list: async () => [{ id: 'conversation', projectId: 'p', title: 'Scene', modelId: 'google/gemini-2.5-flash-lite', messages: [], proposals: [proposal] }], create: async () => { throw Error('unused'); }, rename: async () => { throw Error('unused'); }, stream: async () => {}, propose: async () => { throw Error('unused'); }, dismissProposal: async () => { throw Error('unused'); }, applyProposal: async () => new Promise(resolve => { resolveApply = resolve; }) };
  render(<FlumeApp controller={controller} components={parts} chatPort={chatPort} autoStart={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Chat' })); await React.act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await React.act(async () => controller.markDirty(target.id));
  await React.act(async () => resolveApply({ ...proposal, status: 'applied', appliedRevision: 2 }));
  assert.equal(reads, 2, 'initial open plus authoritative apply readback');
  assert.equal(controller.getSnapshot().dirtyShotIds.has(target.id), true, 'in-flight edits remain dirty');
  assert.match(document.body.textContent ?? '', /Applied · saved revision 2/);
});

test('the activity drawer groups every attempt by shot, counts what needs watching and returns focus on Escape', async () => {
  const { commands } = await mount();
  const opener = screen.getByRole('button', { name: /^Activity/ });
  assert.match(opener.textContent!, /2 to watch/);
  assert.equal(opener.querySelector('.fl-count')!.getAttribute('data-tone'), 'unknown');
  // jsdom has no layout; give the opener a box so the shared eligibility guard can run.
  opener.getClientRects = () => [{ width: 80, height: 24 }] as unknown as DOMRectList;
  opener.focus();
  fireEvent.click(opener);
  const drawer = screen.getByRole('dialog', { name: 'Activity' });
  assert.equal(drawer.getAttribute('aria-modal'), 'false');
  assert.ok(document.activeElement === within(drawer).getByRole('heading', { name: 'Activity' }), 'opening focuses the drawer title');
  assert.ok(within(drawer).getByText('Activity probe (x1,x2)'));
  assert.ok(within(drawer).getByText('Activity probe (x3)'));
  assert.match(drawer.textContent!, /Shot 01 · Into the trees.*Shot 02 · Clearing/);
  fireEvent.keyDown(drawer, { key: 'Escape' });
  assert.equal(screen.queryByRole('dialog', { name: 'Activity' }), null);
  assert.ok(document.activeElement === opener, 'Escape returns focus to the opener');
  assert.deepEqual(commands, []);
});

test('the library inspects without changing a shot and labels same-name files and real usage', async () => {
  const { controller, commands } = await mount();
  const before = structuredClone(controller.getSnapshot().workspace!.shots);
  fireEvent.click(screen.getByRole('button', { name: /^Library/ }));
  const drawer = screen.getByRole('dialog', { name: 'Library' });
  assert.match(drawer.textContent!, /Looking at an image never changes a shot/);
  const tiles = within(drawer).getAllByRole('button', { name: /^Inspect / });
  assert.equal(tiles.length, 4);
  fireEvent.click(within(drawer).getByRole('button', { name: /^Inspect wide\.png, same name as another file, used in 1 place/ }));
  const inspector = within(drawer).getByRole('group', { name: 'Inspecting wide.png' });
  assert.match(inspector.textContent!, /Shot 01 · start frame/);
  assert.match(inspector.textContent!, /1 other file has this name/);
  assert.match(inspector.textContent!, /sha-a1/);
  // A non-owned media URL never becomes an <img> source.
  assert.ok(![...drawer.querySelectorAll('img')].some(img => /provider\.invalid/.test(img.getAttribute('src') ?? '')));
  fireEvent.change(within(drawer).getByLabelText('Search project media'), { target: { value: 'close' } });
  assert.equal(within(drawer).getAllByRole('button', { name: /^Inspect / }).length, 1);
  assert.deepEqual(controller.getSnapshot().workspace!.shots, before);
  assert.deepEqual(commands, []);
});

test('the export drawer reports per-shot facts and keeps whole-film export explicitly unavailable', async () => {
  const workspace = base();
  workspace.shots[0] = { ...workspace.shots[0]!, selectedTakeId: 't1' };
  workspace.assets.push({ ...image('out', 'export.mp4'), kind: 'video', origin: 'generated' });
  workspace.exports = [{ id: 'e1', projectId: 'p', shotId: 's1', takeId: 't1', shotRevision: 1, selectionRevision: 0, status: 'ready', assetId: 'out', stale: false }];
  const { commands } = await mount(workspace);
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  const drawer = screen.getByRole('dialog', { name: 'Export' });
  assert.match(drawer.textContent!, /Whole-film export isn’t available in this build/);
  assert.match(drawer.textContent!, /2 of 3 shots have no selected take/);
  assert.equal(within(drawer).getByRole('link', { name: 'Download' }).getAttribute('href'), '/api/media/out');
  assert.equal(within(drawer).queryByRole('button', { name: /Export/ }), null, 'no film-level export control pretends to work');
  fireEvent.click(within(drawer).getAllByRole('button', { name: 'Open takes' })[0]!);
  assert.ok(screen.getByText('Take review probe (1)'));
  assert.deepEqual(commands, []);
});

test('the projects drawer opens from the project switcher and creation stays an explicit dialog', async () => {
  const { commands } = await mount();
  fireEvent.click(screen.getByRole('button', { name: /^Stage Four/ }));
  const drawer = screen.getByRole('dialog', { name: 'Projects' });
  assert.equal(within(drawer).getByRole('button', { name: 'Open project: Stage Four' }).getAttribute('aria-current'), 'true');
  fireEvent.click(within(drawer).getByRole('button', { name: 'New project' }));
  assert.ok(screen.getByRole('dialog', { name: 'Create a project' }));
  assert.deepEqual(commands, []);
});
