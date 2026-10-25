import '../../../packages/shot-editor/test/setup.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { FlumeApp } from '../src/App.tsx';
import { workspaceComponents } from '../src/composition.ts';
import { WorkspaceController } from '../src/controller.ts';
import type { Command, FlumePort, Receipt, Workspace } from '../src/types.ts';

Object.assign(globalThis, { React });
afterEach(cleanup);
HTMLElement.prototype.scrollIntoView = () => {};
(window.HTMLDialogElement.prototype as any).showModal = function () { this.setAttribute('open', ''); };
(window.HTMLDialogElement.prototype as any).close = function () { this.removeAttribute('open'); };

// The synthetic upload response the coordinator used to reproduce SEC-1: the
// editor accepted it, the imported file is a real owned record, but the media
// path it reports is not owned project media.
const hostileUploads = {
  owned: '/api/media/asset-upload',
  sameOriginArtwork: '/art/alpine-forest-wide.webp',
  external: 'https://provider.invalid/frame-99.png',
  credentials: 'http://user:pass@localhost/api/media/asset-upload',
  data: 'data:image/png;base64,AAAA',
  unparsable: 'http://[::1',
  missing: '',
};

const savedStartAsset = {
  id: 'asset-saved-start', projectId: 'p', filename: 'saved-start.png', kind: 'image' as const,
  origin: 'sample' as const, sha256: 'e'.repeat(64), mediaUrl: '/api/media/asset-saved-start', width: 1280, height: 720,
};
// A saved binding whose recorded media URL sits outside the owned /api/media/ policy.
const nonOwnedSavedAsset = {
  id: 'asset-saved-artwork', projectId: 'p', filename: 'alpine-forest-wide.webp', kind: 'image' as const,
  origin: 'imported' as const, sha256: 'd'.repeat(64), mediaUrl: hostileUploads.sameOriginArtwork, width: 1584, height: 672,
};

function baseWorkspace(overrides: { assets?: Workspace['assets']; firstFrameAssetId?: string | null } = {}): Workspace {
  return {
    project: { id: 'p', name: 'Owned fixture', brief: '', revision: 1 },
    shots: [{
      id: 's', projectId: 'p', title: 'One', prompt: 'A ridge at dawn', revision: 1, selectionRevision: 0, selectedTakeId: null,
      bindings: { firstFrameAssetId: overrides.firstFrameAssetId ?? null, lastFrameAssetId: null },
      controls: { modelId: 'model', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false },
    }],
    assets: overrides.assets ?? [], takes: [], exports: [], attempts: [], reviews: [],
    capabilities: [{ modelId: 'model', name: 'Model', durations: [5], resolutions: ['2K'], frameRoles: ['first', 'last'], seedSupported: false, availability: 'available', blocker: null }],
  } as unknown as Workspace;
}

async function fixture(overrides: { uploadMediaUrl?: string; assets?: Workspace['assets']; firstFrameAssetId?: string | null } = {}) {
  const workspace = baseWorkspace(overrides);
  const commands: Command[] = [];
  const uploaded = {
    id: 'asset-upload', projectId: 'p', filename: 'audit-ref-01-slate.png', kind: 'image' as const,
    origin: 'imported' as const, sha256: 'c'.repeat(64),
    mediaUrl: overrides.uploadMediaUrl ?? hostileUploads.owned, width: 1280, height: 720,
  };
  const port: FlumePort = {
    listProjects: async () => [workspace.project!],
    getWorkspace: async () => structuredClone(workspace),
    uploadAsset: async () => { workspace.assets = [uploaded]; return uploaded; },
    command: async command => {
      commands.push(command);
      if (command.type !== 'shot.update') throw new Error('unexpected command');
      const current = workspace.shots[0]!;
      const revision = current.revision + 1;
      const { seed, ...controls } = { ...current.controls, ...command.patch.controls };
      workspace.shots[0] = {
        ...current,
        title: command.patch.title ?? current.title,
        prompt: command.patch.prompt ?? current.prompt,
        controls: { ...controls, ...(seed == null ? {} : { seed }) },
        bindings: { ...current.bindings, ...command.patch.bindings },
        revision,
      };
      return { commandId: command.commandId, projectId: command.projectId, revision } as Receipt;
    },
  };
  const controller = new WorkspaceController(port);
  await controller.openProject('p');
  return { controller, commands, workspace, uploaded };
}

