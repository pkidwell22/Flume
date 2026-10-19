// Actual App and adapters; synthetic, in-memory media and command ports only.
/* __ACTUAL_ENTRY_CSS__ */
import { createRoot } from 'react-dom/client';
import { FlumeApp } from '../../../../apps/web/src/App.tsx';
import { WorkspaceController } from '../../../../apps/web/src/controller.ts';
import { workspaceComponents } from '../../../../apps/web/src/composition.ts';
import type { Asset, Workspace } from '../../../../apps/web/src/types.ts';
const mode = new URLSearchParams(location.search).get('mode');
const project = { id: 'reference-project', name: 'Reference lifecycle fixture', brief: '', revision: 1 };
const makeAsset = (id: string, width: number, height: number): Asset => ({ id, projectId: project.id,
  filename: `${id}-owned-${'long-name-'.repeat(5)}.svg`, kind: 'image', origin: 'sample', sha256: 'fixture-not-production',
  mediaUrl: `/api/media/${id}`, width, height });
const start = makeAsset('start', 400, 1200), end = makeAsset('end', 1600, 400), candidate = makeAsset('candidate', 400, 1200);
if (mode === 'failed') end.mediaUrl = '/api/media/broken';
const workspace: Workspace = { project,
  shots: [{ id: 'reference-shot', projectId: project.id, title: 'A quiet crossing', prompt: 'Describe the shot and its motion.', revision: 1,
    selectionRevision: 0, selectedTakeId: null, bindings: { firstFrameAssetId: 'start', lastFrameAssetId: 'end' },
    controls: { modelId: 'paired', durationSeconds: 5, resolution: '2K', aspectRatio: '16:9', generateAudio: false } }],
  assets: mode === 'missing' ? [start, candidate] : [start, end, candidate], takes: [], exports: [], attempts: [], reviews: [],
  capabilities: [{ modelId: 'paired', name: 'Paired-frame fixture', durations: [5], resolutions: ['2K'], frameRoles: ['first_frame', 'last_frame'], seedSupported: true,
    availability: 'available', blocker: null, aspectRatios: ['16:9'], generateAudioSupported: true }],
};
const commands: unknown[] = [], uploads: unknown[] = [];
let finishUpload: (() => void) | undefined;
const controller = new WorkspaceController({
  listProjects: async () => [project], getWorkspace: async () => structuredClone(workspace),
  uploadAsset: (file, projectId) => { uploads.push({ name: file.name, projectId }); return new Promise(resolve => {
    finishUpload = () => { resolve(candidate); finishUpload = undefined; };
  }); },
  command: async command => {
    commands.push(command);
    if (command.type === 'shot.update') {
      const current = workspace.shots[0]!;
      workspace.shots[0] = { ...current, ...command.patch, controls: { ...current.controls, ...command.patch.controls, seed: command.patch.controls?.seed ?? undefined },
        bindings: { ...current.bindings, ...command.patch.bindings }, revision: command.expectedRevision + 1 };
      return { commandId: command.commandId, projectId: project.id, revision: command.expectedRevision + 1 };
    }
    if (command.type === 'generation.prepare') {
      const shot = workspace.shots[0]!;
      workspace.reviews = [{ id: 'reference-review', projectId: project.id, shotId: shot.id, shotRevision: shot.revision,
        requestHash: 'synthetic-request', prompt: shot.prompt, controls: shot.controls, bindings: shot.bindings, estimatedCostUsd: '0.5', blockers: [], approved: mode === 'approved-failed' }];
      return { commandId: command.commandId, projectId: project.id, reviewId: 'reference-review' };
    }
    throw Error('No approval, generation or provider authority in this fixture');
  },
});
Object.assign(window, { referenceFixture: { commands, uploads,
  finishUpload: () => finishUpload?.(),
  state: () => ({ dirty: [...controller.getSnapshot().dirtyShotIds], busy: controller.getSnapshot().busy,
    saved: structuredClone(workspace.shots[0]), commands: structuredClone(commands), uploads: structuredClone(uploads) }),
} });
createRoot(document.getElementById('root')!).render(<FlumeApp controller={controller} components={workspaceComponents} initialProjectId={project.id}
  previewLabel="Owned reference lifecycle test · actual App / synthetic diagrams / in-memory ports · no provider" />);
