import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runWorkspaceTask } from './dev-workspaces.mjs';

const exists = path => stat(path).then(() => true, () => false);
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
async function until(check, message) { for (let i = 0; i < 600; i++) { if (await check()) return; await delay(10); } throw new Error(message); }

for (const cancel of [true, false]) test(`inherited-stdio build ${cancel ? 'cancellation' : 'failure without a signal'} awaits its descendant group (process doubles)`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'flume-build-overlap-')); const bin = join(root, 'bin'); await mkdir(bin);
  const workspace = join(root, 'apps/fixture'); await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: '@flume/fixture', scripts: { build: 'never-real-npm' } }));
  const descendant = `const fs=require('node:fs');const root=${JSON.stringify(root)};process.on('SIGTERM',()=>{});fs.writeFileSync(root+'/child.json',JSON.stringify({pid:process.pid}));setInterval(()=>{if(fs.existsSync(root+'/release'))process.exit(0);},10);setTimeout(()=>process.exit(99),5000);`;
  await writeFile(join(bin, 'npm'), `#!${process.execPath}\nconst fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(join(root,'wrapper.json'))},JSON.stringify({pid:process.pid}));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(root, 'fail'))}))process.exit(7);},10);setTimeout(()=>process.exit(99),5000);`, { mode: 0o700 });
  const previousPath = process.env.PATH; process.env.PATH = `${bin}:${previousPath}`;
  const controller = new AbortController(); let pending; let pids = [];
  t.after(async () => {
    controller.abort(); await writeFile(join(root, 'release'), 'release'); await pending?.catch(() => {}); process.env.PATH = previousPath;
    await until(() => pids.every(pid => !alive(pid)), 'fixture cleanup'); await rm(root, { recursive: true, force: true });
    t.diagnostic(JSON.stringify({ root, pids, allDead: pids.every(pid => !alive(pid)), rootRemoved: !(await exists(root)), fakeProcessesOnly: true }));
  });
  pending = runWorkspaceTask(root, 'build', cancel ? { signal: controller.signal } : {});
  let settled = false; pending.then(() => { settled = true; }, () => { settled = true; });
  await until(() => exists(join(root, 'child.json')), 'fake build child started');
  pids = await Promise.all(['wrapper', 'child'].map(async name => JSON.parse(await readFile(join(root, `${name}.json`), 'utf8')).pid));
  if (cancel) controller.abort(); else await writeFile(join(root, 'fail'), 'fail');
  await until(() => !alive(pids[0]), 'wrapper exited'); await delay(80);
  assert.equal(alive(pids[1]), true);
  assert.equal(settled, false, 'build returned with a held SIGTERM-resistant owned descendant still alive');
  await writeFile(join(root, 'release'), 'release');
  await assert.rejects(pending, cancel ? /cancel|abort/i : /failed/);
  await until(() => pids.every(pid => !alive(pid)), 'owned build descendants must exit before fallback');
});
