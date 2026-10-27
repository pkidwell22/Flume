import '../../../packages/shot-editor/test/setup.ts';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React, { useEffect, useRef } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FlumeApp } from '../src/App.tsx';
import { WorkspaceController } from '../src/controller.ts';
import { createReferenceProvenanceApi } from '../src/reference-provenance.ts';
import { workspaceComponents } from '../src/composition.ts';
import { ExportDrawer } from '../src/Drawers.tsx';
import type { ShotEditorProps } from '../src/ports.ts';
import type { Command, Shot, Workspace } from '../src/types.ts';

// The shipped App, controller, composition and Export drawer, with fixture ports only.
Object.assign(globalThis, { React });
afterEach(cleanup);

const PROJECT = '5a1f5c1e-0000-4000-8000-000000000001';
const SHOT_A = '5a1f5c1e-0000-4000-8000-000000000002';
const SHOT_B = '5a1f5c1e-0000-4000-8000-000000000003';
const SHOT_C = '5a1f5c1e-0000-4000-8000-000000000004';
const TAKE_A = '5a1f5c1e-0000-4000-8000-000000000005';
const VIDEO = '5a1f5c1e-0000-4000-8000-000000000006';
const IMAGE = '5a1f5c1e-0000-4000-8000-000000000007';
const OTHER_PROJECT = '5a1f5c1e-0000-4000-8000-000000000011';
const OTHER_IMAGE = '5a1f5c1e-0000-4000-8000-000000000008';
const OTHER_SHOT = '5a1f5c1e-0000-4000-8000-000000000012';
const FOREIGN_SHOT = '5a1f5c1e-0000-4000-8000-000000000013';

const controls = { modelId: 'acme/video-1', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false };
const SAVED_DIRECTION = 'A ridge at dawn, then a slow push toward the col.';
const DRAFT_DIRECTION = 'Draft direction that was never saved.';

function workspace(): Workspace {
  return {
    project: { id: PROJECT, name: 'Ridge line', brief: 'A short film about a ridge at dawn.', revision: 4 },
    shots: [
      { id: SHOT_A, projectId: PROJECT, title: 'The opening', prompt: SAVED_DIRECTION, revision: 2, selectionRevision: 0, selectedTakeId: null, controls, bindings: { firstFrameAssetId: IMAGE, lastFrameAssetId: null } },
      { id: SHOT_B, projectId: PROJECT, title: 'The climb', prompt: 'Hand over hand\non wet granite.', revision: 6, selectionRevision: 0, selectedTakeId: null, controls: { ...controls, durationSeconds: 8 }, bindings: { firstFrameAssetId: null, lastFrameAssetId: OTHER_IMAGE } },
      { id: SHOT_C, projectId: PROJECT, title: 'The summit', prompt: '雪 and light.', revision: 1, selectionRevision: 0, selectedTakeId: null, controls, bindings: { firstFrameAssetId: null, lastFrameAssetId: null } },
    ],
    assets: [
      { id: IMAGE, projectId: PROJECT, filename: 'ridge.png', kind: 'image', origin: 'imported', sha256: '1'.repeat(64), mediaUrl: `/api/media/${IMAGE}`, width: 1920, height: 1080 },
      { id: OTHER_IMAGE, projectId: OTHER_PROJECT, filename: 'elsewhere.png', kind: 'image', origin: 'imported', sha256: '2'.repeat(64), mediaUrl: `/api/media/${OTHER_IMAGE}`, width: 1920, height: 1080 },
    ],
    takes: [], attempts: [], reviews: [], exports: [], capabilities: [],
  };
}

/** The editor is a stub: it renders a draft and reports unsaved edits through the shipped wiring. */
function StubEditor(props: ShotEditorProps) {
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    props.onDirtyChange(true);
  }, [props]);
  return <div className="fl-shot-editor"><label>Direction<textarea defaultValue={DRAFT_DIRECTION} /></label></div>;
}

const components = { ...workspaceComponents, ShotEditor: StubEditor };

/** Blob-URL fixture: jsdom has no object URLs, so tests install recording ones. */
let created: Array<{ url: string; blob: Blob }> = [];
let revoked: string[] = [];
let clicked: Array<{ href: string; download: string; rel: string }> = [];
let originalClick: (() => void) | null = null;
let anchorPrototype: AnchorPrototype | null = null;
type StaticUrl = { createObjectURL?: unknown; revokeObjectURL?: unknown };
type AnchorPrototype = { click: () => void };

