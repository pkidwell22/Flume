import '../../../packages/shot-editor/test/setup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { FlumeApp } from '../src/App.tsx';
import { workspaceComponents } from '../src/composition.ts';
import { WorkspaceController } from '../src/controller.ts';
import type { FlumePort, Workspace } from '../src/types.ts';

Object.assign(globalThis, { React });
afterEach(cleanup);
(window.HTMLDialogElement.prototype as any).showModal = function () { this.setAttribute('open', ''); };
(window.HTMLDialogElement.prototype as any).close = function () { this.removeAttribute('open'); };

// jsdom performs no layout, so the witness records the call the browser would
// use to bring the editor's own actions into view.
let scrolled: HTMLElement | null = null;
HTMLElement.prototype.scrollIntoView = function () { scrolled = this as HTMLElement; };

function baseWorkspace(blocked: boolean): Workspace {
  return {
    project: { id: 'p', name: 'Owned fixture', brief: '', revision: 1 },
    shots: [{
      id: 's', projectId: 'p', title: 'One', prompt: 'A ridge at dawn', revision: 1, selectionRevision: 0, selectedTakeId: null,
      bindings: { firstFrameAssetId: null, lastFrameAssetId: null },
      controls: { modelId: 'model', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false },
    }],
    assets: [], takes: [], exports: [], attempts: [], reviews: [],
    capabilities: [{ modelId: 'model', name: 'Model', durations: [5], resolutions: ['2K'], frameRoles: ['first', 'last'], seedSupported: false, availability: blocked ? 'blocked' : 'available', blocker: blocked ? 'Account privacy policy excludes this route.' : null }],
  } as unknown as Workspace;
}

async function open(blocked = false) {
  const workspace = baseWorkspace(blocked);
  const port: FlumePort = {
    listProjects: async () => [workspace.project!],
    getWorkspace: async () => structuredClone(workspace),
    uploadAsset: async () => { throw new Error('unused'); },
    command: async () => { throw new Error('unused'); },
  };
  const controller = new WorkspaceController(port);
  await controller.openProject('p');
  render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false} />);
  return { controller, workspace };
}

function ruleFrom(source: string, selector: string) {
  const start = source.indexOf(`${selector} {`);
  assert.ok(start >= 0, `Missing rule ${selector}`);
  return source.slice(start, source.indexOf('}', start) + 1);
}

test('a narrow layout offers a labelled, in-viewport way to reach Save and Review', async () => {
  scrolled = null;
  await open();
  const cue = screen.getByRole('button', { name: 'Jump to save and review' });
  // The cue lives in the stage toolbar, which is a non-scrolling header above
  // the stage body; the slate (and its sticky footer) can sit a viewport below it.
  assert.ok(cue.closest('.fl-workspace__stagebar'), 'the cue belongs to the always-visible stage toolbar');
  const stageScroll = document.querySelector('.fl-workspace__stagescroll');
  assert.ok(stageScroll);
  assert.ok(cue.compareDocumentPosition(stageScroll) & 4, 'the cue precedes the scrolling stage body in document order');

  await act(async () => { fireEvent.click(cue); });

  const footer = document.querySelector('.fl-shot-editor__footer');
  assert.ok(footer, 'the editor still owns the action row');
  assert.equal(scrolled, footer, 'activating the cue scrolls the editor action row into view');
  assert.ok(footer!.contains(document.activeElement), 'focus lands on the editor actions');
  assert.equal(document.activeElement?.tagName, 'BUTTON');
  assert.match(document.activeElement?.textContent ?? '', /Save changes|Review generation/);
  assert.equal(screen.queryByRole('dialog'), null, 'the cue never opens a review by itself');
});

test('the narrow-layout cue is displayed by the container rule and is never a fixed overlay', () => {
  const css = readFileSync(new URL('../src/workspace.css', import.meta.url), 'utf8');
  const base = ruleFrom(css, '.fl-workspace__jump');
  assert.match(base, /display:\s*none/, 'wide layouts keep the redundant cue out of the toolbar');
  const narrow = css.slice(css.indexOf('@container fl (max-width: 880px)'));
  const narrowRule = ruleFrom(narrow, '.fl-workspace__jump');
  assert.match(narrowRule, /display:\s*inline-flex/, 'the stacked layout shows the cue');
  assert.doesNotMatch(`${base}${narrowRule}`, /position:\s*fixed/, 'no overlay may cover the inputs');
  assert.match(ruleFrom(css, '.fl-workspace__stagebar'), /flex:\s*none/, 'the toolbar holding the cue is not part of the scrolling area');
});

test('the blocked-generation notice links to the real setup documentation without enabling anything', async () => {
  await open(true);
  const notice = document.querySelector('.fl-workspace__provider-blocker');
  assert.ok(notice, 'the slate still reports the block');
  const link = screen.getByRole('link', { name: 'Read the setup guide for provider access' });
  assert.equal(link.getAttribute('href'), 'https://github.com/pkidwell22/Flume/blob/main/docs/DOCKER.md');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.match(link.getAttribute('rel') ?? '', /noopener/);
  assert.match(notice!.textContent ?? '', /Editing and saving still work/);
  assert.doesNotMatch(notice!.textContent ?? '', /Settings/, 'no settings surface is invented');
  assert.match(notice!.textContent ?? '', /opens in a new tab/);
});
