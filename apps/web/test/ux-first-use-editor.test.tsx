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

const uploadedAsset = {
  id: 'asset-upload', projectId: 'p', filename: 'audit-ref-01-slate.png', kind: 'image' as const,
  origin: 'imported' as const, sha256: 'c'.repeat(64), mediaUrl: '/api/media/asset-upload', width: 1280, height: 720,
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

async function fixture(overrides: { assets?: Workspace['assets']; firstFrameAssetId?: string | null } = {}) {
  const workspace = baseWorkspace(overrides);
  const commands: Command[] = [];
  const port: FlumePort = {
    listProjects: async () => [workspace.project!],
    getWorkspace: async () => structuredClone(workspace),
    uploadAsset: async () => { workspace.assets = [uploadedAsset]; return uploadedAsset; },
    command: async command => {
      commands.push(command);
      if (command.type !== 'shot.update') throw new Error('unexpected command');
      const current = workspace.shots[0]!;
      const revision = current.revision + 1;
      // Apply the accepted patch exactly as the server echo would; the receipt
      // only carries the revision.
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
  return { controller, commands, workspace };
}

async function stageStartFrame() {
  const file = new File(['image bytes'], 'audit-ref-01-slate.png', { type: 'image/png' });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Upload start frame'), { target: { files: [file] } });
  });
}

test('a staged frame is previewed with an explicit unsaved cue instead of an empty saved slot', async () => {
  const { controller } = await fixture();
  render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
  assert.ok(screen.getByText('Your shot starts here.'), 'the saved shot still has no start frame');

  await stageStartFrame();

  // Compare presence as a boolean: a failing node:assert.equal on a jsdom node
  // tries to inspect the element and can exhaust memory instead of reporting.
  assert.equal(Boolean(screen.queryByText('Your shot starts here.')), false, 'the preview no longer claims the slot is empty');
  const startFrame = screen.getByRole('figure', { name: 'Start frame' });
  assert.equal(startFrame.textContent!.includes('No frame bound'), false, 'an imported filename never shares a slot with "No frame bound"');
  assert.ok(screen.getAllByText('audit-ref-01-slate.png').length >= 2, 'both the slate and the preview name the draft file');
  assert.equal(Boolean(screen.queryByText('Unsaved draft')), true, 'the preview says the frame is not saved yet');
  const cue = screen.getByText('Unsaved draft');
  assert.ok(cue, 'the preview says the frame is not saved yet');
  assert.match(cue.closest('figure')!.textContent!, /not saved/i);
  assert.ok(screen.getByRole('button', { name: 'Save shot changes' }));
  // The stage itself must not keep claiming it shows only the saved shot.
  const stage = document.querySelector('.fl-workspace__stagebar-mid')!.textContent ?? '';
  assert.match(stage, /showing your unsaved draft/);
  assert.doesNotMatch(stage, /showing the saved shot/);
});

test('the preview save action uses the editor save path and keeps review gated while unsaved', async () => {
  const { controller, commands } = await fixture();
  render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
  await stageStartFrame();

  assert.equal((screen.getByRole('button', { name: 'Review generation' }) as HTMLButtonElement).disabled, true, 'draft state never reaches review');
  assert.equal((screen.getByRole('button', { name: 'Save shot changes' }) as HTMLButtonElement).disabled, false);

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save shot changes' })); });

  assert.equal(commands.length, 1);
  const update = commands[0] as Extract<Command, { type: 'shot.update' }>;
  assert.deepEqual(update.patch.bindings, { firstFrameAssetId: 'asset-upload', lastFrameAssetId: null });
  assert.equal(update.expectedRevision, 1);
  assert.equal(Boolean(screen.queryByText('Unsaved draft')), false, 'the saved shot owns the frame after persistence');
  assert.ok(screen.getAllByText('audit-ref-01-slate.png').length >= 2);
  assert.equal(Boolean(screen.queryByText(/Save changes to keep/)), false, 'a successful save retires the import instruction');
  assert.equal(/Save shot changes/.test(document.body.textContent ?? ''), false, 'a successful save retires the preview action');
});

test('a staged reference never claims to be saved when persistence fails', async () => {
  const { controller, workspace } = await fixture();
  const failing: FlumePort['command'] = async command => { throw Object.assign(new Error('offline'), { status: 503 }); };
  render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
  await stageStartFrame();
  (controller as any).api.command = failing;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save shot changes' })); });
  assert.equal(Boolean(screen.queryByText('Unsaved draft')), true, 'a failed save leaves the frame explicitly unsaved');
  assert.match(document.body.textContent ?? '', /Save not confirmed/);
  assert.match(document.body.textContent ?? '', /Save changes to keep this start frame/, 'the instruction survives a failure');
  assert.equal(workspace.shots[0]!.bindings.firstFrameAssetId, null);
});

// --- Draft preview failure vs. an intentional clear (coordinator finding 4) ---

const savedStartAsset = {
  id: 'asset-saved-start', projectId: 'p', filename: 'saved-start.png', kind: 'image' as const,
  origin: 'sample' as const, sha256: 'e'.repeat(64), mediaUrl: '/api/media/asset-saved-start', width: 1280, height: 720,
};
const assetWithoutMediaUrl = {
  id: 'asset-no-media', projectId: 'p', filename: 'synthetic-missing-media.png', kind: 'image' as const,
  origin: 'sample' as const, sha256: 'f'.repeat(64), mediaUrl: '', width: 1024, height: 576,
};

function startFrameFigure() {
  return screen.getByRole('figure', { name: 'Start frame' });
}

test('a draft frame whose media fails to load says preview unavailable, never removed', async () => {
  const { controller, commands, workspace } = await fixture();
  render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
  await stageStartFrame();

  const image = startFrameFigure().querySelector('img');
  assert.ok(image, 'the staged draft frame renders its media');
  // The coordinator reproduced this by making the owned media GET return 404.
  await act(async () => { fireEvent.error(image!); });

  const figure = startFrameFigure();
  const msg = figure.querySelector('.fl-gate__msg')!.textContent ?? '';
  assert.doesNotMatch(msg, /Removed in your draft/i, 'a failed preview is not a cleared binding');
  assert.doesNotMatch(msg, /remove this frame/i, 'a failed preview never offers removal');
  assert.match(msg, /Preview unavailable/i, 'the frame says its preview is unavailable');
  assert.match(msg, /audit-ref-01-slate\.png/, 'the draft filename is kept');
  assert.equal(figure.querySelector('.fl-gate')!.getAttribute('data-draft'), 'preview-unavailable');
  assert.equal(figure.querySelector('.fl-gate')!.getAttribute('data-kind'), 'draft', 'the frame is still the unsaved draft');
  assert.ok(screen.getByText('Unsaved draft'), 'the draft label survives a failed preview');
  const keep = screen.getByRole('button', { name: 'Save shot changes' }) as HTMLButtonElement;
  assert.equal(keep.disabled, false, 'the draft can still be saved as kept');
  assert.equal(commands.length, 0, 'a failed preview writes nothing by itself');
  assert.equal(workspace.shots[0]!.bindings.firstFrameAssetId, null, 'the saved shot is untouched');
  assert.match(document.querySelector('.fl-workspace__stagebar-mid')!.textContent ?? '', /showing your unsaved draft/);
  assert.equal((screen.getByRole('button', { name: 'Review generation' }) as HTMLButtonElement).disabled, true, 'dirty state still gates review');
});

test('a draft frame reported without a media URL says preview unavailable, never removed', async () => {
  const { controller, commands } = await fixture({ assets: [assetWithoutMediaUrl] });
  render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Start frame image'), { target: { value: assetWithoutMediaUrl.id } });
  });

  const figure = startFrameFigure();
  const msg = figure.querySelector('.fl-gate__msg')!.textContent ?? '';
  assert.equal(figure.querySelector('.fl-gate')!.getAttribute('data-draft'), 'preview-unavailable');
  assert.doesNotMatch(msg, /Removed in your draft/i, 'a missing media URL is not a cleared binding');
  assert.match(msg, /Preview unavailable/i);
  assert.match(msg, /synthetic-missing-media\.png/, 'the selected draft filename is kept');
  assert.ok(screen.getByText('Unsaved draft'));
  assert.ok(screen.getByRole('button', { name: 'Save shot changes' }));
  assert.equal(commands.length, 0);
});

