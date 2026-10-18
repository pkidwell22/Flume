import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createOwnedCluster, cleanEnvironment } from '../test/owned-postgres.mjs';
let cluster, child, interrupted = false;
const stop = signal => { interrupted = true; if (child?.pid) { try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } } };
const onInt = () => stop('SIGINT'), onTerm = () => stop('SIGTERM');
process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
try {
  cluster = await createOwnedCluster();
  if (!interrupted) {
    process.exitCode = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), 'test/worker.test.mjs'], {
        cwd: fileURLToPath(new URL('../', import.meta.url)), detached: true, stdio: 'inherit',
        env: { ...cleanEnvironment(), FLUME_WORKER_TEST_CONFIG: JSON.stringify(cluster.config),
          FLUME_WORKER_TEST_DIRECTORY: cluster.dataDirectory },
      });
      child.once('error', reject); child.once('close', code => { child = undefined; resolve(code ?? 1); });
    });
  }
  if (interrupted) process.exitCode = 1;
} finally {
  try { await cluster?.cleanup(); }
  finally { process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm); }
}
