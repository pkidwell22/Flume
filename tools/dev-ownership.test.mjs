import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';

// Adapted independent identity oracles at the new group-pin boundary.
// Every PID, process, IPC event and kill below is SYNTHETIC, not OS PID reuse.
const dev = await readFile(new URL('./dev.mjs', import.meta.url), 'utf8');
const store = await readFile(new URL('./dev-store.mjs', import.meta.url), 'utf8');
const workspace = await readFile(new URL('./dev-workspaces.mjs', import.meta.url), 'utf8');
const text = workspace.slice(workspace.indexOf('function groupAnchor('), workspace.indexOf('function run(')).replace('export function spawnOwnedProcess', 'function spawnOwnedProcess');
const managedText = dev.slice(dev.indexOf('async function managedProcess('), dev.indexOf('async function waitForHttp('));
const ESRCH = () => Object.assign(new Error('synthetic group absent'), { code: 'ESRCH' });
const permission = () => Object.assign(new Error('synthetic permission uncertainty'), { code: 'EPERM' });
function child() {
  return Object.assign(new EventEmitter(), { pid: 424242, connected: true, stdout: new EventEmitter(), stderr: new EventEmitter(), send(message, callback) { callback?.(); } });
}
function harness(c, kill) {
  const context = { process: { platform: 'darwin', execPath: '/synthetic/node', kill, emit() {} }, spawn: (...args) => { assert.equal(args.at(-1).detached, true); return c; }, setTimeout, clearTimeout, delay: () => Promise.resolve(), Error, Promise };
  context.spawnOwnedProcess = runInNewContext(text + '\nspawnOwnedProcess;', context);
  return context;
}
function end(c, kind = 'drained') { c.emit('message', { type: kind }); c.connected = false; c.emit('exit', 0, null); c.emit('close', 0, null); }

for (const boundary of ['managed', 'initializer', 'workspace']) test(`${boundary}: observed ESRCH permanently retires the identity (synthetic kernel)`, async t => {
  const c = child(); const signals = []; let probes = 0; let present = false;
  const context = harness(c, (pid, signal) => {
    if (signal !== 0) signals.push({ pid, signal, identity: present ? 'replacement' : 'absent' });
    probes++;
    if (!present) { present = true; throw ESRCH(); }
  });
  let stop;
  if (boundary === 'managed') {
    const service = await runInNewContext(managedText + '\nmanagedProcess;', context)('fixture', [], {});
    c.emit('message', { type: 'exit', code: 0 }); await service.done; end(c, 'killing');
    stop = service.stop; await stop(); await stop();
  } else if (boundary === 'initializer') {
    const owner = context.spawnOwnedProcess('fixture', [], { stdio: 'pipe' });
    const initializerText = store.slice(store.indexOf('  const stopInitializer ='), store.indexOf('  const stop ='));
    stop = runInNewContext(initializerText + '\nstopInitializer;', { initializer: owner });
    end(c, 'killing'); await stop(); await stop();
  } else {
    const runText = workspace.slice(workspace.indexOf('async function runOwned('), workspace.indexOf('export async function runWorkspaceTask'));
    const run = runInNewContext(runText + '\nrunOwned;', context);
    const controller = new AbortController();
    c.send = (message, callback) => { callback?.(); end(c, 'killing'); };
    const pending = run({ name: 'fixture', directory: '.' }, 'build', false, {}, controller.signal);
    const rejected = assert.rejects(pending, /abort/i); controller.abort(); await rejected;
  }
  t.diagnostic(JSON.stringify({ boundary, probes, signals, syntheticKernel: true }));
  assert.equal(probes, 1, 'ESRCH must never be followed by another existence probe');
  assert.equal(signals.some(item => item.identity === 'replacement'), false, 'an observed vanished identity must never be signalled again');
});

test('unobserved group-pin loss rejects rather than signalling a replacement (synthetic kernel)', async t => {
  const c = child(); const signals = [];
  const context = harness(c, (pid, signal) => { signals.push({ pid, signal, identity: 'replacement' }); });
  const service = await runInNewContext(managedText + '\nmanagedProcess;', context)('fixture', [], {});
  c.emit('message', { type: 'exit', code: 0 }); await service.done;
  c.connected = false; c.emit('exit', 0, null); c.emit('close', 0, null);
  await assert.rejects(service.stop(), /identity.*lost/);
  t.diagnostic(JSON.stringify({ scenario: 'managed-unobserved-reuse', signals, syntheticKernel: true }));
  assert.equal(signals.some(item => item.identity === 'replacement'), false, 'a stored numeric PGID is not a continuing ownership identity');
});

test('close-time ownership uncertainty is retained as stop failure, never a callback throw (synthetic kernel)', async t => {
  const c = child(); const context = harness(c, () => { throw permission(); });
  const owner = context.spawnOwnedProcess('fixture', [], { stdio: 'pipe' });
  let failure;
  try { end(c, 'killing'); } catch (error) { failure = error; }
  assert.equal(failure, undefined, 'close event must not throw past owner cleanup');
  await assert.rejects(owner.stop(), { code: 'EPERM' });
  await assert.rejects(owner.stop(), { code: 'EPERM' });
  t.diagnostic(JSON.stringify({ scenario: 'close-probe-error', retainedCode: 'EPERM', syntheticKernel: true }));
});

test('an earlier probe/signal error is not erased by a later drained notification (synthetic kernel)', async () => {
  const c = child(); const context = harness(c, () => { throw new Error('unexpected parent probe'); });
  const owner = context.spawnOwnedProcess('fixture', [], { stdio: 'pipe' });
  c.emit('message', { type: 'failure', message: 'synthetic permission uncertainty', code: 'EPERM' });
  assert.equal((await owner.exited).error.code, 'EPERM'); end(c);
  await assert.rejects(owner.stop(), { code: 'EPERM' });
});

test('anchor self-signal ESRCH is fail-closed with no later escalation (synthetic kernel)', async () => {
  const process = Object.assign(new EventEmitter(), { pid: 424242, connected: true });
  const messages = []; const signals = []; let resolveDrained;
  const drained = new Promise(resolve => { resolveDrained = resolve; });
  process.send = (message, callback) => { messages.push(message); callback(); if (message.type === 'drained') resolveDrained(); };
  process.exit = () => {};
  process.kill = (pid, signal) => { signals.push({ pid, signal }); throw ESRCH(); };
  const spawn = command => {
    const c = child(); c.pid = 424243; c.stderr.resume = () => {};
    if (command === '/bin/ps') queueMicrotask(() => { c.stdout.emit('data', '424242 S\n424243 R\n'); c.emit('close', 0); });
    return c;
  };
  const anchor = runInNewContext(text + '\ngroupAnchor;', { process, require: () => ({ spawn }), setTimeout, Error, Promise });
  anchor('fixture', [], 0); process.emit('message', { type: 'stop' }); await drained;
  assert.deepEqual(signals, [{ pid: 0, signal: 'SIGTERM' }]);
  assert.equal(messages.find(item => item.type === 'failure').code, 'ESRCH');
  assert.equal(messages.some(item => item.type === 'killing'), false);
});

test('self-escalation settles command-exit notification even when no command message can survive (synthetic kernel)', async () => {
  const c = child(); const context = harness(c, () => { throw ESRCH(); });
  const owner = context.spawnOwnedProcess('fixture', [], { stdio: 'pipe' });
  end(c, 'killing');
  const result = await Promise.race([owner.exited, delay(25).then(() => null)]);
  assert.ok(result, 'anchor death during SIGKILL must unblock command waiters');
  await owner.stop();
});