test('an intentional draft clear still reads as a removal under the whole-shot save action', async () => {
  const { controller, commands, workspace } = await fixture({ assets: [savedStartAsset], firstFrameAssetId: savedStartAsset.id });
  render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
  assert.ok(startFrameFigure().querySelector('img[src="/api/media/asset-saved-start"]'), 'the saved frame previews first');

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear start frame' })); });

  const figure = startFrameFigure();
  const msg = figure.querySelector('.fl-gate__msg')!.textContent ?? '';
  assert.equal(figure.querySelector('.fl-gate')!.getAttribute('data-draft'), 'cleared');
  assert.match(msg, /Removed in your draft/i, 'a null draft binding is the one case that reads as removal');
  assert.doesNotMatch(msg, /Preview unavailable/i, 'a real clear is not called a preview failure');
  const removal = screen.getByRole('button', { name: 'Save shot changes' }) as HTMLButtonElement;
  assert.match(figure.textContent ?? '', /Draft removal — not saved yet\./, 'the removal is stated in words');
  assert.equal(/Save to keep this frame/.test(figure.textContent ?? ''), false, 'removal never offers the keep wording');
  assert.equal(/Save removal/.test(figure.textContent ?? ''), false, 'no frame-only save wording is offered');
  assert.equal(commands.length, 0, 'clearing the draft alone writes nothing');
  assert.equal(workspace.shots[0]!.bindings.firstFrameAssetId, savedStartAsset.id, 'the saved shot still owns the frame');

  await act(async () => { fireEvent.click(removal); });
  assert.equal(commands.length, 1, 'an explicit Save removal still uses the editor save path');
  const update = commands[0] as Extract<Command, { type: 'shot.update' }>;
  assert.deepEqual(update.patch.bindings, { firstFrameAssetId: null, lastFrameAssetId: null });
});

test('a saved frame whose preview fails keeps the existing saved-shot wording', async () => {
  const { controller } = await fixture({ assets: [savedStartAsset], firstFrameAssetId: savedStartAsset.id });
  render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);

  const image = startFrameFigure().querySelector('img');
  assert.ok(image);
  await act(async () => { fireEvent.error(image!); });

  const figure = startFrameFigure();
  const msg = figure.querySelector('.fl-gate__msg')!.textContent ?? '';
  assert.equal(figure.querySelector('.fl-gate')!.getAttribute('data-draft'), null, 'nothing is staged here');
  assert.match(msg, /This preview could not load/i, 'the saved-shot failure copy is unchanged');
  assert.doesNotMatch(msg, /Removed in your draft/i);
  assert.equal(Boolean(screen.queryByText('Unsaved draft')), false);
});