async function stageStartFrame() {
  const file = new File(['image bytes'], 'audit-ref-01-slate.png', { type: 'image/png' });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Upload start frame'), { target: { files: [file] } });
  });
}

function startFrame() {
  return screen.getByRole('figure', { name: 'Start frame' });
}

/** The draft preview must not hand a non-owned URL to an <img src>, CSP or not. */
function assertNoImageSource(figure: HTMLElement, mediaUrl: string) {
  const images = [...figure.querySelectorAll('img')];
  assert.equal(images.length, 0, `no <img> may be rendered for ${mediaUrl || '(empty URL)'}`);
  const carriers = [...figure.querySelectorAll('[src]')].map(element => element.getAttribute('src'));
  assert.equal(carriers.includes(mediaUrl), false, 'no element in the draft preview carries the rejected URL');
}

// --- The same owned-media policy for staged draft frames (SEC-1) ---

test('an owned /api/media/ draft URL still previews, exactly like a saved frame', async () => {
  const { controller, commands } = await fixture({ uploadMediaUrl: hostileUploads.owned });
  render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
  await stageStartFrame();

  const figure = startFrame();
  const image = figure.querySelector('img');
  assert.ok(image, 'an owned staged URL previews');
  assert.equal(image!.getAttribute('src'), hostileUploads.owned);
  assert.equal(figure.querySelector('.fl-gate')!.getAttribute('data-draft'), 'previewed');
  assert.equal(commands.length, 0, 'reporting the draft writes nothing');
});

test('a same-origin non-owned draft URL is never rendered as the draft frame', async () => {
  // The coordinator's exact reproduction: the upload response pointed at the
  // same-origin artwork served outside /api/media/.
  const { controller, commands, workspace, uploaded } = await fixture({ uploadMediaUrl: hostileUploads.sameOriginArtwork });
  render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
  await stageStartFrame();

  const figure = startFrame();
  assertNoImageSource(figure, hostileUploads.sameOriginArtwork);
  const msg = figure.querySelector('.fl-gate__msg')!.textContent ?? '';
  assert.equal(figure.querySelector('.fl-gate')!.getAttribute('data-draft'), 'preview-unavailable');
  assert.match(msg, /Preview unavailable/i);
  assert.match(msg, /audit-ref-01-slate\.png/, 'the draft filename survives a rejected URL');
  assert.doesNotMatch(msg, /Removed in your draft/i, 'a rejected URL is never a removal');
  assert.doesNotMatch(msg, /could not be loaded/i, 'a URL that was never requested is not described as a failed load');
  // Draft identity is preserved: same asset id, same unsaved state, nothing written.
  assert.equal((screen.getByLabelText('Start frame image') as HTMLSelectElement).value, uploaded.id);
  assert.ok(screen.getByText('Unsaved draft'));
  assert.match(document.querySelector('.fl-workspace__stagebar-mid')!.textContent ?? '', /showing your unsaved draft/);
  assert.equal(commands.length, 0, 'showing a rejected draft URL writes nothing');
  assert.equal(workspace.shots[0]!.bindings.firstFrameAssetId, null, 'the saved shot is untouched');
  assert.equal((screen.getByRole('button', { name: 'Review generation' }) as HTMLButtonElement).disabled, true, 'dirty draft still gates review');
});

test('an external draft URL is never rendered as the draft frame', async () => {
  const { controller, commands } = await fixture({ uploadMediaUrl: hostileUploads.external });
  render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
  await stageStartFrame();

  const figure = startFrame();
  assertNoImageSource(figure, hostileUploads.external);
  const msg = figure.querySelector('.fl-gate__msg')!.textContent ?? '';
  assert.equal(figure.querySelector('.fl-gate')!.getAttribute('data-draft'), 'preview-unavailable');
  assert.match(msg, /Preview unavailable/i);
  assert.match(msg, /audit-ref-01-slate\.png/);
  assert.ok(screen.getByText('Unsaved draft'));
  assert.equal(commands.length, 0);
});

