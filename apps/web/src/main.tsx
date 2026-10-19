import { createRoot } from 'react-dom/client';
import { createBrowserClient } from '@flume/client';
import '@flume/ui/theme.css';
import '@flume/shot-editor/styles.css';
// Creator-control styles are separate from the shared cinema skin.
import '../../../packages/shot-editor/src/creator-controls.css';
import '@flume/take-review/styles.css';
import '@flume/activity-review/styles.css';
import './workspace.css';
import './project-rail.css';
import { FlumeApp } from './App.tsx';
import { WorkspaceController } from './controller.ts';
import { workspaceComponents } from './composition.ts';
import type { FlumePort } from './types.ts';

// No bearer keys, server credentials or provider URLs belong in this module.
// The same-origin server supplies the explicit local-operator policy.
const browser = createBrowserClient();
const client: FlumePort = {
  listProjects: () => browser.listProjects(),
  getWorkspace: projectId => browser.getWorkspace(projectId),
  command: command => browser.command(command),
  uploadAsset: (file, projectId) => browser.uploadAsset(projectId, file, file.name),
};
const controller = new WorkspaceController(client);
const root = document.getElementById('root');
if (!root) throw new Error('Flume mount point is missing.');
createRoot(root).render(<FlumeApp controller={controller} components={workspaceComponents} initialProjectId={new URLSearchParams(window.location.search).get('projectId') ?? undefined} />);
