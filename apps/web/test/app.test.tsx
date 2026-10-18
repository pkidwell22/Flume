import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { FlumeApp, ownedMediaUrl } from '../src/App.tsx';
import { WorkspaceController } from '../src/controller.ts';
import type { WorkspaceComponents } from '../src/ports.ts';
import type { Workspace } from '../src/types.ts';

const parts: WorkspaceComponents = {
  Brand: () => <span>Flume</span>, ShotEditor: () => <div>Editor contract probe</div>,
  TakeReview: () => <div>Take review contract probe</div>, ActivityPanel: () => <div>Activity contract probe</div>,
  GenerationReview: ({ review }) => <div>Review {review.id}</div>,
};
const empty: Workspace = { project: null, shots: [], assets: [], takes: [], attempts: [], reviews: [], exports: [], capabilities: [] };
function controller(state = empty) { return new WorkspaceController({ listProjects: async () => [], getWorkspace: async () => state, command: async () => { throw new Error('Not called by rendering'); }, uploadAsset: async () => { throw new Error('Not called by rendering'); } }); }

test('empty workspace invites creation without inventing shots or provider results', async () => {
  const store = controller(); await store.openProject();
  const html = renderToStaticMarkup(<FlumeApp controller={store} components={parts} autoStart={false} />);
  assert.match(html, /Create a project/);
  assert.match(html, /A place for your next film/);
  assert.doesNotMatch(html, /Editor contract probe|Take review contract probe|Generation complete/);
});

test('an open shot composes separate editor, review and activity packages around the media stage', async () => {
  const state: Workspace = { ...empty, project: { id: 'p', name: 'Early light', brief: '', revision: 1 }, shots: [{ id: 's', projectId: 'p', title: 'The opening', prompt: '', revision: 1, selectionRevision: 0, selectedTakeId: null, controls: { modelId: 'blocked-model', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false }, bindings: { firstFrameAssetId: null, lastFrameAssetId: null } }], capabilities: [{ modelId: 'blocked-model', name: 'Hailuo 3', durations: [5], resolutions: ['2K'], frameRoles: ['first_frame', 'last_frame'], seedSupported: false, availability: 'blocked', blocker: 'Account privacy policy excludes this route.' }] };
  const store = controller(state); await store.openProject('p');
  const html = renderToStaticMarkup(<FlumeApp controller={store} components={parts} autoStart={false} />);
  for (const text of ['Editor contract probe', 'Take review contract probe', 'Activity contract probe', 'Start frame', 'End frame', 'Selected take', 'Account privacy policy excludes this route.', 'Editing is still available.']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<video|<img/);
});

test('failed readback does not display a saved-workspace success claim', async () => {
  const store = controller({ ...empty, project: { id: 'p', name: 'Film', brief: '', revision: 1 } });
  await store.openProject('p');
  store.reportError({ code: 'READBACK_FAILED', message: 'The saved state could not be verified.' });
  const html = renderToStaticMarkup(<FlumeApp controller={store} components={parts} autoStart={false} />);
  assert.doesNotMatch(html, /Saved workspace/);
  assert.match(html, /Check saved state/);
});

test('owned preview accepts same-origin media while rejecting remote or non-media URLs', () => {
  const asset = { id: 'a', projectId: 'p', filename: 'a.png', kind: 'image' as const, origin: 'imported' as const, sha256: 'hash', width: 100, height: 100, mediaUrl: '/api/media/a' };
  assert.equal(ownedMediaUrl(asset, 'http://127.0.0.1:5173'), '/api/media/a');
  assert.equal(ownedMediaUrl({ ...asset, mediaUrl: 'http://127.0.0.1:5173/api/media/a' }, 'http://127.0.0.1:5173'), '/api/media/a');
  for (const mediaUrl of ['https://provider.invalid/video.mp4', '//provider.invalid/api/media/a', 'data:image/png;base64,AAAA', 'javascript:alert(1)', '/api/commands']) assert.equal(ownedMediaUrl({ ...asset, mediaUrl }, 'http://127.0.0.1:5173'), undefined);
});