test('a credentials-bearing same-origin draft URL is never rendered', async () => {
  const { controller } = await fixture({ uploadMediaUrl: hostileUploads.credentials });
  render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
  await stageStartFrame();

  const figure = startFrame();
  assertNoImageSource(figure, hostileUploads.credentials);
  assert.equal(figure.querySelector('.fl-gate')!.getAttribute('data-draft'), 'preview-unavailable');
  assert.equal((figure.textContent ?? '').includes('user:pass'), false, 'the rejected URL credentials are never echoed');
  assert.match(figure.querySelector('.fl-gate__msg')!.textContent ?? '', /Preview unavailable/i);
});

test('a data: draft URL is never rendered', async () => {
  const { controller } = await fixture({ uploadMediaUrl: hostileUploads.data });
  render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
  await stageStartFrame();

  const figure = startFrame();
  assertNoImageSource(figure, hostileUploads.data);
  assert.equal(figure.querySelector('.fl-gate')!.getAttribute('data-draft'), 'preview-unavailable');
});

test('an unparsable draft URL is never rendered', async () => {
  const { controller } = await fixture({ uploadMediaUrl: hostileUploads.unparsable });
  render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
  await stageStartFrame();

  const figure = startFrame();
  assertNoImageSource(figure, hostileUploads.unparsable);
  assert.equal(figure.querySelector('.fl-gate')!.getAttribute('data-draft'), 'preview-unavailable');
  assert.match(figure.querySelector('.fl-gate__msg')!.textContent ?? '', /Preview unavailable/i);
});

test('a draft frame with no media URL is preview-unavailable, never removed', async () => {
  const { controller, commands } = await fixture({ uploadMediaUrl: hostileUploads.missing });
  render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
  await stageStartFrame();

  const figure = startFrame();
  assertNoImageSource(figure, hostileUploads.missing);
  const msg = figure.querySelector('.fl-gate__msg')!.textContent ?? '';
  assert.equal(figure.querySelector('.fl-gate')!.getAttribute('data-draft'), 'preview-unavailable');
  assert.match(msg, /Preview unavailable/i);
  assert.doesNotMatch(msg, /Removed in your draft/i);
  assert.ok(screen.getByText('Unsaved draft'));
  assert.equal(commands.length, 0);

  // An explicit save still persists the same draft reference: nothing is lost.
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save shot changes' })); });
  assert.equal(commands.length, 1);
  const update = commands[0] as Extract<Command, { type: 'shot.update' }>;
  assert.deepEqual(update.patch.bindings, { firstFrameAssetId: 'asset-upload', lastFrameAssetId: null });
});

test('an owned draft URL that fails to load is a failed load, still not a removal', async () => {
  const { controller, commands } = await fixture({ uploadMediaUrl: hostileUploads.owned });
  render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
  await stageStartFrame();

  const image = startFrame().querySelector('img');
  assert.ok(image, 'the owned staged URL renders first');
  await act(async () => { fireEvent.error(image!); });

  const figure = startFrame();
  const msg = figure.querySelector('.fl-gate__msg')!.textContent ?? '';
  assert.equal(figure.querySelector('.fl-gate')!.getAttribute('data-draft'), 'preview-unavailable');
  assert.match(msg, /Preview unavailable/i);
  assert.match(msg, /could not be loaded/i, 'an owned URL that really failed keeps the load wording');
  assert.match(msg, /audit-ref-01-slate\.png/);
  assert.doesNotMatch(msg, /Removed in your draft/i);
  assert.equal(Boolean(screen.queryByText('Unsaved draft')), true, 'the draft survives a failed load');
  assert.equal(commands.length, 0);
});

