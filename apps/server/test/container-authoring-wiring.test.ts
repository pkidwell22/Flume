// Container entry-point wiring: the Docker composition must serve the SAME authoring surface as the
// local launcher. The entry point is executed in a VM with its module graph stubbed (the technique
// `main-wiring.test.ts` already uses for `main.ts`), so these tests assert what the real
// `container-main.ts` passes to the shared composition seam and to `buildServer`.
//
// LABELED FIXTURES: pg, the runtime, the command service, the gateway and the authoring seam are
// in-memory stubs; the container configuration and chat-transport modules are the REAL ones, so the
// FILE-only credential convention is exercised end to end. No database, no network, no provider.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as containerChat from '../src/container-chat.ts';
import { readContainerConfiguration, readSecretFile } from '../src/container-configuration.ts';
import { readLocalRuntimeConfiguration } from '../src/local-configuration.ts';

const MEDIA_PORT = {
  importLocal() { throw new Error('the entry point must not import media during composition'); },
  verifyOwned() { throw new Error('the entry point must not verify media during composition'); },
  readOwned() { throw new Error('the entry point must not read media during composition'); },
};
const COMMANDS = {
  getWorkspace() { throw new Error('the entry point must not read a workspace during composition'); },
  command() { throw new Error('the entry point must not dispatch a command during composition'); },
  extractReferenceFrame() { throw new Error('the entry point must not extract a frame during composition'); },
};

async function scratch(prefix: string) {
  return mkdtemp(join(process.env.TMPDIR ?? '/tmp', `${prefix}-`));
}

