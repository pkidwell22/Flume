import pg from 'pg';
import { migrate } from '@flume/database';
import { createCommandService } from './service.ts';
import { buildServer } from './http.ts';
import { createRuntime } from './runtime.ts';
import { readLocalRuntimeConfiguration } from './local-configuration.ts';
import { readContainerConfiguration, readSecretFile } from './container-configuration.ts';
import { createGateway } from './gateway.ts';
import { createContainerChat } from './container-chat.ts';
import {createChatVisualResolver} from './chat-visual.ts';
import {resolveMediaToolPaths} from './media-bridge.ts';

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
  const chat=process.env.FLUME_CHAT_STORE_ROOT?await(async()=>{const mediaTools=resolveMediaToolPaths(provider.runtime.mediaTools),resolveVisual=createChatVisualResolver({readMedia:service.readMedia,ffmpegPath:mediaTools.ffmpegPath,ffprobePath:mediaTools.ffprobePath,scratchRoot:process.env.FLUME_CHAT_SCRATCH_ROOT});return createContainerChat(process.env,service.getWorkspace,service.command,resolveVisual);})():undefined;
  app = await buildServer({ service, ...(chat ? { chat } : {}), security: { mode: 'local-operator', allowedHosts: container.allowedHosts, allowedOrigins: container.allowedOrigins } });
  await app.listen({ host: '127.0.0.1', port: container.apiPort });
  gateway = createGateway({ staticRoot: process.env.FLUME_STATIC_ROOT ?? '/app/apps/web/dist', apiPort: container.apiPort, allowedHosts: container.allowedHosts });
  await new Promise<void>((resolve, reject) => { gateway!.once('error', reject); gateway!.listen(container.gatewayPort, '0.0.0.0', resolve); });
  console.log(`Flume container gateway ready; workers ${container.autoStartWorkers ? 'enabled after explicit queue audit' : 'disabled'}.`);
  process.once('SIGINT', () => void shutdown()); process.once('SIGTERM', () => void shutdown());
} catch (error) { await shutdown(); throw error; }