function installDownloads() {
  created = []; revoked = []; clicked = [];
  let sequence = 0;
  const url = URL as unknown as StaticUrl;
  url.createObjectURL = (blob: Blob) => { const value = `blob:fixture/${++sequence}`; created.push({ url: value, blob }); return value; };
  url.revokeObjectURL = (value: string) => { revoked.push(value); };
  // jsdom does not expose HTMLAnchorElement globally; patch the prototype of a real anchor.
  anchorPrototype = Object.getPrototypeOf(document.createElement('a')) as AnchorPrototype;
  originalClick = anchorPrototype.click;
  anchorPrototype.click = function click(this: HTMLAnchorElement) { clicked.push({ href: this.href, download: this.download, rel: this.rel }); };
}
function removeDownloads() {
  const url = URL as unknown as StaticUrl;
  url.createObjectURL = undefined;
  url.revokeObjectURL = undefined;
  if (anchorPrototype && originalClick) anchorPrototype.click = originalClick;
}

const flush = async () => { await act(async () => {}); };
const tick = async () => { await act(async () => { await new Promise<void>(resolve => { setTimeout(resolve, 0); }); }); };

async function mount(state: Workspace = workspace()) {
  const commands: Command[] = [];
  const fetches: string[] = [];
  const uploads: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    fetches.push(String(input));
    return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const controller = new WorkspaceController({
    listProjects: async () => [state.project!],
    getWorkspace: async () => structuredClone(state),
    command: async command => { commands.push(command); throw new Error('A download must not command'); },
    uploadAsset: async file => { uploads.push(file.name); throw new Error('A download must not upload'); },
  }, null, null, null, createReferenceProvenanceApi(fetcher));
  await controller.openProject(PROJECT);
  const view = render(<FlumeApp controller={controller} components={components} autoStart={false} />);
  await flush();
  return { controller, commands, fetches, uploads, view };
}

async function openExport() {
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await flush();
}
async function download(name: 'Markdown' | 'JSON') {
  fireEvent.click(screen.getByRole('button', { name: `Download shot list (${name})` }));
  await flush();
}
const bodyOf = async (index: number) => created[index]!.blob.text();
const shotListRegion = () => screen.getByRole('region', { name: 'Shot list' });

beforeEach(() => { installDownloads(); });
afterEach(() => { removeDownloads(); });

