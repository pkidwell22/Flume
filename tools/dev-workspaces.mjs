import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
function run(workspace, task, quiet, env, signal) {
  signal?.throwIfAborted();
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', task, '--if-present'], { cwd: workspace.directory, env, detached: Boolean(signal) && process.platform !== 'win32', stdio: quiet ? 'pipe' : 'inherit' });
    let killTimer;
    const kill = kind => { if (!child.pid) return; try { if (process.platform === 'win32') child.kill(kind); else process.kill(-child.pid, kind); } catch (error) { if (error.code !== 'ESRCH') reject(error); } };
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
