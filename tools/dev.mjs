import { constants } from 'node:fs';
import { access, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { availablePort, openLocalStore, resolvePgBin } from './dev-store.mjs';
import { discoverWorkspaces, orderWorkspaces, runWorkspaceTask } from './dev-workspaces.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function minimalEnvironment() {
  const result = { LC_ALL: 'C', NODE_ENV: 'development' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TERM', 'LANG']) if (process.env[key]) result[key] = process.env[key];
  return result;
}
export async function developmentPreflight(root, pgBin) {
  if (process.platform === 'win32') throw new Error('The local PostgreSQL launcher currently requires macOS or Linux');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('Node 22.12 or newer is required');
  const workspaces = orderWorkspaces(await discoverWorkspaces(root));
  for (const name of ['@flume/server', '@flume/web']) if (!workspaces.some(workspace => workspace.name === name && workspace.scripts?.dev)) throw new Error(`Missing integrated ${name} workspace with a dev script`);
  return { workspaces, pgBin: await resolvePgBin(pgBin) };
}

async function managedProcess(command, args, { cwd, env, logPath, redactions = [] }) {
  let log;
  if (logPath) { const fd = await open(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600); log = fd.createWriteStream({ autoClose: true }); log.on('error', () => {}); }
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let finished = false;
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    const write = line => {
      if (!log) return;
      for (const secret of redactions) if (secret) line = line.replaceAll(secret, '[redacted]');
      log.write(line + '\n');
    };
    stream.on('data', chunk => {
      pending += chunk.toString();
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) write(line.length > 16_384 ? '[oversized log line omitted]' : line);
      if (pending.length > 16_384) pending = '[oversized log line omitted]';
    });
    stream.on('end', () => { if (pending) write(pending); });
  }
  const done = new Promise(resolveDone => {
    child.once('error', () => { finished = true; log?.end(() => log.destroy()); resolveDone({ code: null, signal: 'spawn_error' }); });
    child.once('close', (code, signal) => { finished = true; log?.end(() => log.destroy()); resolveDone({ code, signal }); });
  });
  let stopping;
  return { child, done, stop: () => stopping ??= (async () => {
    if (finished || !child.pid) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    let timer;
    try {
      const ended = await Promise.race([done.then(() => true), new Promise(resolveWait => { timer = setTimeout(() => resolveWait(false), 125000); })]);
      if (!ended) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } await done; }
    } finally { clearTimeout(timer); }
  })() };
}
async function waitForHttp(url, service, label, signal) {
  const deadline = Date.now() + 30_000;
  let exited;
  service.done.then(result => { exited = result; });
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (exited) throw new Error(`${label} exited before readiness; inspect .flume/${label}.log`);
    try {
      const timeout = AbortSignal.timeout(500);
      const response = await fetch(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      await response.body?.cancel();
      if (response.ok) return;
    } catch { /* Only retry read-only readiness, never application commands. */ }
    await delay(50, undefined, signal ? { signal } : {});
  }
  throw new Error(`${label} readiness timed out; inspect .flume/${label}.log`);
}

