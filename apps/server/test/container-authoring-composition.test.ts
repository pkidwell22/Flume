// Composition tests for the single authoring seam that BOTH server entry points use
// (`main.ts` for `npm run dev`, `container-main.ts` for the Docker image).
//
// LABELED FIXTURES: the SQL executor, the media port and the command port are in-memory fakes that
// THROW if composition reads them, so these tests prove composition happens without a database, a
// media store or a network call. The only real I/O is a temporary directory used as the staging
// root, and one temporary secret file for the container configuration cases. PostgreSQL, the owned
// media store, OpenRouter and the chat providers are NOT exercised here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { composeAuthoringRuntime } from '../src/authoring-composition.ts';
import { readContainerConfiguration } from '../src/container-configuration.ts';
import type { AuthoringCommandPorts, StoryboardChatPort } from '../src/authoring-runtime.ts';
import type { MediaPort } from '../src/ports.ts';

const scratchRoot = async (prefix: string) => mkdtemp(join(process.env.TMPDIR ?? '/tmp', `${prefix}-`));

/** Fails the test if composition touches SQL, media or a command; none of them belong to composition. */
function fixturePorts() {
  const touched: string[] = [];
  const sql = { query() { touched.push('sql'); throw new Error('composition must not query SQL'); } } as unknown as Pool;
  const media: MediaPort = {
    importLocal() { touched.push('media.import'); throw new Error('composition must not import media'); },
    verifyOwned() { touched.push('media.verify'); throw new Error('composition must not verify media'); },
    readOwned() { touched.push('media.read'); throw new Error('composition must not read media'); },
  };
  const commands = {
    getWorkspace() { touched.push('workspace'); throw new Error('composition must not read a workspace'); },
    command() { touched.push('command'); throw new Error('composition must not dispatch a command'); },
    extractReferenceFrame() { touched.push('extract'); throw new Error('composition must not extract a frame'); },
  } as unknown as AuthoringCommandPorts;
  return { sql, media, commands, touched };
}

const PLANNER_CONFIGURATION = {
  mode: 'chat' as const, modelId: 'google/gemini-2.5-flash', maxTokens: 1_600, timeoutMs: 30_000, maxResponseChars: 48_000,
};

