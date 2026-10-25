import { createRoot } from 'react-dom/client';
import { createBrowserClient } from '@flume/client';
import './fonts.ts';
import '@flume/ui/theme.css';
import '@flume/shot-editor/styles.css';
// Creator-control styles are separate from the shared cinema skin.
import '../../../packages/shot-editor/src/creator-controls.css';
import '@flume/take-review/styles.css';
import '@flume/activity-review/styles.css';
import './workspace.css';
import './frame-authoring.css';
import './storyboard-composer.css';
import './authoring-workspace.css';
import { FlumeApp } from './App.tsx';
import { WorkspaceController } from './controller.ts';
import { createAuthoringApi } from './authoring-api.ts';
import { createReferenceProvenanceApi } from './reference-provenance.ts';
import { workspaceComponents } from './composition.ts';
import type { FlumePort } from './types.ts';
import { createHttpChatPort } from './ChatPanel.tsx';

// No bearer keys, server credentials or provider URLs belong in this module.
// The same-origin server supplies the explicit local-operator policy.
const browser = createBrowserClient();
const client: FlumePort = {
  listProjects: () => browser.listProjects(),
  getWorkspace: projectId => browser.getWorkspace(projectId),
  command: command => browser.command(command),
  uploadAsset: (file, projectId) => browser.uploadAsset(projectId, file, file.name),
};
// Persist only an identity hint. Creative content, revisions and outcomes always
// come from an authorized server GET; reading this hint cannot replay a mutation.
const bookmarkKey = (projectId: string) => `flume.storyboard.v1:${projectId}`;
// Continuation recovery stores the operation id ONLY; the request, progress and outcome are read
// from the authorized server journal. Reading this hint cannot replay or invent a mutation.
const continuationKey = (projectId: string) => `flume.continuation.v1:${projectId}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const controller = new WorkspaceController(client, createAuthoringApi(), {
  read(projectId) {
    const value = window.localStorage.getItem(bookmarkKey(projectId));
    return value && uuid.test(value) ? value : null;
  },
  write(projectId, proposalId) {
    if (proposalId) window.localStorage.setItem(bookmarkKey(projectId), proposalId);
    else window.localStorage.removeItem(bookmarkKey(projectId));
  },
}, {
  read(projectId) {
    const value = window.localStorage.getItem(continuationKey(projectId));
    return value && uuid.test(value) ? value : null;
  },
  write(projectId, operationId) {
    if (operationId) window.localStorage.setItem(continuationKey(projectId), operationId);
    else window.localStorage.removeItem(continuationKey(projectId));
  },
}, createReferenceProvenanceApi());
const root = document.getElementById('root');
if (!root) throw new Error('Flume mount point is missing.');
createRoot(root).render(<FlumeApp controller={controller} components={workspaceComponents} chatPort={createHttpChatPort()} initialProjectId={new URLSearchParams(window.location.search).get('projectId') ?? undefined} />);
