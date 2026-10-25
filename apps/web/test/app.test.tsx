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
  assert.match(html, /by Mountain Meadow Systems/);
  assert.match(html, /alpine-forest-wide.webp/);
  assert.match(html, /aria-hidden="true"/);
  assert.doesNotMatch(html, /Editor contract probe|Take review contract probe|Generation complete/);
});

test('an empty saved project uses house artwork without inventing project media', async () => {
  const store = controller({ ...empty, project: { id: 'p', name: 'Mountain film', brief: '', revision: 1 } });
  await store.openProject('p');
  const html = renderToStaticMarkup(<FlumeApp controller={store} components={parts} autoStart={false} />);
  assert.match(html, /Mountain film/); assert.match(html, /Create a shot/);
  assert.match(html, /by Mountain Meadow Systems/); assert.match(html, /alpine-forest-wide.webp/);
  assert.equal(store.getSnapshot().workspace?.assets.length, 0);
});

test('an open shot composes the editor in the slate beside the saved frame pair, with results and activity one step away', async () => {
  const state: Workspace = { ...empty, project: { id: 'p', name: 'Early light', brief: '', revision: 1 }, shots: [{ id: 's', projectId: 'p', title: 'The opening', prompt: '', revision: 1, selectionRevision: 0, selectedTakeId: null, controls: { modelId: 'blocked-model', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false }, bindings: { firstFrameAssetId: null, lastFrameAssetId: null } }], capabilities: [{ modelId: 'blocked-model', name: 'Hailuo 3', durations: [5], resolutions: ['2K'], frameRoles: ['first_frame', 'last_frame'], seedSupported: false, availability: 'blocked', blocker: 'Account privacy policy excludes this route.' }] };
  const store = controller(state); await store.openProject('p');
  const html = renderToStaticMarkup(<FlumeApp controller={store} components={parts} autoStart={false} />);
  for (const text of ['Editor contract probe', 'Start frame', 'End frame', 'No selected take', 'Your shot starts here.', 'Give the shot an ending.', 'Account privacy policy excludes this route.', 'Generation is blocked in this build.', 'Editing and saving still work.']) assert.ok(html.includes(text), text);
  // Takes and Activity are explicit views (stage toggle, drawer); they are not pre-rendered.
  assert.doesNotMatch(html, /Take review contract probe|Activity contract probe/);
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