test('three saved shots with zero takes download both shot-list formats from the shipped Export drawer', async () => {
  const { commands, fetches, uploads } = await mount();
  await openExport();
  const section = shotListRegion();
  assert.match(section.textContent ?? '', /planning document/i);
  assert.match(section.textContent ?? '', /not rendered video/i);
  assert.equal(screen.getByRole('button', { name: 'Download shot list (Markdown)' }) !== null, true);
  assert.equal(screen.getByRole('button', { name: 'Download shot list (JSON)' }) !== null, true);

  await download('Markdown');
  assert.equal(created.length, 1);
  const markdown = await bodyOf(0);
  assert.match(markdown, /^# Shot list · Ridge line$/m);
  assert.ok(markdown.includes('A short film about a ridge at dawn.'));
  for (const text of ['The opening', 'The climb', 'The summit', SAVED_DIRECTION, '雪 and light.']) assert.ok(markdown.includes(text), text);
  assert.ok(markdown.indexOf('The opening') < markdown.indexOf('The climb'), 'reel order is preserved');
  assert.ok(markdown.includes('Hand over hand\non wet granite.'), 'a multiline saved direction survives');
  assert.equal(clicked.length, 1);
  assert.equal(clicked[0]!.download, 'ridge-line-shot-list.md');
  assert.match(within(section).getByRole('status').textContent ?? '', /Started the download/);

  await download('JSON');
  assert.equal(created.length, 2);
  const json = JSON.parse(await bodyOf(1)) as { format: string; project: { name: string; brief: string }; shots: Array<{ id: string; revision: number }> };
  assert.equal(json.format, 'flume-shot-list/v1');
  assert.equal(json.project.name, 'Ridge line');
  assert.equal(json.project.brief, 'A short film about a ridge at dawn.');
  assert.deepEqual(json.shots.map(item => item.id), [SHOT_A, SHOT_B, SHOT_C]);
  assert.deepEqual(json.shots.map(item => item.revision), [2, 6, 1]);
  assert.equal(clicked[1]!.download, 'ridge-line-shot-list.json');
  await tick();
  assert.deepEqual(revoked, created.map(item => item.url), 'both object URLs are released');

  assert.equal(commands.length, 0, 'a download is not a command');
  assert.equal(fetches.length, 0, 'a download performs no request');
  assert.equal(uploads.length, 0, 'a download uploads nothing');
});

test('the shot list uses the last saved state and leaves unsaved edits alone', async () => {
  const { controller, commands } = await mount();
  assert.equal(controller.getSnapshot().dirtyShotIds.size, 1, 'the editor reports an unsaved edit');
  await openExport();
  assert.match(shotListRegion().textContent ?? '', /unsaved edits/i);

  await download('Markdown');
  const markdown = await bodyOf(0);
  assert.ok(markdown.includes(SAVED_DIRECTION), 'the saved direction is exported');
  assert.equal(markdown.includes(DRAFT_DIRECTION), false, 'the unsaved draft is never exported');
  assert.equal(controller.getSnapshot().dirtyShotIds.size, 1, 'the draft is neither saved nor discarded');
  assert.equal(commands.length, 0);
});

test('another project’s media is named as unresolved, not borrowed', async () => {
  await mount();
  await openExport();
  await download('JSON');
  const json = JSON.parse(await bodyOf(0)) as { shots: Array<{ id: string; references: { start: { assetId: string; filename: string | null; status: string } | null; end: { assetId: string; filename: string | null; status: string } | null } }> };
  const climb = json.shots.find(item => item.id === SHOT_B)!;
  assert.deepEqual(climb.references.end, { assetId: OTHER_IMAGE, filename: null, status: 'not-in-project' });
  assert.deepEqual(json.shots.find(item => item.id === SHOT_A)!.references.start, { assetId: IMAGE, filename: 'ridge.png', status: 'saved-in-project' });
  assert.equal(JSON.stringify(json).includes('elsewhere.png'), false, 'another project’s filename never appears');
  await download('Markdown');
  assert.equal((await bodyOf(1)).includes('elsewhere.png'), false);
  assert.match(await bodyOf(1), /Not in this project/);
});

test('existing video-export readiness, links and the whole-film limitation are unchanged', async () => {
  const state = workspace();
  state.takes = [{ id: TAKE_A, projectId: PROJECT, shotId: SHOT_A, attemptId: '5a1f5c1e-0000-4000-8000-000000000009', assetId: VIDEO, createdAt: '2026-01-01T00:00:00Z' }];
  state.assets = [...state.assets, { id: VIDEO, projectId: PROJECT, filename: 'take-a.mp4', kind: 'video', origin: 'generated', sha256: '3'.repeat(64), mediaUrl: `/api/media/${VIDEO}`, width: 640, height: 360, durationSeconds: 5 }];
  state.shots = [{ ...state.shots[0]!, selectedTakeId: TAKE_A, selectionRevision: 1 }, state.shots[1]!, state.shots[2]!];
  state.exports = [{ id: '5a1f5c1e-0000-4000-8000-00000000000a', projectId: PROJECT, shotId: SHOT_A, takeId: TAKE_A, shotRevision: 2, selectionRevision: 1, status: 'ready', assetId: VIDEO, stale: false }];
  await mount(state);
  await openExport();
  const text = document.body.textContent ?? '';
  assert.ok(text.includes('An export is a frozen copy of one shot’s selected take.'));
  assert.ok(text.includes('Whole-film export isn’t available in this build.'));
  assert.match(text, /2 of 3 shots have no selected take/);
  const link = screen.getByRole('link', { name: 'Download' });
  assert.equal(link.getAttribute('href'), `/api/media/${VIDEO}`);
  assert.equal(link.getAttribute('download'), 'take-a.mp4');
  assert.match(text, /Frozen copy ready/);
  assert.match(text, /No selected take/);
  // The planning section is additive: the shot list still downloads beside it.
  await download('Markdown');
  assert.equal(created.length, 1);
});

test('the Export drawer disables downloads while held and explains an empty shot list', () => {
  const state = workspace();
  render(<ExportDrawer workspace={state} shots={state.shots} held onOpenTakes={() => {}} unsavedEdits={false} />);
  const markdown = screen.getByRole('button', { name: 'Download shot list (Markdown)' });
  const json = screen.getByRole('button', { name: 'Download shot list (JSON)' });
  assert.equal(markdown.getAttribute('aria-disabled'), 'true');
  assert.equal(json.getAttribute('aria-disabled'), 'true');
  fireEvent.click(markdown);
  fireEvent.click(json);
  assert.equal(created.length, 0, 'a held workspace starts no download');
  assert.doesNotMatch(document.body.textContent ?? '', /Started the download/);
  assert.match(document.body.textContent ?? '', /Finish the current action/);

  cleanup();
  const empty: Workspace = { project: { id: PROJECT, name: 'Ridge line', brief: '', revision: 1 }, shots: [], assets: [], takes: [], attempts: [], reviews: [], exports: [], capabilities: [] };
  render(<ExportDrawer workspace={empty} shots={[]} held={false} onOpenTakes={() => {}} unsavedEdits={false} />);
  assert.match(document.body.textContent ?? '', /No saved shots yet/i);
  assert.equal(screen.queryByRole('button', { name: /Download shot list/ }), null);
});

test('an app with no saved shots offers the empty-state explanation instead of a file', async () => {
  const empty: Workspace = { project: { id: PROJECT, name: 'Ridge line', brief: 'No shots yet.', revision: 1 }, shots: [], assets: [], takes: [], attempts: [], reviews: [], exports: [], capabilities: [] };
  await mount(empty);
  await openExport();
  assert.match(shotListRegion().textContent ?? '', /No saved shots yet/i);
  assert.equal(screen.queryByRole('button', { name: /Download shot list/ }), null);
  assert.equal(created.length, 0);
});

test('a browser without object URLs reports the failure without claiming a save', async () => {
  removeDownloads();
  try {
    await mount();
    await openExport();
    fireEvent.click(screen.getByRole('button', { name: 'Download shot list (Markdown)' }));
    await flush();
    const message = within(shotListRegion()).getByRole('status').textContent ?? '';
    assert.match(message, /not saved/i);
    assert.doesNotMatch(message, /^Started the download/);
    assert.equal(clicked.length, 0);
  } finally {
    installDownloads();
  }
});

test('a saved CR-only direction is normalised and escaped in the file the drawer downloads', async () => {
  const state = workspace();
  const saved = 'intro\r- injected bullet\r1. injected ordered\r    injected code';
  state.shots = [{ ...state.shots[0]!, prompt: saved }, state.shots[1]!, state.shots[2]!];
  render(<ExportDrawer workspace={state} shots={state.shots} held={false} onOpenTakes={() => {}} unsavedEdits={false} />);

  fireEvent.click(screen.getByRole('button', { name: 'Download shot list (Markdown)' }));
  await flush();
  const markdown = await bodyOf(0);
  assert.equal(markdown.includes('\r'), false, 'the downloaded Markdown carries no raw CR');
  assert.ok(markdown.includes('\n\\- injected bullet\n'), 'the bare-CR bullet is escaped at its line start');
  assert.ok(markdown.includes('\n1\\. injected ordered\n'), 'the bare-CR ordered item is escaped at its line start');
  assert.ok(markdown.includes('&#32;&#32;&#32;&#32;injected code'), 'bare-CR indentation cannot open a code block');
  assert.equal(markdown.includes('\n- injected bullet\n'), false);
  assert.equal(clicked[0]!.download, 'ridge-line-shot-list.md');

  fireEvent.click(screen.getByRole('button', { name: 'Download shot list (JSON)' }));
  await flush();
  const json = JSON.parse(await bodyOf(1)) as { shots: Array<{ id: string; direction: string }> };
  assert.equal(json.shots[0]!.direction, saved, 'the JSON file keeps the saved string byte for byte');
});

test('a shot row from another project is filtered out of the document, not just foreign assets', async () => {
  const state = workspace();
  const foreign: Shot = { ...state.shots[0]!, id: FOREIGN_SHOT, projectId: OTHER_PROJECT, title: 'Elsewhere shot', prompt: 'A direction saved in another project.' };
  render(<ExportDrawer workspace={state} shots={[state.shots[0]!, foreign, ...state.shots.slice(1)]} held={false} onOpenTakes={() => {}} unsavedEdits={false} />);

  fireEvent.click(screen.getByRole('button', { name: 'Download shot list (JSON)' }));
  await flush();
  const json = JSON.parse(await bodyOf(0)) as { shots: Array<{ id: string; order: number }> };
  assert.deepEqual(json.shots.map(item => item.id), [SHOT_A, SHOT_B, SHOT_C]);
  assert.deepEqual(json.shots.map(item => item.order), [1, 2, 3]);
  assert.equal(JSON.stringify(json).includes('Elsewhere shot'), false);
  assert.equal(JSON.stringify(json).includes('A direction saved in another project.'), false);

  fireEvent.click(screen.getByRole('button', { name: 'Download shot list (Markdown)' }));
  await flush();
  const markdown = await bodyOf(1);
  assert.equal(markdown.includes('Elsewhere shot'), false);
  assert.equal(markdown.includes('A direction saved in another project.'), false);
});

test('a malformed saved binding reports a bounded failure instead of an uncaught click-handler exception', async () => {
  // A saved binding whose id is unexpectedly absent must not become an invented reference.
  const absent = workspace();
  absent.shots = [{ ...absent.shots[0]!, bindings: { firstFrameAssetId: undefined as unknown as string, lastFrameAssetId: null } }, ...absent.shots.slice(1)];
  const view = render(<ExportDrawer workspace={absent} shots={absent.shots} held={false} onOpenTakes={() => {}} unsavedEdits={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Download shot list (Markdown)' }));
  await flush();
  const message = within(shotListRegion()).getByRole('status').textContent ?? '';
  assert.doesNotMatch(message, /Started the download/, 'nothing was started');
  assert.match(message, /could not be prepared/i);
  assert.match(message, /nothing was downloaded/i);
  assert.ok(message.length < 160, `the feedback stays bounded: ${message}`);
  assert.doesNotMatch(message, /TypeError|Error:|undefined|null/, 'no raw exception or internal value leaks into the copy');
  assert.equal(created.length, 0, 'no blob and no object URL is created, so none can leak');
  assert.equal(clicked.length, 0, 'no anchor is clicked');
  view.unmount();

  // Malformed runtime input can also omit the binding record entirely; that must be caught too.
  const missing = workspace();
  missing.shots = [{ ...missing.shots[0]!, bindings: undefined as unknown as Shot['bindings'] }, ...missing.shots.slice(1)];
  render(<ExportDrawer workspace={missing} shots={missing.shots} held={false} onOpenTakes={() => {}} unsavedEdits={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Download shot list (JSON)' }));
  await flush();
  const second = within(shotListRegion()).getByRole('status').textContent ?? '';
  assert.doesNotMatch(second, /Started the download/);
  assert.match(second, /could not be prepared/i);
  assert.equal(created.length, 0);
  assert.equal(clicked.length, 0);

  // The failure is bounded to the broken state: a valid project still downloads.
  cleanup();
  const good = workspace();
  render(<ExportDrawer workspace={good} shots={good.shots} held={false} onOpenTakes={() => {}} unsavedEdits={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Download shot list (Markdown)' }));
  await flush();
  assert.match(within(shotListRegion()).getByRole('status').textContent ?? '', /Started the download/);
  assert.equal(created.length, 1);
});

test('download feedback belongs to its project and is cleared by a project switch', async () => {
  const first = workspace();
  const second: Workspace = {
    project: { id: OTHER_PROJECT, name: 'Salt flat', brief: 'A second project, saved separately.', revision: 1 },
    shots: [{ id: OTHER_SHOT, projectId: OTHER_PROJECT, title: 'The salt flat', prompt: 'A white plain at noon.', revision: 1, selectionRevision: 0, selectedTakeId: null, controls, bindings: { firstFrameAssetId: null, lastFrameAssetId: null } }],
    assets: [{ id: OTHER_IMAGE, projectId: OTHER_PROJECT, filename: 'elsewhere.png', kind: 'image', origin: 'imported', sha256: '2'.repeat(64), mediaUrl: `/api/media/${OTHER_IMAGE}`, width: 1920, height: 1080 }],
    takes: [], attempts: [], reviews: [], exports: [], capabilities: [],
  };
  const view = render(<ExportDrawer workspace={first} shots={first.shots} held={false} onOpenTakes={() => {}} unsavedEdits={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Download shot list (Markdown)' }));
  await flush();
  assert.match(within(shotListRegion()).getByRole('status').textContent ?? '', /Started the download for ridge-line-shot-list\.md/);
  assert.equal(created.length, 1);

  // The controller's start(initialProjectId) refresh path can change the project without unmounting.
  view.rerender(<ExportDrawer workspace={second} shots={second.shots} held={false} onOpenTakes={() => {}} unsavedEdits={false} />);
  await flush();
  const status = within(shotListRegion()).getByRole('status').textContent ?? '';
  assert.doesNotMatch(status, /Started the download/, 'the previous project’s download line never sits over this project');
  assert.doesNotMatch(status, /ridge-line/, 'no file name from the previous project leaks across');
  assert.equal(created.length, 1, 'the switch starts no download');

  fireEvent.click(screen.getByRole('button', { name: 'Download shot list (JSON)' }));
  await flush();
  const json = JSON.parse(await bodyOf(1)) as { project: { id: string; name: string; brief: string }; shots: Array<{ id: string; title: string }> };
  assert.equal(json.project.id, OTHER_PROJECT, 'the next download uses this project’s saved data');
  assert.equal(json.project.name, 'Salt flat');
  assert.equal(json.project.brief, 'A second project, saved separately.');
  assert.deepEqual(json.shots.map(item => item.id), [OTHER_SHOT]);
  assert.equal(clicked.at(-1)!.download, 'salt-flat-shot-list.json');
});
