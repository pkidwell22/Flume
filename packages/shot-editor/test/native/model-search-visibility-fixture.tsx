// Actual App + anchored ShotEditor. In-memory fixtures have no write authority.
// The runner injects the exact main.tsx CSS import sequence at this marker.
/* __ACTUAL_ENTRY_CSS__ */
import { useState } from 'react';
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
const params = new URLSearchParams(location.search);
const long = params.has('long');
if (long) {
  workspace.capabilities = Array.from({ length: 40 }, (_, i) => ({ ...workspace.capabilities[0]!,
    modelId: i === 39 ? '  fixture/Mixed-ID  ' : `fixture/route-${i}`,
    name: i === 28 ? 'Selected long model with deliberately verbose support details and a wrapping title' : `Fixture model ${i}`,
    availability: i % 2 ? 'unknown' : 'blocked',
    blocker: i === 28 ? 'Long selected fixture detail. '.repeat(15) : 'Synthetic route; no provider authority.',
  }));
  workspace.shots[0]!.controls.modelId = workspace.capabilities[28]!.modelId;
}
const commands: unknown[] = [];
const uploads: unknown[] = [];
const changes: string[] = [];
const port: FlumePort = {
  listProjects: async () => [structuredClone(project)],
  getWorkspace: async () => structuredClone(workspace),
  uploadAsset: async input => { uploads.push(input); throw new Error('Uploads forbidden in search fixture'); },
  command: async command => { commands.push(command); throw new Error('Commands forbidden in search fixture'); },
};
const controller = new WorkspaceController(port);
Object.assign(window, { surfaceFixture: {
  commands, uploads, changes,
  initial: structuredClone(workspace.shots[0]),
  state: () => ({ dirtyShotIds: [...controller.getSnapshot().dirtyShotIds], reviewId: controller.getSnapshot().reviewId }),
} });
function Component() {
  const [value, setValue] = useState(workspace.shots[0]!.controls.modelId);
  return <main className="fl-theme" style={{ padding: 16 }}>
    <p>Owned component fixture · supplied synthetic catalog · no providers</p>
    <div style={{ height: 190 }} />
    <section className="fl-shot-editor">
      <ModelPicker value={value} capabilities={workspace.capabilities} onChange={id => { changes.push(id); setValue(id); }} />
      <button id="after-picker" type="button">After picker</button>
    </section>
    <div style={{ height: 1000 }} />
  </main>;
}
createRoot(document.getElementById('root')!).render(params.has('component') ? <Component />
  : <FlumeApp controller={controller} components={workspaceComponents} initialProjectId={project.id}
      previewLabel="Isolated search test · actual App / creator · in-memory port · no providers" />);
