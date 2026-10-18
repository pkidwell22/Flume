import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnOwnedProcess } from './dev-workspaces.mjs';
const exec = promisify(execFile);
const exists = path => stat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
async function until(check, message) { for (let i = 0; i < 500; i++) { if (await check()) return; await delay(10); } throw new Error(message); }

for (const escalate of [false, true]) test(`real owned group pin ${escalate ? 'self-escalates and settles command exit' : 'outlives natural command exit and awaits inherited-pipe cleanup'}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'lc2-pin-')); const pids = []; let owner;
  t.after(async () => {
    await writeFile(join(root, 'release'), 'release');
    try { await owner?.stop(); } finally {
      await until(() => pids.every(pid => !alive(pid)), 'all exact fixture PIDs must stop');
      await rm(root, { recursive: true, force: true });
      t.diagnostic(JSON.stringify({ root, pids, allDead: pids.every(pid => !alive(pid)), rootRemoved: !(await exists(root)), realOwnedProcesses: true }));
    }
  });
  await writeFile(join(root, 'child.cjs'), `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync('child.pid',String(process.pid));setInterval(()=>{if(fs.existsSync('release'))process.exit(0)},10);setTimeout(()=>process.exit(99),5000);`);
  await writeFile(join(root, 'wrapper.cjs'), `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['child.cjs'],{stdio:'inherit'});process.on('SIGTERM',()=>{});fs.writeFileSync('wrapper.pid',String(process.pid));setInterval(()=>{if(fs.existsSync('release')||fs.existsSync('wrapper-exit'))process.exit(7)},10);setTimeout(()=>process.exit(99),5000);`);
  owner = spawnOwnedProcess(process.execPath, ['wrapper.cjs'], { cwd: root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] }, escalate ? 150 : 1000);
  pids.push(owner.child.pid); owner.child.stdout.resume(); owner.child.stderr.resume();
  await until(() => exists(join(root, 'child.pid')), 'owned descendant started');
  for (const name of ['wrapper', 'child']) pids.push(Number(await readFile(join(root, `${name}.pid`), 'utf8')));
  const group = (await exec('/bin/ps', ['-p', pids.join(','), '-o', 'pid=,pgid='])).stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  assert.equal(group.length, 3);
  assert.ok(group.every(([, pgid]) => pgid === owner.child.pid), 'real command and descendant are in the still-live pin group');
  let closed = false; owner.closed.then(() => { closed = true; });
  if (!escalate) {
    await writeFile(join(root, 'wrapper-exit'), 'exit');
    assert.equal((await owner.exited).code, 7);
    await until(() => !alive(pids[1]), 'wrapper exit is real');
    assert.equal(alive(owner.child.pid), true, 'pin prevents reuse after wrapper exit');
    assert.equal(alive(pids[2]), true); assert.equal(closed, false, 'pipe closure is separate');
  }
  let settled = false; const stopping = owner.stop(); stopping.then(() => { settled = true; }, () => { settled = true; });
  await delay(60); assert.equal(settled, false, 'stop must await the deliberately held descendant');
  if (!escalate) await writeFile(join(root, 'release'), 'release');
  await stopping;
  if (escalate) assert.equal((await owner.exited).signal, 'SIGKILL');
  assert.equal(closed, true, 'stop must await inherited pipe closure');
  await until(() => pids.every(pid => !alive(pid)), 'no running processes before fallback');
  t.diagnostic(JSON.stringify({ scenario: escalate ? 'self-sigkill' : 'live-identity-pin', group, pids, syntheticKernel: false }));
});
