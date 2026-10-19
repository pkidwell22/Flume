import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function discoverWorkspaces(root) {
  const result = [];
  for (const group of ['apps', 'packages']) {
    const entries = await readdir(join(root, group), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, group, entry.name);
      const text = await readFile(join(directory, 'package.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (text !== null) result.push({ ...JSON.parse(text), directory });
    }
  }
  return result;
}
export function orderWorkspaces(workspaces) {
  const byName = new Map();
  for (const workspace of workspaces) {
    if (!workspace.name || byName.has(workspace.name)) throw new Error('Missing or duplicate workspace name');
    byName.set(workspace.name, workspace);
  }
  const ordered = []; const visited = new Set(); const active = new Set();
  function visit(workspace) {
    if (active.has(workspace.name)) throw new Error(`Workspace dependency cycle at ${workspace.name}`);
    if (visited.has(workspace.name)) return;
    active.add(workspace.name);
    const dependencies = { ...workspace.dependencies, ...workspace.devDependencies, ...workspace.peerDependencies };
    for (const name of Object.keys(dependencies).sort()) {
      if (byName.has(name)) visit(byName.get(name));
      else if (name.startsWith('@flume/')) throw new Error(`Missing local workspace ${name} required by ${workspace.name}`);
    }
    active.delete(workspace.name); visited.add(workspace.name); ordered.push(workspace);
  }
  for (const workspace of workspaces) visit(workspace);
  return ordered;
}
// A live POSIX group leader pins the identity while the command/descendants exit.
// Only this child signals its own group. The parent never signals a stored PGID.
function groupAnchor(command, args, grace) {
  const { spawn } = require('node:child_process');
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  let stopping = false; let failed = false;
  const send = (message, callback = () => {}) => {
    if (process.connected) process.send(message, error => { if (!error) callback(); });
  };
  const failure = error => { failed = true; send({ type: 'failure', message: error.message, code: error.code }); };
  process.on('SIGTERM', () => { if (!stopping) send({ type: 'cancel' }); });
  const members = () => new Promise((resolveMembers, reject) => {
    // Both macOS and Linux select this detached leader's group/session here.
    const ps = spawn('/bin/ps', ['-g', String(process.pid), '-o', 'pid=,stat='], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; ps.stdout.on('data', chunk => { output += chunk; });
    ps.stderr.resume(); ps.once('error', reject);
    ps.once('close', code => {
      if (code !== 0) return reject(new Error('Cannot confirm owned process-group membership'));
      const rows = output.trim().split('\n').map(line => line.trim().split(/\s+/));
      if (!rows.some(([pid]) => Number(pid) === process.pid) || rows.some(([pid, state]) => !/^\d+$/.test(pid) || !state)) return reject(new Error('Unresolved owned process-group identity'));
      resolveMembers(rows.filter(([pid, state]) => ![process.pid, ps.pid].includes(Number(pid)) && !state.startsWith('Z')));
    });
  });
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      // pid 0 means OUR current group, not a recyclable numeric identity.
      try { process.kill(0, 'SIGTERM'); } catch (error) { failure(error); }
      const deadline = Date.now() + grace;
      while ((await members()).length) {
        if (!failed && Date.now() >= deadline) {
          send({ type: 'killing' }, () => { try { process.kill(0, 'SIGKILL'); } catch (error) { failure(error); } });
          failed = true; // Never retry a signal after an uncertain result.
        }
        await delay(20);
      }
      send({ type: 'drained' }, () => process.exit(0));
      if (!process.connected) process.exit(0);
    } catch (error) { failure(error); }
  };
  process.on('message', message => { if (message?.type === 'stop') void stop(); });
  process.on('disconnect', () => { void stop(); });
  const commandChild = spawn(command, args, { stdio: 'inherit' });
  commandChild.once('error', error => send({ type: 'exit', code: null, signal: 'spawn_error', message: error.message }));
  commandChild.once('exit', (code, signal) => send({ type: 'exit', code, signal }));
}

