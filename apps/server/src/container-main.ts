import pg from 'pg';
import { migrate } from '@flume/database';
import { createCommandService } from './service.ts';
import { buildServer } from './http.ts';
import { createRuntime } from './runtime.ts';
import { readLocalRuntimeConfiguration } from './local-configuration.ts';
import { readContainerConfiguration, readSecretFile } from './container-configuration.ts';
import { createGateway } from './gateway.ts';
import { createChatProviderStack, createContainerChat } from './container-chat.ts';
import {createChatVisualResolver} from './chat-visual.ts';
import {resolveMediaToolPaths} from './media-bridge.ts';
import { composeAuthoringRuntime } from './authoring-composition.ts';

const container = await readContainerConfiguration(process.env);
const providerEnvironment: Record<string, string | undefined> = { ...process.env, OPENROUTER_API_KEY: undefined };
if ((process.env.FLUME_PROVIDER_MODE ?? 'edit-only') !== 'edit-only') {
  providerEnvironment.OPENROUTER_API_KEY = await readSecretFile(process.env.OPENROUTER_API_KEY_FILE, 'OPENROUTER_API_KEY_FILE');
}
const provider = readLocalRuntimeConfiguration(providerEnvironment);
const pool = new pg.Pool(container.database);
let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
let gateway: ReturnType<typeof createGateway> | undefined;
let closing: Promise<void> | undefined;
const closeGateway = () => new Promise<void>((resolve, reject) => gateway?.close(error => error ? reject(error) : resolve()) ?? resolve());
const shutdown = () => closing ??= (async () => {
  await closeGateway(); await app?.close(); await runtime?.close(); await pool.end();
})();
try {
  await migrate(pool);
  runtime = await createRuntime({ pool, mediaRoot: container.mediaRoot, autoStart: container.autoStartWorkers, ...provider.runtime });
  if (provider.discover && container.autoStartWorkers) await runtime.discover();
  const service = createCommandService({ pool, ...runtime.serviceOptions, workerAvailable: container.autoStartWorkers });
  // Authoring parity with the local launcher: the same composition seam, the same durable journals,
  // staging and continuation wiring, so an image built from this source serves the authoring UI with
  // real endpoints behind it. Image authoring and storyboard planning stay blocked unless they are
  // explicitly configured, and an enabled image route reads its own FILE credential — enabling image
  // authoring does not require video generation (FLUME_PROVIDER_MODE) to be enabled.
  const imageAuthoring = provider.authoring.image;
  const imageAuthoringCredential = imageAuthoring.mode === 'openrouter'
    ? await readSecretFile(process.env.OPENROUTER_API_KEY_FILE, 'OPENROUTER_API_KEY_FILE')
    : null;
  const authoring = await composeAuthoringRuntime({
    sql: pool,
    media: runtime.serviceOptions.media,
    commands: service,
    stagingRoot: container.frameStagingRoot,
    image: imageAuthoring.mode === 'openrouter'
      ? { ...imageAuthoring, getApiKey: () => imageAuthoringCredential ?? undefined }
      : imageAuthoring,
    planner: provider.storyboard.mode === 'chat'
      ? { configuration: provider.storyboard, chat: () => createChatProviderStack(process.env) }
      : null,
  });
  const chat=process.env.FLUME_CHAT_STORE_ROOT?await(async()=>{const mediaTools=resolveMediaToolPaths(provider.runtime.mediaTools),resolveVisual=createChatVisualResolver({readMedia:service.readMedia,ffmpegPath:mediaTools.ffmpegPath,ffprobePath:mediaTools.ffprobePath,scratchRoot:process.env.FLUME_CHAT_SCRATCH_ROOT});return createContainerChat(process.env,service.getWorkspace,service.command,resolveVisual);})():undefined;
  app = await buildServer({ service, authoring, ...(chat ? { chat } : {}), security: { mode: 'local-operator', allowedHosts: container.allowedHosts, allowedOrigins: container.allowedOrigins } });
  await app.listen({ host: '127.0.0.1', port: container.apiPort });
  gateway = createGateway({ staticRoot: process.env.FLUME_STATIC_ROOT ?? '/app/apps/web/dist', apiPort: container.apiPort, allowedHosts: container.allowedHosts });
  await new Promise<void>((resolve, reject) => { gateway!.once('error', reject); gateway!.listen(container.gatewayPort, '0.0.0.0', resolve); });
  console.log(`Flume container gateway ready; workers ${container.autoStartWorkers ? 'enabled after explicit queue audit' : 'disabled'}. ${imageAuthoring.mode === 'openrouter' ? 'Image authoring configured; every submit needs an operator-approved cap above the server estimate.' : 'Image authoring blocked; no image models or quotes are exposed.'} ${authoring.storyboard ? 'Storyboard proposals use the configured planner model.' : 'Storyboard proposals stay blocked until a planner model is configured.'} Frame result staging: ${container.frameStagingRoot}.`);
  process.once('SIGINT', () => void shutdown()); process.once('SIGTERM', () => void shutdown());
} catch (error) { await shutdown(); throw error; }
