import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
assert.ok(existsSync(new URL('specimen/main.tsx', root)), 'The interactive specimen must be delivered');
assert.ok(existsSync(new URL('.evidence/specimen/index.html', root)), 'Run build:specimen first');
const electron = process.env.FLUME_ELECTRON;
assert.ok(electron && existsSync(electron), 'FLUME_ELECTRON must name an existing unpackaged Electron executable; never install one');
const evidence = fileURLToPath(new URL('.evidence/', root));
mkdirSync(evidence, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'flume-ui-witness-'));
const runId = randomUUID();
const child = spawn(electron, [fileURLToPath(new URL('tools/offscreen.cjs', root)), evidence, profile, runId], {
  env: {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LC_ALL: 'C',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (data) => { output += data; process.stdout.write(data); });
child.stderr.on('data', (data) => { output += data; process.stderr.write(data); });
const timeout = setTimeout(() => child.kill('SIGTERM'), 90000);
try {
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  writeFileSync(new URL('.evidence/render-run.txt', root), output);
  assert.equal(code, 0, 'Off-screen UI witness must pass');
  const report = JSON.parse(readFileSync(new URL('.evidence/render-report.json', root), 'utf8'));
  assert.equal(report.runId, runId, 'Report must come from this exact child run');
  assert.equal(report.failure, undefined, 'A zero exit code must not hide a failed UI assertion');
  assert.ok(report.checks.includes('All owned witness windows closed'), 'Owned windows must be closed');
} finally {
  clearTimeout(timeout);
  // Electron may still write its profile until process exit. Only the parent
  // removes the directory it created, after the exact child has terminated.
  rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
