import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';

// Unit orchestration evidence: no OS processes, stores or provider calls.
const dev = await readFile(new URL('./dev.mjs', import.meta.url), 'utf8');
const text = dev.slice(dev.indexOf('export async function launchDevelopment('), dev.indexOf("if (process.argv[1]")).replace('export async function', 'async function');
test('completed installation and migration are drained now and not retained for shutdown (synthetic owners)', async () => {
  const oneShots = []; const services = []; const never = new Promise(() => {}); let port = 23000;
  const launch = runInNewContext(text + '\nlaunchDevelopment;', {
    projectRoot: '.', npm: 'npm', join, process: { env: {} }, URL, console,
    developmentPreflight: async () => ({ pgBin: '/synthetic/bin', workspaces: ['database', 'server', 'web'].map(name => ({ name: '@flume/' + name, directory: name, scripts: { migrate: name === 'database', dev: true } })) }),
    availablePort: async () => ++port, minimalEnvironment: () => ({}), access: async () => { throw new Error('synthetic first install'); },
    openLocalStore: async () => ({ storageRoot: '.', mediaRoot: '.', databaseUrl: 'postgresql://fixture@127.0.0.1/flume', done: never, stop: async () => {} }),
    waitForHttp: async () => {}, runWorkspaceTask: async () => {},
    managedProcess: async (command, args) => {
      const oneShot = args[0] === 'ci' || args[1] === 'migrate';
      const owner = { done: oneShot ? Promise.resolve({ code: 0 }) : never, stops: 0, stop: async () => { owner.stops++; } };
      (oneShot ? oneShots : services).push(owner); return owner;
    },
  });
  const app = await launch({ root: '.', build: false, apiPort: 0, webPort: 0 });
  assert.equal(oneShots.length, 2);
  assert.deepEqual(oneShots.map(owner => owner.stops), [1, 1], 'one-shot ownership must be drained before startup continues');
  await app.stop();
  assert.deepEqual(oneShots.map(owner => owner.stops), [1, 1], 'completed one-shots must not receive later shutdown calls');
  assert.deepEqual(services.map(owner => owner.stops), [1, 1]);
});
