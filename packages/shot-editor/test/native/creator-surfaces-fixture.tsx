// Actual App + anchored ShotEditor. In-memory fixtures have no write authority.
// The runner injects the exact main.tsx CSS import sequence at this marker.
/* __ACTUAL_ENTRY_CSS__ */
import { createRoot } from 'react-dom/client';
import { FlumeApp } from '../../../../apps/web/src/App.tsx';
import { WorkspaceController } from '../../../../apps/web/src/controller.ts';
import { workspaceComponents } from '../../../../apps/web/src/composition.ts';
import type { Workspace, FlumePort } from '../../../../apps/web/src/types.ts';
import { PromptComposer } from '../../src/PromptComposer.tsx';
import { ModelPicker } from '../../src/ModelPicker.tsx';

const project = { id: 'surface-project', name: 'The quiet crossing', brief: 'Owned surface fixture', revision: 1 };
const workspace: Workspace = {
  project,
  shots: [{ id: 'surface-shot', projectId: project.id, title: 'Across the threshold',
    prompt: 'Hold the opening composition.\nMove slowly toward the doorway; keep the whole frame.',
    revision: 1, selectionRevision: 0, selectedTakeId: null,
    bindings: { firstFrameAssetId: 'surface-first', lastFrameAssetId: 'surface-last' },
    controls: { modelId: 'fixture/paired', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false } }],
  assets: [
    { id: 'surface-first', projectId: project.id, filename: 'owned-portrait.svg', kind: 'image', origin: 'sample', sha256: 'fixture-portrait-not-production', mediaUrl: '/api/media/surface-first', width: 400, height: 1200 },
    { id: 'surface-last', projectId: project.id, filename: 'owned-panorama.svg', kind: 'image', origin: 'sample', sha256: 'fixture-panorama-not-production', mediaUrl: '/api/media/surface-last', width: 1600, height: 400 },
  ],
  takes: [], exports: [], attempts: [], reviews: [],
  capabilities: [
    { modelId: 'fixture/paired', name: 'Paired-frame model', durations: [5, 10], resolutions: ['2K', '1080p'], frameRoles: ['first_frame', 'last_frame'], seedSupported: true, availability: 'blocked', blocker: 'Owned fixture. No provider connection or generation authority.', aspectRatios: ['16:9', '9:16'], generateAudioSupported: true },
    ...Array.from({ length: 8 }, (_, i) => ({ modelId: `fixture/route-${i}`, name: `Fixture model ${i}`, durations: [5], resolutions: ['2K'], frameRoles: ['first_frame'], seedSupported: true, availability: 'unknown' as const, blocker: 'Synthetic catalog entry; readiness is unknown.', aspectRatios: ['16:9'], generateAudioSupported: false })),
  ],
};
const commands: unknown[] = [];
const port: FlumePort = {
  listProjects: async () => [structuredClone(project)],
  getWorkspace: async () => structuredClone(workspace),
  uploadAsset: async () => { throw new Error('Uploads forbidden in surface fixture'); },
  command: async command => { commands.push(command); throw new Error('Commands forbidden in surface fixture'); },
};
const controller = new WorkspaceController(port);
Object.assign(window, { surfaceFixture: {
  commands,
  state: () => ({ dirtyShotIds: [...controller.getSnapshot().dirtyShotIds], reviewId: controller.getSnapshot().reviewId }),
} });
const disabled = new URLSearchParams(location.search).has('disabled');
createRoot(document.getElementById('root')!).render(disabled
  ? <main className="fl-theme" style={{ padding: 16 }}><p>Explicit component-disabled fixture — not App busy policy</p><section className="fl-shot-editor">
      <PromptComposer value="Literal disabled prompt remains readable." onChange={() => { throw new Error('Disabled prompt changed'); }} disabled />
      <ModelPicker value="fixture/paired" capabilities={workspace.capabilities} onChange={() => { throw new Error('Disabled model changed'); }} disabled />
    </section></main>
  : <FlumeApp controller={controller} components={workspaceComponents} initialProjectId={project.id}
      previewLabel="Isolated surface test · actual App / anchored creator · owned diagrams / in-memory port · no provider" />);
