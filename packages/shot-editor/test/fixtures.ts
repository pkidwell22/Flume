import type { ShotView, AssetView, CapabilityView } from '../src/types.ts';

export const shot: ShotView = {
  id: 'shot-1',
  projectId: 'project-1',
  revision: 3,
  title: 'The turn',
  prompt: 'A red cup turns in the light.',
  controls: {
    modelId: 'paired',
    durationSeconds: 5,
    resolution: '2K',
    aspectRatio: '16:9',
    generateAudio: false,
    seed: 0,
  },
  bindings: { firstFrameAssetId: 'start', lastFrameAssetId: 'end' },
  selectedTakeId: null,
  selectionRevision: 0,
};
export const assets: AssetView[] = [
  {
    id: 'start',
    projectId: 'project-1',
    filename: 'cup-start.png',
    kind: 'image',
    origin: 'sample',
    sha256: 'a'.repeat(64),
    mediaUrl: '/api/media/start',
    width: 1280,
    height: 720,
  },
  {
    id: 'end',
    projectId: 'project-1',
    filename: 'cup-end.png',
    kind: 'image',
    origin: 'sample',
    sha256: 'b'.repeat(64),
    mediaUrl: '/api/media/end',
    width: 1280,
    height: 720,
  },
];
export const capabilities: CapabilityView[] = [
  {
    modelId: 'paired',
    name: 'Paired-frame model',
    durations: [5, 10],
    resolutions: ['2K', '1080p'],
    frameRoles: ['first_frame', 'last_frame'],
    seedSupported: true,
    availability: 'available',
    blocker: null,
  },
  {
    modelId: 'start-only',
    name: 'Start-only model',
    durations: [6],
    resolutions: ['720p'],
    frameRoles: ['first_frame'],
    seedSupported: false,
    availability: 'blocked',
    blocker: 'Account privacy settings block this model.',
  },
];
