import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';

const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

// Never inherit a connection string, service file, or PostgreSQL environment.
export function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('PG') && key !== 'DATABASE_URL' && !key.startsWith('SPIKE_')));
}

export async function resolveTempParent(tempParent) {
  const validate = value => {
    assert(value && path.isAbsolute(value), 'set TMPDIR to an owned scratch directory');
    assert(Buffer.byteLength(path.join(value, 'aa-XXXXXX/s/.s.PGSQL.5432')) < 100,
      'socket path too long: use a shorter owned TMPDIR');
    assert(/^[a-zA-Z0-9_./-]+$/.test(value), 'unsafe characters in TMPDIR');
  };
  validate(tempParent);
  const parent = await realpath(tempParent);
  // pg_ctl's -o string uses the canonical path, not the symlink spelling.
  validate(parent);
  assert.equal((await lstat(parent)).uid, process.getuid(), 'TMPDIR must be owned by this user');
  return parent;
}

export async function createOwnedCluster({ tempParent = process.env.TMPDIR } = {}) {
  const parent = await resolveTempParent(tempParent);
  const root = await mkdtemp(path.join(parent, 'aa-'));
  await chmod(root, 0o700);
  const dataDirectory = path.join(root, 'd');
  const socketDirectory = path.join(root, 's');
  const token = randomUUID();
  const database = `attempt_${randomBytes(8).toString('hex')}`;
  const marker = JSON.stringify({ token, root, dataDirectory, uid: process.getuid() });
  const env = cleanEnvironment();
  const bin = process.env.PG_BIN || '/opt/homebrew/bin';
  const run = (name, args) => exec(path.join(bin, name), args, { env, timeout: 30_000 });
  let pid;
  let started = false;
  let cleaned = false;
  const cluster = {
    root, dataDirectory, socketDirectory, database, stopped: false, identity: null,
    config: { host: socketDirectory, port: 5432, user: 'spike_owner', database, ssl: false },
    async cleanup() {
      if (cleaned) return;
      assert.equal(await readFile(path.join(root, '.owner'), 'utf8'), marker, 'ownership marker changed; refusing cleanup');
      assert.equal(await realpath(root), root, 'owned root moved; refusing cleanup');
      assert.equal((await lstat(root)).uid, process.getuid());
      const pidFile = await readFile(path.join(dataDirectory, 'postmaster.pid'), 'utf8')
        .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (pidFile !== null) {
        const lines = pidFile.split('\n');
        assert.equal(lines[1], dataDirectory, 'postmaster belongs to another data directory');
        const currentPid = Number(lines[0]);
        assert(Number.isSafeInteger(currentPid) && currentPid > 1, 'invalid postmaster PID');
        if (pid !== undefined) assert.equal(currentPid, pid, 'postmaster PID changed; refusing stop');
        pid = currentPid;
        assert.equal(await realpath(dataDirectory), dataDirectory, 'data directory moved');
        await run('pg_ctl', ['-D', dataDirectory, '-m', 'fast', '-w', '-t', '20', 'stop']);
      } else if (started) {
        // A test may already have stopped this exact server. Still verify below.
      }
      if (started || pid !== undefined) {
        await assert.rejects(() => run('pg_ctl', ['-D', dataDirectory, 'status']), error => error.code === 3);
        await assert.rejects(() => lstat(path.join(dataDirectory, 'postmaster.pid')), { code: 'ENOENT' });
        assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', 'owned postmaster must be gone');
      }
      cluster.stopped = true;
      await rm(root, { recursive: true });
      await assert.rejects(() => lstat(root), { code: 'ENOENT' });
      cleaned = true;
      console.log('CLEANUP verified: owned postmaster stopped; owned directory removed');
    },
  };
  await writeFile(path.join(root, '.owner'), marker, { mode: 0o600, flag: 'wx' });
  try {
    await mkdir(socketDirectory, { mode: 0o700 });
    await run('initdb', ['-D', dataDirectory, '--username=spike_owner', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8']);
    const options = `-c listen_addresses='' -c unix_socket_directories='${socketDirectory}' -c unix_socket_permissions=0700 -c port=5432 -c max_connections=40`;
    await run('pg_ctl', ['-D', dataDirectory, '-l', path.join(root, 'server.log'), '-o', options, '-w', '-t', '20', 'start']);
    started = true;
    pid = Number((await readFile(path.join(dataDirectory, 'postmaster.pid'), 'utf8')).split('\n')[0]);
    const admin = new pg.Client({ ...cluster.config, database: 'postgres' });
    try {
      await admin.connect();
      const { rows: [identity] } = await admin.query(`select current_database() as database,
        current_setting('data_directory') as "dataDirectory",
        current_setting('listen_addresses') as "listenAddresses",
        current_setting('unix_socket_directories') as "socketDirectory"`);
      assert.equal(identity.database, 'postgres');
      assert.equal(identity.dataDirectory, dataDirectory);
      assert.equal(identity.listenAddresses, '');
      assert.equal(identity.socketDirectory, socketDirectory);
      assert.match(database, /^attempt_[0-9a-f]{16}$/);
      await admin.query(`CREATE DATABASE ${database}`);
    } finally { await admin.end(); }
    const target = new pg.Client(cluster.config);
    try {
      await target.connect();
      const { rows: [identity] } = await target.query(`select current_database() as database,
        current_setting('data_directory') as "dataDirectory",
        current_setting('listen_addresses') as "listenAddresses",
        current_setting('unix_socket_directories') as "socketDirectory"`);
      assert.equal(identity.database, database);
      assert.equal(identity.dataDirectory, dataDirectory);
      cluster.identity = { ...identity, ownerMode: (await lstat(root)).mode & 0o777 };
      console.log('IDENTITY verified:', JSON.stringify(cluster.identity));
    } finally { await target.end(); }
    return cluster;
  } catch (error) {
    await cluster.cleanup();
    throw error;
  }
}

async function runTests() {
  let cluster;
  let child;
  let interrupted = false;
  const onSignal = signal => {
    interrupted = true;
    // The child has its own process group; never signal an inherited group.
    if (child?.pid) {
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const onInt = () => onSignal('SIGINT');
  const onTerm = () => onSignal('SIGTERM');
  // Installed BEFORE initdb/pg_ctl. A signal during setup lets setup settle,
  // then cleans up the owned server rather than abandoning it mid-start.
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  try {
    cluster = await createOwnedCluster();
    const env = { ...cleanEnvironment(), SPIKE_DATABASE: cluster.database,
      SPIKE_DATA_DIRECTORY: cluster.dataDirectory, SPIKE_SOCKET: cluster.socketDirectory };
    for (const args of [['run', 'build'], ['run', 'test:db']]) {
      if (interrupted) break;
      const code = await new Promise((resolve, reject) => {
        child = spawn('npm', args, { cwd: packageRoot, env, stdio: 'inherit', detached: true });
        child.on('error', reject);
        child.on('close', (status, signal) => { child = undefined; resolve(status ?? (signal ? 1 : 0)); });
      });
      if (code !== 0) { process.exitCode = code; break; }
    }
    if (interrupted) process.exitCode = 1;
  } finally {
    try { await cluster?.cleanup(); }
    finally {
      process.removeListener('SIGINT', onInt);
      process.removeListener('SIGTERM', onTerm);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runTests();
}