test('the shared seam composes honestly blocked authoring capabilities by default', async () => {
  const root = await scratchRoot('flume-compose-blocked');
  try {
    const stagingRoot = join(root, 'frame-staging');
    const { sql, media, commands, touched } = fixturePorts();
    const runtime = await composeAuthoringRuntime({
      sql, media, commands, stagingRoot, image: { mode: 'blocked' }, planner: null,
    });

    const capabilities = await runtime.capabilities();
    assert.deepEqual(capabilities.imageModels, [], 'the default image route exposes no models');
    assert.equal(capabilities.storyboard.available, false, 'the default storyboard route is blocked');
    assert.match(capabilities.storyboard.blocker ?? '', /Storyboard proposals are not configured/);
    assert.equal(runtime.storyboard, null, 'no storyboard service is invented when no planner is configured');
    assert.equal(typeof runtime.continueShot?.continueShot, 'function', 'continuation is durable and available in both entry points');
    assert.deepEqual(touched, [], 'composition performs no SQL, media or command work');
    // A staging root is not a temp fallback: it is only created when a result is actually staged.
    await assert.rejects(stat(stagingRoot), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the shared seam refuses to compose without a durable staging root', async () => {
  const { sql, media, commands } = fixturePorts();
  await assert.rejects(
    () => composeAuthoringRuntime({ sql, media, commands, stagingRoot: null, image: { mode: 'blocked' }, planner: null }),
    /FLUME_FRAME_STAGING_ROOT or FLUME_DATA_DIR is required for durable frame result staging/,
  );
});

test('a configured image route composes from injected models, estimates and credential only', async () => {
  const root = await scratchRoot('flume-compose-image');
  try {
    const { sql, media, commands, touched } = fixturePorts();
    const runtime = await composeAuthoringRuntime({
      sql, media, commands,
      stagingRoot: join(root, 'frame-staging'),
      image: {
        mode: 'openrouter',
        models: [{ modelId: 'vendor/image-one', name: 'Image One', availability: 'available' }],
        estimatesUsd: { 'vendor/image-one': '0.35' },
        getApiKey: () => 'fixture-image-credential',
      },
      planner: null,
    });

    const capabilities = await runtime.capabilities();
    assert.equal(capabilities.imageModels.length, 1);
    assert.deepEqual({ ...capabilities.imageModels[0] },
      { modelId: 'vendor/image-one', name: 'Image One', availability: 'available', blocker: null, frameRoles: ['first_frame', 'last_frame'] });
    assert.equal(capabilities.storyboard.available, false);
    assert.deepEqual(touched, [], 'a configured image route still composes without a provider or database call');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a configured planner composes a storyboard service over an injected credential port', async () => {
  const root = await scratchRoot('flume-compose-planner');
  try {
    const lookups: string[] = [];
    const chat: StoryboardChatPort = {
      provider: { stream() { throw new Error('composition must not stream'); } } as never,
      async getCredential(modelId) { lookups.push(modelId); return 'fixture-planner-credential'; },
    };
    const { sql, media, commands, touched } = fixturePorts();
    const runtime = await composeAuthoringRuntime({
      sql, media, commands,
      stagingRoot: join(root, 'frame-staging'),
      image: { mode: 'blocked' },
      planner: { configuration: PLANNER_CONFIGURATION, chat: async () => chat },
    });

    const capabilities = await runtime.capabilities();
    assert.equal(capabilities.storyboard.available, true);
    assert.equal(capabilities.storyboard.blocker, null);
    assert.ok(runtime.storyboard, 'the storyboard service is composed from the durable store and the planner');
    assert.deepEqual(lookups, ['google/gemini-2.5-flash'], 'the credential port is asked once, for the configured model');
    assert.deepEqual(touched, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a planner without a server credential stays explicitly blocked instead of half-configured', async () => {
  const root = await scratchRoot('flume-compose-nocred');
  try {
    const chat: StoryboardChatPort = {
      provider: { stream() { throw new Error('no provider call may happen'); } } as never,
      async getCredential() { return null; },
    };
    const { sql, media, commands } = fixturePorts();
    const runtime = await composeAuthoringRuntime({
      sql, media, commands,
      stagingRoot: join(root, 'frame-staging'),
      image: { mode: 'blocked' },
      planner: { configuration: PLANNER_CONFIGURATION, chat: async () => chat },
    });
    const capabilities = await runtime.capabilities();
    assert.equal(capabilities.storyboard.available, false);
    assert.match(capabilities.storyboard.blocker ?? '', /no server credential is configured for the google\/gemini-2\.5-flash planner model/);
    assert.equal(runtime.storyboard, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the planner chat transports are only built when a planner is actually configured', async () => {
  const root = await scratchRoot('flume-compose-lazy');
  try {
    const { sql, media, commands } = fixturePorts();
    let built = 0;
    await composeAuthoringRuntime({
      sql, media, commands,
      stagingRoot: join(root, 'frame-staging'),
      image: { mode: 'blocked' },
      planner: null,
    });
    assert.equal(built, 0);
    await composeAuthoringRuntime({
      sql, media, commands,
      stagingRoot: join(root, 'frame-staging'),
      image: { mode: 'blocked' },
      planner: { configuration: PLANNER_CONFIGURATION, chat: async () => { built += 1; return { provider: {} as never, getCredential: async () => null }; } },
    });
    assert.equal(built, 1, 'a configured planner builds the shared chat transports exactly once');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('container configuration keeps frame staging beneath the server-owned durable media root', async () => {
  const root = await scratchRoot('flume-container-staging');
  try {
    const passwordFile = join(root, 'postgres-password');
    await writeFile(passwordFile, 'fixture-password\n', { mode: 0o600 });
    const base = {
      POSTGRES_HOST: 'db', POSTGRES_DB: 'flume', POSTGRES_USER: 'flume', POSTGRES_PASSWORD_FILE: passwordFile,
      FLUME_STORAGE_ROOT: '/data/media', FLUME_PUBLIC_ORIGIN: 'http://127.0.0.1:4410',
    };

    const derived = await readContainerConfiguration(base);
    assert.equal(derived.mediaRoot, '/data/media');
    assert.equal(derived.frameStagingRoot, '/data/media/frame-staging', 'staging is derived beneath the durable media volume');

    const explicit = await readContainerConfiguration({ ...base, FLUME_FRAME_STAGING_ROOT: '/data/media/staging/frames' });
    assert.equal(explicit.frameStagingRoot, '/data/media/staging/frames');

    // No temporary-world fallback and no second writable root: the container root filesystem is
    // read-only, so anything outside the durable volume is refused at startup.
    for (const outside of ['/tmp/frame-staging', '/data/frame-staging', '/data/media']) {
      await assert.rejects(() => readContainerConfiguration({ ...base, FLUME_FRAME_STAGING_ROOT: outside }),
        /FLUME_FRAME_STAGING_ROOT must be an absolute path beneath FLUME_STORAGE_ROOT/, outside);
    }
    await assert.rejects(() => readContainerConfiguration({ ...base, FLUME_FRAME_STAGING_ROOT: 'data/media/frame-staging' }),
      /FLUME_FRAME_STAGING_ROOT must be an absolute path beneath FLUME_STORAGE_ROOT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