export function spawnOwnedProcess(command, args, options, grace = 125_000) {
  const child = spawn(process.execPath, ['-e', `(${groupAnchor.toString()})(...JSON.parse(process.argv[1]))`, JSON.stringify([command, args, grace])], { ...options, detached: true, stdio: [...(Array.isArray(options.stdio) ? options.stdio : [options.stdio, options.stdio, options.stdio]), 'ipc'] });
  let failure; let drained = false; let killing = false; let retired = !child.pid; let stopping;
  let resolveExit; let rejectFailure;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const failed = new Promise((_, reject) => { rejectFailure = reject; }); void failed.catch(() => {});
  const fail = error => { failure ??= error; rejectFailure(failure); resolveExit({ code: null, signal: 'ownership_error', error: failure }); };
  const groupExists = () => {
    if (retired) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { if (error.code !== 'ESRCH') throw error; retired = true; return false; }
  };
  child.on('message', message => {
    if (message.type === 'exit') resolveExit(message);
    else if (message.type === 'drained') { drained = true; retired = true; }
    else if (message.type === 'killing') killing = true;
    else if (message.type === 'failure') fail(Object.assign(new Error(message.message), { code: message.code }));
    else if (message.type === 'cancel') process.emit('SIGTERM');
  });
  child.once('error', fail);
  child.once('exit', (code, signal) => {
    // Losing the pin is not permission to signal whatever now has its number.
    if (!drained && !killing) fail(new Error('Owned group identity lost; refusing numeric group signals; ownership records retained'));
    resolveExit({ code: null, signal: signal ?? 'group_exit' });
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  const stop = () => stopping ??= (async () => {
    if (failure) throw failure;
    if (!retired && !killing) {
      if (!child.connected) throw new Error('Owned group identity unresolved; ownership records retained');
      child.send({ type: 'stop' }, error => { if (error) fail(error); });
    }
    let timer;
    try {
      await Promise.race([closed, failed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned process/pipe cleanup unconfirmed; ownership records retained')), grace + 15_000); })]);
      if (failure) throw failure;
      if (!drained) {
        // After self-SIGKILL, only observe absence. Never signal again, even if
        // a replacement occupies the number. Every observed ESRCH is terminal.
        const deadline = Date.now() + 15_000;
        while (groupExists() && Date.now() < deadline) await delay(20);
        if (groupExists()) throw new Error('Owned group termination unconfirmed; ownership records retained');
      }
    } finally { clearTimeout(timer); }
  })();
  return { child, exited, closed, stop };
}

function run(workspace, task, quiet, env, signal) {
  if (process.platform !== 'win32') return runOwned(workspace, task, quiet, env, signal);
  signal?.throwIfAborted();
  // Preserve the existing Windows child-only path; the launcher is POSIX-only.
  return new Promise((resolveRun, reject) => {
    const child = spawn('npm.cmd', ['run', task, '--if-present'], { cwd: workspace.directory, env, detached: false, stdio: quiet ? 'pipe' : 'inherit' });
    let killTimer;
    const kill = kind => { if (!child.pid) return; try { child.kill(kind); } catch (error) { if (error.code !== 'ESRCH') reject(error); } };
    const cancelled = () => { kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 8000); };
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
    let diagnostics = '';
    if (quiet) { child.stdout.on('data', data => { diagnostics = (diagnostics + data).slice(-8000); }); child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-8000); }); }
    child.once('error', reject);
    child.once('close', (code, exitSignal) => {
      clearTimeout(killTimer); signal?.removeEventListener('abort', cancelled);
      if (signal?.aborted) reject(new Error(`${workspace.name} ${task} cancelled`));
      else if (code === 0) resolveRun();
      else reject(new Error(`${workspace.name} ${task} failed (${exitSignal ?? code})${diagnostics ? `\n${diagnostics}` : ''}`));
    });
  });
}
async function runOwned(workspace, task, quiet, env, signal) {
  signal?.throwIfAborted();
  const owner = spawnOwnedProcess('npm', ['run', task, '--if-present'], { cwd: workspace.directory, env, stdio: quiet ? 'pipe' : 'inherit' }, 8000);
  let diagnostics = ''; let cancelled;
  if (quiet) for (const stream of [owner.child.stdout, owner.child.stderr]) stream.on('data', data => { diagnostics = (diagnostics + data).slice(-8000); });
  try {
    const result = await Promise.race([owner.exited, new Promise((_, reject) => {
      cancelled = () => reject(signal.reason);
      signal?.addEventListener('abort', cancelled, { once: true });
      if (signal?.aborted) cancelled();
    })]);
    if (result.error) throw result.error;
    if (result.code !== 0) throw new Error(`${workspace.name} ${task} failed (${result.signal ?? result.code})${diagnostics ? `\n${diagnostics}` : ''}`);
  } finally {
    signal?.removeEventListener('abort', cancelled);
    await owner.stop(); // Command exit is not group/pipe completion.
  }
  signal?.throwIfAborted();
}
export async function runWorkspaceTask(root, task, { quiet = false, signal } = {}) {
  if (!['build', 'typecheck', 'test'].includes(task)) throw new Error('Unsupported workspace task');
  const ordered = orderWorkspaces(await discoverWorkspaces(root));
  if (ordered.length === 0) throw new Error('No product workspaces found');
  const env = task === 'test'
    ? { ...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'PG_BIN', 'FLUME_TEST_SCRATCH_ALLOWED', 'TERM', 'CI'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])), LC_ALL: 'C', NODE_ENV: 'test', npm_config_fund: 'false' }
    : { ...process.env, npm_config_fund: 'false' };
  // Build public exports before consumers/typechecks/tests; npm's lexical workspace order is insufficient.
  for (const workspace of ordered) if (workspace.scripts?.build) await run(workspace, 'build', quiet, env, signal);
  if (task !== 'build') for (const workspace of ordered) if (workspace.scripts?.[task]) await run(workspace, task, quiet, env, signal);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runWorkspaceTask(dirname(dirname(fileURLToPath(import.meta.url))), process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