test('a true draft removal is still a removal, not a rejected URL', async () => {
  const { controller, commands, workspace } = await fixture({ assets: [savedStartAsset], firstFrameAssetId: savedStartAsset.id });
  render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
  assert.ok(startFrame().querySelector('img[src="/api/media/asset-saved-start"]'), 'the saved frame previews first');

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear start frame' })); });

  const figure = startFrame();
  const msg = figure.querySelector('.fl-gate__msg')!.textContent ?? '';
  assert.equal(figure.querySelector('.fl-gate')!.getAttribute('data-draft'), 'cleared');
  assert.match(msg, /Removed in your draft/i);
  assert.doesNotMatch(msg, /Preview unavailable/i, 'an intentional clear is not a preview failure');
  assert.equal(commands.length, 0);
  assert.equal(workspace.shots[0]!.bindings.firstFrameAssetId, savedStartAsset.id);
});

test('a saved frame outside /api/media/ is not rendered either, so both paths share one policy', async () => {
  const { controller } = await fixture({ assets: [nonOwnedSavedAsset], firstFrameAssetId: nonOwnedSavedAsset.id });
  render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);

  const figure = startFrame();
  assertNoImageSource(figure, hostileUploads.sameOriginArtwork);
  assert.equal(figure.querySelector('.fl-gate')!.getAttribute('data-draft'), null, 'nothing is staged here');
  assert.match(figure.querySelector('.fl-gate__msg')!.textContent ?? '', /This preview could not load/i);
  assert.equal(Boolean(screen.queryByText('Unsaved draft')), false);
});

// --- The preview action is a whole-shot save (reviewer S1) ---

test('the preview action is labelled as a whole-shot save and still saves the whole shot', async () => {
  const { controller, commands } = await fixture({ uploadMediaUrl: hostileUploads.owned });
  render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
  await stageStartFrame();

  const figure = startFrame();
  const action = screen.getByRole('button', { name: 'Save shot changes' }) as HTMLButtonElement;
  assert.equal(/Save to keep this frame/.test(figure.textContent ?? ''), false, 'no frame-only save wording is offered');
  assert.match(figure.textContent ?? '', /Draft only — not saved yet\./);
  // The action is described by the draft note, so the scope is announced, not implied.
  const note = document.getElementById(action.getAttribute('aria-describedby') ?? '');
  assert.ok(note, 'the action points at its draft note');
  assert.match(note!.textContent ?? '', /Draft only — not saved yet\./);

  // The whole shot is what this button saves: a title-only edit and the staged
  // frame leave in one patch, exactly as the editor's own save button does.
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Shot', { exact: true }), { target: { value: 'One, retitled' } });
  });
  await act(async () => { fireEvent.click(action); });

  assert.equal(commands.length, 1);
  const update = commands[0] as Extract<Command, { type: 'shot.update' }>;
  assert.equal(update.patch.title, 'One, retitled', 'the save carries the whole draft, not only the frame');
  assert.equal(update.patch.prompt, 'A ridge at dawn');
  assert.deepEqual(update.patch.bindings, { firstFrameAssetId: 'asset-upload', lastFrameAssetId: null });
  assert.deepEqual(Object.keys(update.patch).sort(), ['bindings', 'controls', 'prompt', 'title']);
  assert.equal(update.expectedRevision, 1);
  assert.equal(Boolean(screen.queryByText('Unsaved draft')), false, 'the save retires the draft state');
});

test('a draft removal keeps its removal note under the whole-shot save label', async () => {
  const { controller, commands } = await fixture({ assets: [savedStartAsset], firstFrameAssetId: savedStartAsset.id });
  render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear start frame' })); });

  const figure = startFrame();
  const action = screen.getByRole('button', { name: 'Save shot changes' }) as HTMLButtonElement;
  assert.match(figure.textContent ?? '', /Draft removal — not saved yet\./, 'the removal is stated in words');
  assert.equal(/Save removal/.test(figure.textContent ?? ''), false, 'the action is not described as a frame-only write');
  const note = document.getElementById(action.getAttribute('aria-describedby') ?? '');
  assert.ok(note);
  assert.match(note!.textContent ?? '', /Draft removal — not saved yet\./);
  assert.match(figure.querySelector('.fl-gate__msg')!.textContent ?? '', /Removed in your draft/i);

  await act(async () => { fireEvent.click(action); });
  assert.equal(commands.length, 1);
  const update = commands[0] as Extract<Command, { type: 'shot.update' }>;
  assert.deepEqual(update.patch.bindings, { firstFrameAssetId: null, lastFrameAssetId: null });
});
