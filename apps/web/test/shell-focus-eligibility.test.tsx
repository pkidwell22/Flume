import '../../../packages/activity-review/test/setup.tsx';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FlumeApp } from '../src/App.tsx';
import { WorkspaceController } from '../src/controller.ts';
import type { WorkspaceComponents } from '../src/ports.ts';
import type { Command, Workspace } from '../src/types.ts';

Object.assign(globalThis, { React });
HTMLElement.prototype.scrollIntoView = () => {};
afterEach(() => { cleanup(); document.querySelectorAll('[data-focus-fixture]').forEach(node => node.remove()); });

// Isolate the shell restoration guard. Native dialog/visibility behavior and
// real editor/GenerationReview integration are exercised by the native witness.
const parts: WorkspaceComponents = {
  Brand: () => <span>Fixture</span>, TakeReview: () => null, ActivityPanel: () => null,
  ShotEditor: ({ shot, onPrepare }) => <button onClick={() => { void onPrepare(shot.revision); }}>Prepare fixture</button>,
  GenerationReview: ({ onDismiss }) => <button onClick={onDismiss}>Dismiss fixture</button>,
};
async function fixture() {
  const shot = { id: 's', projectId: 'p', title: 'One', prompt: 'Saved literal', revision: 3, selectionRevision: 0, selectedTakeId: null, controls: { modelId: 'fixture', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false }, bindings: { firstFrameAssetId: null, lastFrameAssetId: null } };
  const workspace: Workspace = { project: { id: 'p', name: 'Fixture', brief: '', revision: 1 }, shots: [shot, { ...shot, id: 's2', title: 'Two' }], assets: [], takes: [], attempts: [], exports: [], capabilities: [], reviews: [{ id: 'r', projectId: 'p', shotId: 's', shotRevision: 3, requestHash: 'fixture-request', prompt: shot.prompt, controls: shot.controls, bindings: shot.bindings, estimatedCostUsd: null, blockers: [], approved: false }] };
  const commands: Command[] = [];
  const controller = new WorkspaceController({
    listProjects: async () => [workspace.project!], getWorkspace: async () => structuredClone(workspace),
    command: async command => { commands.push(command); assert.equal(command.type, 'generation.prepare'); return { commandId: command.commandId, projectId: 'p', reviewId: 'r' }; },
    uploadAsset: async () => { throw Error('No uploads in focus fixture'); },
  });
  await controller.openProject('p');
  render(<FlumeApp controller={controller} components={parts} autoStart={false} />);
  return { controller, commands };
}

for (const surface of ['review dismissal', 'dirty-modal cancellation'] as const) {
  for (const condition of ['visible', 'collapse', 'hidden', 'inert', 'detached', 'newer-focus'] as const) {
    test(`${surface}: ${condition} opener receives ${condition === 'visible' ? 'one' : 'zero'} scripted focus attempts`, async () => {
      const { controller, commands } = await fixture();
      const dirty = surface === 'dirty-modal cancellation';
      if (dirty) act(() => controller.markDirty('s'));
      const opener = screen.getByRole('button', { name: dirty ? 'Open shot: Two' : 'Prepare fixture' }) as HTMLButtonElement;
      opener.style.visibility = 'visible';
      // jsdom has no layout. Keep a box even when collapsed to reproduce the
      // native boundary that a getClientRects-only eligibility test misses.
      opener.getClientRects = () => [{ width: 80, height: 24 }] as unknown as DOMRectList;
      opener.focus();
      await act(async () => { fireEvent.click(opener); });
      const dismiss = screen.getByRole('button', { name: dirty ? 'Stay here' : 'Dismiss fixture' });
      dismiss.focus();
      let attempts = 0;
      const focus = opener.focus.bind(opener);
      opener.focus = options => { attempts++; focus(options); };
      let newer: HTMLButtonElement | undefined;
      if (condition === 'collapse' || condition === 'hidden') opener.style.visibility = condition;
      else if (condition === 'inert') opener.parentElement!.setAttribute('inert', '');
      else if (condition === 'detached') opener.remove();
      else if (condition === 'newer-focus') {
        newer = document.createElement('button'); newer.dataset.focusFixture = '';
        document.body.append(newer); newer.focus();
      }
      fireEvent.click(dismiss);
      assert.equal(attempts, condition === 'visible' ? 1 : 0, 'Ineligible or superseded opener must receive zero scripted attempts');
      assert.equal(document.activeElement === opener, condition === 'visible');
      if (newer) assert.ok(document.activeElement === newer, 'Newer focus must survive cleanup');
      assert.equal(controller.getSnapshot().activeShotId, 's');
      assert.deepEqual([...controller.getSnapshot().dirtyShotIds], dirty ? ['s'] : []);
      assert.deepEqual(commands.map(command => command.type), dirty ? [] : ['generation.prepare']);
    });
  }
}
