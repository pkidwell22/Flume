import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// The UI package is compiled by Vite in the app; tsx's cross-package static
// rendering uses its classic JSX fallback for that package's unconfigured TSX.
Object.assign(globalThis, { React });
import { JSDOM } from 'jsdom';
import { FlumeApp } from '../src/App.tsx';
import { WorkspaceController } from '../src/controller.ts';
import { workspaceComponents } from '../src/composition.ts';
import type { Workspace } from '../src/types.ts';

const workspace: Workspace = {
  project: { id: 'p', name: 'A film', brief: '', revision: 1 },
  shots: [{ id: 's', projectId: 'p', title: 'Opening shot', prompt: 'Keep the literal direction.', revision: 1, selectionRevision: 0, selectedTakeId: null, controls: { modelId: 'blocked', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false }, bindings: { firstFrameAssetId: null, lastFrameAssetId: null } }],
  assets: [], takes: [], attempts: [], reviews: [], exports: [],
  capabilities: [{ modelId: 'blocked', name: 'Configured model', durations: [5], resolutions: ['2K'], frameRoles: ['first_frame', 'last_frame'], seedSupported: false, availability: 'blocked', blocker: 'This configured route is unavailable.' }],
};

test('actual components place the shot composer directly after preview and before take/export results', async () => {
  const controller = new WorkspaceController({ listProjects: async () => [workspace.project!], getWorkspace: async () => workspace, command: async () => { throw new Error('Render must not command'); }, uploadAsset: async () => { throw new Error('Render must not upload'); } });
  await controller.openProject('p');
  const dom = new JSDOM(renderToStaticMarkup(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />));
  const document = dom.window.document;
  const composer = document.querySelector('[aria-label="Shot composer"]');
  assert.ok(composer, 'A single named composer must replace the side inspector');
  const stage = document.querySelector('[aria-label="Shot preview"]')!;
  const takes = document.querySelector('.fl-workspace__takes')!;
  assert.ok(stage.compareDocumentPosition(composer) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(composer.compareDocumentPosition(takes) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'Results must not interrupt preview → prompt → action');
  for (const label of ['Prompt', 'Model', 'Duration (seconds)', 'Resolution', 'Aspect ratio', 'Seed (optional)']) {
    assert.ok([...composer.querySelectorAll('label')].some(node => node.textContent?.trim().startsWith(label)), label);
  }
  assert.ok([...composer.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Review generation'));
  assert.ok(![...composer.querySelectorAll('button')].some(button => /Approve|Generate once/.test(button.textContent ?? '')), 'Composer must not absorb approval or submission');
  assert.equal(document.querySelectorAll('[aria-label="Shots"]').length, 1);
  assert.match(document.body.textContent!, /This configured route is unavailable/);
  dom.window.close();
});
