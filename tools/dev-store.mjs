import { constants } from 'node:fs';
import { mkdir, lstat, readFile, writeFile, readdir, realpath, open, unlink, access } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join, resolve, delimiter } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnOwnedProcess } from './dev-workspaces.mjs';

const exec = promisify(execFile);
const binaries = ['initdb', 'postgres', 'psql'];
export async function resolvePgBin(requested = process.env.PG_BIN) {
  const candidates = requested ? [resolve(requested)] : ['/opt/homebrew/bin', ...(process.env.PATH ?? '').split(delimiter)];
  for (const directory of candidates) {
    try { for (const name of binaries) await access(join(directory, name), constants.X_OK); return directory; } catch { /* Try the next installed path, never install a runtime. */ }
  }
  throw new Error('PostgreSQL binaries are missing; set PG_BIN to an existing installation');
}
export async function availablePort(port = 0) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid loopback port');
  const server = createServer();
  try {
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port, exclusive: true }, resolveListen); });
    return server.address().port;
  } finally { if (server.listening) await new Promise(resolveClose => server.close(resolveClose)); }
}
async function regular(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Local store contains an unsafe file');
  if (process.getuid && info.uid !== process.getuid()) throw new Error('Local store is owned by another user');
  return info;
}
async function directory(path) {
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Local store must not contain symlink directories');
  if (process.getuid && info.uid !== process.getuid()) throw new Error('Local store is owned by another user');
}
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function pgEnvironment(password) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LC_ALL: 'C', ...(password ? { PGPASSWORD: password } : {}) };
}
async function waitExit(closed, milliseconds) {
  let timer;
  try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned PostgreSQL did not stop; store lock retained')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** Persistent, exclusively owned cluster. stop() stops ONLY this child and never deletes data. */
export async function openLocalStore({ root, pgBin: requested, signal } = {}) {
  signal?.throwIfAborted();
  if (!root) throw new Error('An explicit application root is required');
  const pgBin = await resolvePgBin(requested);
  const applicationRoot = await realpath(root);
  const storageRoot = join(applicationRoot, '.flume');
  const dataDir = join(storageRoot, 'postgres');
  const mediaRoot = join(storageRoot, 'media');
  await directory(storageRoot);
  const markerPath = join(storageRoot, 'store.json');
  const lockPath = join(storageRoot, 'store.lock');
  const lockText = JSON.stringify({ pid: process.pid, nonce: randomUUID(), root: applicationRoot });
  let lock;
  try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === 'EEXIST' || error.code === 'ELOOP') throw new Error('Local store is already locked/in use; never remove its lock while the owner is running'); throw error; }
  let postgres; let closed; let stopping; let initializer;
  const stopInitializer = async () => {
    if (!initializer) return;
    await initializer.stop();
    initializer = undefined;
  };
  const stop = ({ retainLock = false } = {}) => stopping ??= (async () => {
    await stopInitializer();
    if (postgres && postgres.exitCode === null && postgres.signalCode === null && postgres.pid) {
      const pidFile = join(dataDir, 'postmaster.pid');
      if (await exists(pidFile)) {
        await regular(pidFile);
        const lines = (await readFile(pidFile, 'utf8')).split('\n');
        if (Number(lines[0]) !== postgres.pid || lines[1] !== dataDir) throw new Error('PostgreSQL ownership changed; refusing to signal a different store');
      }
      postgres.kill('SIGINT'); // Fast PostgreSQL shutdown checkpoints data; not process.kill(-group).
      await waitExit(closed, 15_000);
    }
    if (!retainLock && await exists(lockPath)) {
      await regular(lockPath);
      if (await readFile(lockPath, 'utf8') !== lockText) throw new Error('Store lock ownership changed; refusing to remove it');
      await unlink(lockPath);
    }
  })();
  try {
    await lock.writeFile(lockText); await lock.close(); lock = undefined;
    signal?.throwIfAborted();
    let marker;
    if (await exists(markerPath)) {
      await regular(markerPath); marker = JSON.parse(await readFile(markerPath, 'utf8'));
      if (marker.version !== 1 || marker.root !== applicationRoot || typeof marker.id !== 'string' || !Number.isInteger(marker.port) || marker.port < 1024 || marker.port > 65535) throw new Error('Unrecognized local store ownership marker; refusing to initialize or adopt it');
    } else {
      if ((await readdir(storageRoot)).some(name => name !== 'store.lock')) throw new Error('Refusing to adopt nonempty unowned .flume data');
      marker = { version: 1, id: randomUUID(), root: applicationRoot, port: await availablePort() };
      await writeFile(markerPath, JSON.stringify(marker, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    const passwordPath = join(storageRoot, 'database-password');
    if (!(await exists(passwordPath))) {
      if (await exists(dataDir)) throw new Error('Existing database password is missing; refusing to reset it');
      await writeFile(passwordPath, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
    }
    const passwordInfo = await regular(passwordPath);
    if (passwordInfo.mode & 0o077) throw new Error('Local database password permissions must be 0600');
    const password = await readFile(passwordPath, 'utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(password)) throw new Error('Local database password is invalid; refusing to reset it');
    if (!(await exists(dataDir))) {
      signal?.throwIfAborted();
      let timer; let cancelled;
      try {
        await new Promise((resolveInitialized, rejectInitialized) => {
          initializer = spawnOwnedProcess(join(pgBin, 'initdb'), ['-D', dataDir, '--username=flume', '--auth-local=reject', '--auth-host=scram-sha-256', '--encoding=UTF8', '--locale=C', `--pwfile=${passwordPath}`], { env: pgEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] }, 15_000);
          let bytes = 0;
          for (const stream of [initializer.child.stdout, initializer.child.stderr]) stream.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > 1024 * 1024) rejectInitialized(new Error('Local database initialization exceeded its output limit; data preserved'));
          });
          initializer.exited.then(result => {
            if (result.error || result.code !== 0) rejectInitialized(new Error('Local database initialization failed; data preserved', { cause: result.error }));
            else resolveInitialized();
          });
          timer = setTimeout(() => rejectInitialized(new Error('Local database initialization timed out; data preserved')), 60_000);
          cancelled = () => rejectInitialized(signal.reason);
          signal?.addEventListener('abort', cancelled, { once: true });
          if (signal?.aborted) cancelled();
        });
      } finally { clearTimeout(timer); if (cancelled) signal?.removeEventListener('abort', cancelled); }
      await stopInitializer();
    }
    await directory(dataDir);
    if (!(await exists(join(dataDir, 'PG_VERSION')))) throw new Error('Local database initialization is incomplete; data was preserved for recovery');
    if (await exists(join(dataDir, 'postmaster.pid'))) throw new Error('Existing PostgreSQL PID file found; refusing to adopt or stop an existing server');
    await directory(mediaRoot);
    await availablePort(marker.port);
    signal?.throwIfAborted();
    const log = await open(join(storageRoot, 'postgres.log'), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      postgres = spawn(join(pgBin, 'postgres'), ['-D', dataDir, '-h', '127.0.0.1', '-p', String(marker.port), '-c', 'unix_socket_directories=', '-c', 'max_connections=30', '-c', 'shared_buffers=32MB'], { env: pgEnvironment(), stdio: ['ignore', log.fd, log.fd] });
      closed = new Promise(resolveClosed => { postgres.once('error', () => resolveClosed()); postgres.once('close', () => resolveClosed()); });
    } finally { await log.close(); }
    const query = statement => exec(join(pgBin, 'psql'), ['--no-psqlrc', '--host=127.0.0.1', `--port=${marker.port}`, '--username=flume', '--dbname=postgres', '--no-align', '--tuples-only', '--set', 'ON_ERROR_STOP=1', '--command', statement], { env: pgEnvironment(password), timeout: 3000, maxBuffer: 1024 * 1024 });
    const deadline = Date.now() + 15_000;
    while (true) {
      signal?.throwIfAborted();
      if (postgres.exitCode !== null || postgres.signalCode !== null || !postgres.pid) throw new Error('Owned PostgreSQL failed to start; inspect .flume/postgres.log');
      try { await query('SELECT 1'); break; } catch { if (Date.now() >= deadline) throw new Error('Owned PostgreSQL readiness timed out; inspect .flume/postgres.log'); }
      await delay(50);
    }
    if (!(await query("SELECT 1 FROM pg_database WHERE datname = 'flume'")).stdout.trim()) await query('CREATE DATABASE flume');
    signal?.throwIfAborted();
    return { storageRoot, dataDir, mediaRoot, port: marker.port, pid: postgres.pid, databaseUrl: `postgresql://flume:${password}@127.0.0.1:${marker.port}/flume`, done: closed, stop };
  } catch (error) {
    try { await lock?.close(); } finally { await stop(); }
    throw error;
  }
}