/** Runs the real container entry point with its I/O modules replaced; returns everything it passed on. */
async function runContainerEntrypoint(env: Record<string, string | undefined>) {
  const source = await readFile(new URL('../src/container-main.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const events: string[] = [];
  const logs: string[] = [];
  const captured: { compose?: any; server?: any; service?: any; runtime?: any; gateway?: any } = {};
  const authoringRuntime = {
    capabilities: async () => ({ imageModels: [], storyboard: { available: false, blocker: 'fixture blocker' } }),
    storyboard: null,
    continueShot: null,
  };
  const modules: Record<string, unknown> = {
    pg: { Pool: class { async end() { events.push('pool.end'); } } },
    '@flume/database': { migrate: async () => { events.push('migrate'); } },
    './runtime.ts': {
      createRuntime: async (input: any) => {
        events.push('runtime');
        captured.runtime = input;
        return {
          serviceOptions: { media: MEDIA_PORT },
          discover: async () => { events.push('discover'); },
          close: async () => { events.push('runtime.close'); },
        };
      },
    },
    './service.ts': {
      createCommandService: (input: any) => { events.push('service'); captured.service = input; return COMMANDS; },
    },
    './http.ts': {
      buildServer: async (input: any) => {
        events.push('http');
        captured.server = input;
        return { listen: async () => { events.push('listen'); }, close: async () => { events.push('app.close'); } };
      },
    },
    './local-configuration.ts': { readLocalRuntimeConfiguration },
    './container-configuration.ts': { readContainerConfiguration, readSecretFile },
    './gateway.ts': {
      createGateway: (input: any) => {
        events.push('gateway');
        captured.gateway = input;
        return {
          once() { /* no startup error in the fixture */ },
          listen(port: number, host: string, ready: () => void) { events.push(`gateway.listen:${host}:${port}`); ready(); },
          close(done: (error?: Error) => void) { events.push('gateway.close'); done(); },
        };
      },
    },
    './container-chat.ts': containerChat,
    './chat-visual.ts': { createChatVisualResolver: () => { throw new Error('the chat visual resolver needs an explicit store root'); } },
    './media-bridge.ts': { resolveMediaToolPaths: () => { throw new Error('media tool paths need an explicit store root'); } },
    './authoring-composition.ts': {
      composeAuthoringRuntime: async (input: any) => {
        events.push('authoring.compose');
        captured.compose = input;
        return authoringRuntime;
      },
    },
  };
  await runInNewContext(`(async()=>{${code}\n})()`, {
    exports: {},
    require: (name: string) => { assert.ok(name in modules, `unexpected module ${name}`); return modules[name]; },
    process: { env, once() { /* signal handlers are not exercised */ } },
    console: { log: (text: string) => logs.push(text) },
  });
  return { events, logs, captured, authoringRuntime };
}

async function containerEnvironment(extra: Record<string, string | undefined> = {}) {
  const root = await scratch('flume-container-entry');
  const passwordFile = join(root, 'postgres-password');
  await writeFile(passwordFile, 'fixture-password\n', { mode: 0o600 });
  return {
    root,
    env: {
      POSTGRES_HOST: 'db', POSTGRES_PORT: '5432', POSTGRES_DB: 'flume', POSTGRES_USER: 'flume',
      POSTGRES_PASSWORD_FILE: passwordFile,
      FLUME_STORAGE_ROOT: '/data/media', FLUME_PUBLIC_ORIGIN: 'http://127.0.0.1:4410',
      ...extra,
    } as Record<string, string | undefined>,
  };
}

const NO_CREDENTIAL_FILES = {
  // Deliberately absent: a blocked image route and an unconfigured planner must never open one.
  OPENROUTER_API_KEY_FILE: '/nonexistent/container/openrouter-key',
  FLUME_CHAT_API_KEY_FILE: '/nonexistent/container/chat-key',
  FLUME_OLLAMA_API_KEY_FILE: '/nonexistent/container/ollama-key',
};

test('the container entry point serves authoring: blocked by default, composed before it listens', async () => {
  const { root, env } = await containerEnvironment(NO_CREDENTIAL_FILES);
  try {
    const { events, logs, captured, authoringRuntime } = await runContainerEntrypoint(env);

    assert.ok(captured.compose, 'the container entry point must compose the shared authoring seam');
    assert.equal(captured.compose.stagingRoot, '/data/media/frame-staging');
    assert.equal(captured.compose.image.mode, 'blocked');
    assert.equal(captured.compose.planner, null);
    assert.equal(captured.compose.media, MEDIA_PORT, 'authoring reuses the runtime owned-media port');
    assert.equal(captured.compose.commands, COMMANDS, 'authoring reuses the same command service');
    assert.equal(captured.server.authoring, authoringRuntime, 'buildServer receives the composed authoring runtime');
    assert.equal(captured.service.workerAvailable, false, 'the disabled-worker gate is preserved');
    assert.equal(captured.runtime.autoStart, false);
    assert.deepEqual(events, ['migrate', 'runtime', 'service', 'authoring.compose', 'http', 'listen', 'gateway', 'gateway.listen:0.0.0.0:8080']);
    assert.match(logs.join('\n'), /Flume container gateway ready/);
    assert.match(logs.join('\n'), /workers disabled/);
    assert.match(logs.join('\n'), /Image authoring blocked/);
    assert.match(logs.join('\n'), /Storyboard proposals stay blocked/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('image-only container authoring is configured from a file credential without enabling video mode', async () => {
  const { root, env } = await containerEnvironment();
  try {
    const keyFile = join(root, 'openrouter-key');
    await writeFile(keyFile, 'synthetic-file-image-credential\n', { mode: 0o600 });
    const { logs, captured } = await runContainerEntrypoint({
      ...env,
      // FLUME_PROVIDER_MODE stays unset: the default is edit-only, and image authoring must not need it.
      FLUME_IMAGE_AUTHORING_MODE: 'openrouter',
      FLUME_OPENROUTER_SCOPE: 'openrouter/synthetic-account/v1',
      FLUME_IMAGE_AUTHORING_MODELS: JSON.stringify([{ modelId: 'vendor/image-one', name: 'Image One', availability: 'available' }]),
      FLUME_IMAGE_AUTHORING_ESTIMATES_USD: JSON.stringify({ 'vendor/image-one': '0.35' }),
      OPENROUTER_API_KEY_FILE: keyFile,
      // A bare environment credential is never the container convention; it must be ignored.
      OPENROUTER_API_KEY: 'synthetic-bare-environment-key',
    });

    assert.equal(captured.compose.image.mode, 'openrouter');
    assert.equal(captured.compose.image.models.length, 1);
    assert.equal(captured.compose.image.models[0].modelId, 'vendor/image-one');
    assert.equal(captured.compose.image.estimatesUsd['vendor/image-one'], '0.35');
    assert.equal(captured.compose.image.getApiKey(), 'synthetic-file-image-credential');
    assert.equal(captured.compose.planner, null, 'no planner is composed from an image-only configuration');
    assert.equal(captured.runtime.autoStart, false, 'image authoring does not enable media workers');
    assert.match(logs.join('\n'), /Image authoring configured/);
    assert.equal(logs.join('\n').includes('synthetic-file-image-credential'), false, 'no credential may reach the logs');
    assert.equal(logs.join('\n').includes('synthetic-bare-environment-key'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a configured planner reaches the shared file-only chat transports in the container', async () => {
  const { root, env } = await containerEnvironment(NO_CREDENTIAL_FILES);
  try {
    const chatKeyFile = join(root, 'chat-key');
    await writeFile(chatKeyFile, 'synthetic-planner-file-credential\n', { mode: 0o600 });
    // The container chat transports are FILE-only and fail closed: a declared but unreadable
    // credential file is a startup error, never a silent "no key" downgrade.
    await assert.rejects(() => containerChat.createChatProviderStack({ FLUME_OLLAMA_API_KEY_FILE: join(root, 'missing-ollama-key') }),
      /ENOENT|FLUME_OLLAMA_API_KEY_FILE/);
    const { logs, captured } = await runContainerEntrypoint({
      ...env,
      FLUME_STORYBOARD_PLANNER_MODEL: 'google/gemini-2.5-flash',
      FLUME_CHAT_API_KEY_FILE: chatKeyFile,
      FLUME_OLLAMA_API_KEY_FILE: undefined,
    });

    assert.ok(captured.compose.planner, 'a configured planner model must produce a planner seam');
    assert.equal(captured.compose.planner.configuration.mode, 'chat');
    assert.equal(captured.compose.planner.configuration.modelId, 'google/gemini-2.5-flash');
    const chat = await captured.compose.planner.chat();
    assert.equal(await chat.getCredential('google/gemini-2.5-flash'), 'synthetic-planner-file-credential');
    assert.equal(await chat.getCredential('ollama/kimi-k3'), null, 'an unconfigured provider keeps no credential');
    assert.equal(await chat.getCredential('vendor/not-registered'), null, 'an unregistered model is never credentialed');
    assert.equal(logs.join('\n').includes('synthetic-planner-file-credential'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the container entry point never bypasses the queue-audit worker gate', async () => {
  const { root, env } = await containerEnvironment();
  try {
    await assert.rejects(() => runContainerEntrypoint({ ...env, FLUME_WORKERS_ENABLED: '1' }), /queue audit/);
    const { captured, events } = await runContainerEntrypoint({ ...env, FLUME_WORKERS_ENABLED: '1', FLUME_QUEUE_AUDITED: '1' });
    assert.equal(captured.service.workerAvailable, true);
    assert.equal(captured.runtime.autoStart, true);
    assert.ok(events.includes('authoring.compose'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