/** One local cluster and owned process groups. No shared services, fixture keys or disposable-store teardown. */
export async function launchDevelopment({ root = projectRoot, pgBin, apiPort = 4311, webPort = 4310, build = true, install = true, signal } = {}) {
  signal?.throwIfAborted();
  const prerequisites = await developmentPreflight(root, pgBin);
  const api = await availablePort(apiPort); const web = await availablePort(webPort);
  if (api === web) throw new Error('API and web ports must differ');
  const apiUrl = `http://127.0.0.1:${api}`; const webUrl = `http://127.0.0.1:${web}`;
  const children = []; let store; let stopping; let resolveDone; let rejectDone; let terminalFailure;
  const done = new Promise((resolveFinished, rejectFinished) => { resolveDone = resolveFinished; rejectDone = rejectFinished; });
  // Attach a handler during acquisition; callers still receive the rejecting promise.
  void done.catch(() => {});
  const stop = () => stopping ??= (async () => {
    signal?.removeEventListener('abort', onAbort);
    const failures = (await Promise.allSettled(children.slice().reverse().map(child => child.stop()))).filter(result => result.status === 'rejected').map(result => result.reason);
    try { await store?.stop(); } catch (error) { failures.push(error); }
    if (failures.length) {
      const error = new AggregateError(failures, 'Some owned services could not stop; data and ownership records were retained');
      rejectDone(error); throw error;
    }
    if (terminalFailure) rejectDone(terminalFailure); else resolveDone();
  })();
  const onAbort = () => { void stop().catch(error => { console.error(error.message); }); };
  const find = name => prerequisites.workspaces.find(workspace => workspace.name === name);
  try {
    if (install) {
      const installed = await access(join(root, 'node_modules')).then(() => true, () => false);
      if (!installed) {
        const installation = await managedProcess(npm, ['ci', '--ignore-scripts'], { cwd: root, env: minimalEnvironment() }); children.push(installation);
        const cancelled = () => { void installation.stop(); }; signal?.addEventListener('abort', cancelled, { once: true });
        try { if ((await installation.done).code !== 0) throw new Error('Project-local npm ci failed; run npm ci to inspect the dependency error'); }
        finally { signal?.removeEventListener('abort', cancelled); }
      }
    }
    signal?.throwIfAborted();
    if (build) await runWorkspaceTask(root, 'build', { signal });
    signal?.throwIfAborted();
    store = await openLocalStore({ root, pgBin: prerequisites.pgBin, signal });
    const serverEnv = {
      ...process.env, ...minimalEnvironment(), DATABASE_URL: store.databaseUrl,
      FLUME_STORAGE_ROOT: store.mediaRoot, FLUME_DATA_DIR: store.storageRoot,
      HOST: '127.0.0.1', PORT: String(api), FLUME_HOST: '127.0.0.1', FLUME_PORT: String(api),
      FLUME_ALLOWED_ORIGIN: webUrl, FLUME_LOCAL_OPERATOR: '1',
    };
    const launch = async (workspace, script, name, env, extra = []) => {
      signal?.throwIfAborted();
      const service = await managedProcess(npm, ['run', script, '--', ...extra], { cwd: workspace.directory, env, logPath: join(store.storageRoot, `${name}.log`), redactions: [store.databaseUrl, new URL(store.databaseUrl).password] });
      children.push(service);
      const cancelled = () => { void service.stop().catch(error => { terminalFailure = error; }); };
      signal?.addEventListener('abort', cancelled, { once: true });
      service.done.then(() => signal?.removeEventListener('abort', cancelled));
      if (signal?.aborted) { await service.stop(); signal.throwIfAborted(); }
      return service;
    };
    const database = find('@flume/database');
    if (database?.scripts?.migrate) {
      const migration = await launch(database, 'migrate', 'migrate', serverEnv);
      const result = await migration.done; signal?.throwIfAborted();
      if (result.code !== 0) throw new Error('Database migration failed; inspect .flume/migrate.log');
    }
    const server = await launch(find('@flume/server'), 'dev', 'server', serverEnv);
    await waitForHttp(`${apiUrl}/api/health`, server, 'server', signal);
    const frontend = await launch(find('@flume/web'), 'dev', 'web', { ...minimalEnvironment(), HOST: '127.0.0.1', PORT: String(web), FLUME_API_URL: apiUrl }, ['--host', '127.0.0.1', '--port', String(web), '--strictPort']);
    await waitForHttp(webUrl, frontend, 'web', signal);
    const worker = find('@flume/worker');
    if (worker?.scripts?.dev) await launch(worker, 'dev', 'worker', serverEnv);
    signal?.throwIfAborted(); signal?.addEventListener('abort', onAbort, { once: true });
    const supervised = [['server', server], ['web', frontend], ['postgres', store], ...(worker?.scripts?.dev ? [['worker', children.at(-1)]] : [])];
    for (const [label, service] of supervised) {
      service.done.then(() => { if (!stopping) { terminalFailure = new Error(`${label} exited unexpectedly; all owned services were stopped`); void stop().catch(() => {}); } });
    }
    return { apiUrl, webUrl, store, stop, done };
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--check') {
      await developmentPreflight(projectRoot); console.log('Product workspaces and installed PostgreSQL are available. No store or service was started.');
    } else if (args.length !== 0) throw new Error('Usage: npm run dev [-- --check]');
    else {
      const app = await launchDevelopment({ signal: controller.signal, apiPort: Number(process.env.FLUME_API_PORT ?? 4311), webPort: Number(process.env.FLUME_WEB_PORT ?? 4310) });
      console.log(`Flume: ${app.webUrl}\nAgent API: ${app.apiUrl}\nLocal operator mode; not production authentication. Data survives shutdown in .flume/.`);
      await app.done;
    }
  } catch (error) { if (!controller.signal.aborted) { console.error(error.message); process.exitCode = 1; } }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
